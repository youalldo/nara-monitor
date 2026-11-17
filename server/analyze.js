#!/usr/bin/env node
/* 나라장터 공고문 자동 AI 분석 — GitHub Actions 에서 평일 하루 몇 번 실행
 *
 *  1) analysis-config.json 의 키워드로 최근 입찰공고·사전규격을 조회
 *  2) 참가자격(업종·지역·금액) 판정 — '참가 불가'는 건너뛰고, '1억 미만'은 예외 공고를 찾기 위해 분석
 *  3) 첨부파일(공고문·제안요청서·과업지시서)을 내려받아 글자 추출 (HWP·HWPX·DOCX·ZIP 안 파일), PDF 는 그대로
 *  4) Claude 로 검토양식 칸 채우기 → data/reviews.json 에 저장 (웹앱이 읽어서 표시)
 *
 * 필요한 환경변수(저장소 Secrets): G2B_SERVICE_KEY, ANTHROPIC_API_KEY
 */
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("../js/core.js");
const D = require("../js/docread.js");
const AI = require("../js/ai.js");
const { CFB } = require("../vendor/xlsx-0.18.5.full.min.js");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "analysis-config.json");
const DATA_PATH = path.join(ROOT, "data", "reviews.json");

const LIMITS = {
  fileBytes: 30 * 1024 * 1024,   // 파일 하나
  pdfBytes: 15 * 1024 * 1024,    // 한 공고에 보낼 PDF 합계 (API 요청 32MB 한도 고려)
  textChars: 300000,             // 한 공고에 보낼 글자 합계
  files: 6,                      // 한 공고에서 내려받을 파일 수
  keepDays: 120,                 // 기록 보관 기간
  runs: 60                       // 실행 기록 보관 건수
};
const UA = "Mozilla/5.0 (compatible; nara-monitor/1.3)";

const DEFAULT_CONFIG = {
  keywords: C.DEFAULT_SETTINGS.keywords,
  excludes: C.DEFAULT_SETTINGS.excludes,
  categories: ["용역"],
  sources: { bid: true, prespec: true },
  company: C.DEFAULT_SETTINGS.company,
  analyzeSmall: true,
  maxAnalysesPerRun: 10,
  maxAttempts: 3,
  firstRunDays: 3
};

// ───────── 설정·기록 ─────────
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }

function loadConfig(p) {
  const raw = readJson(p) || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  cfg.company = Object.assign({}, DEFAULT_CONFIG.company, raw.company || {});
  cfg.sources = Object.assign({}, DEFAULT_CONFIG.sources, raw.sources || {});
  cfg.keywords = C.cleanWords(cfg.keywords);
  cfg.excludes = C.cleanWords(cfg.excludes);
  if (!cfg.keywords.length) throw new Error("analysis-config.json 의 keywords 가 비어 있습니다");
  cfg.maxAnalysesPerRun = Math.max(0, Math.min(50, parseInt(cfg.maxAnalysesPerRun, 10) || 0));
  return cfg;
}
function publicConfig(cfg) {   // 웹앱에 보여 줄 설정 (비밀값 없음)
  const out = {};
  ["keywords", "excludes", "categories", "sources", "company", "analyzeSmall", "maxAnalysesPerRun"].forEach((k) => { out[k] = cfg[k]; });
  return out;
}
function loadData(p) {
  const d = readJson(p) || {};
  return { version: 1, updatedAt: d.updatedAt || null, lastRun: d.lastRun || null, config: d.config || null, items: d.items || {}, runs: d.runs || [] };
}
function saveData(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

// ───────── 첨부파일 ─────────
/** 파일 이름으로 우선순위: 2=공고문·제안요청서·과업지시서, 1=기타, 0=제출 서식류(제외) */
function fileScore(name) {
  const n = String(name || "").replace(/\s+/g, "");
  if (/제안요청|RFP|과업지시|과업내용|과업설명|규격서|공고문|입찰공고|표준공고|사업계획|평가기준|평가방법|지침/i.test(n)) return 2;
  if (/서식|양식|별지|서약|확인서|위임장|신청서|명세서|견적|산출내역|청렴|각서|동의서|체크리스트|사업자등록/.test(n)) return 0;
  return 1;
}

async function attachmentsFor(item, client) {
  const list = [];
  const add = (name, url, src) => {
    url = String(url || "").trim();
    if (!/^https?:\/\//i.test(url) || list.some((f) => f.url === url)) return;
    list.push({ name: String(name || "").trim() || "첨부파일", url, src });
  };
  if (item.kind === "bid") {   // e발주 첨부(제안요청서 등) — 공고 첨부보다 먼저
    const no = String(item.no).split("-")[0];
    try {
      const r = await client.call(C.BASE_URL + "/ad/BidPublicInfoService/getBidPblancListInfoEorderAtchFileInfo",
        { serviceKey: client.key, type: "json", pageNo: 1, numOfRows: 50, inqryDiv: "2", bidNtceNo: no });
      r.items.forEach((it) => add(it.eorderAtchFileNm, it.eorderAtchFileUrl, it.eorderDocDivNm || "e발주"));
    } catch (e) { /* e발주 첨부가 없거나 조회 실패 → 공고 첨부만 사용 */ }
  }
  (item.files || []).forEach((f) => add(f.name, f.url, "공고 첨부"));
  list.forEach((f) => { f.score = Math.max(fileScore(f.name), /제안요청|과업/.test(f.src) ? 2 : 0); });
  const useful = list.filter((f) => f.score > 0);
  return (useful.length ? useful : list).sort((a, b) => b.score - a.score);
}

function contentName(cd) {
  if (!cd) return "";
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch (e) { /* 무시 */ } }
  m = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch (e) { return m[1].trim(); } }
  return "";
}

async function download(f, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(f.url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(90000) });
  } catch (e) { throw new Error("내려받기 연결 실패 (" + (e && e.message || e) + ")"); }
  if (!res.ok) throw new Error("내려받기 실패 HTTP " + res.status);
  const len = +(res.headers.get("content-length") || 0);
  if (len > LIMITS.fileBytes) throw new Error("파일이 너무 큼 (" + Math.round(len / 1048576) + "MB)");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > LIMITS.fileBytes) throw new Error("파일이 너무 큼 (" + Math.round(buf.length / 1048576) + "MB)");
  const head = Buffer.from(buf.subarray(0, 256)).toString("latin1").toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html")) throw new Error("파일 대신 웹페이지가 왔습니다 (접속 제한 가능성)");
  const cdName = contentName(res.headers.get("content-disposition"));
  const hasExt = (n) => /\.[a-z0-9]{2,5}$/i.test(n);
  return { buf, name: hasExt(f.name) ? f.name : (cdName || f.name) };
}

/** 내려받은 파일 → 분석용 문서 목록 (ZIP 은 안의 문서들을 꺼낸다) */
async function extract(name, buf) {
  if (/\.zip$/i.test(name)) {
    const z = D.unzip(buf), out = [];
    for (const n of z.names) {
      if (/\/$/.test(n) || !/\.(hwp|hwpx|pdf|docx|txt)$/i.test(n)) continue;
      const inner = await z.read(n);
      try { out.push(...await extract(name + " › " + n.split("/").pop(), inner)); } catch (e) { /* 읽지 못한 파일은 건너뜀 */ }
    }
    if (!out.length) throw new Error("압축 파일 안에 읽을 수 있는 문서가 없습니다");
    return out;
  }
  return [await D.readFile(name, buf, CFB)];
}

async function gatherDocs(item, client, fetchImpl) {
  const files = await attachmentsFor(item, client), docs = [], report = [];
  let chars = 0, pdf = 0, tried = 0;
  for (const f of files) {
    if (tried >= LIMITS.files) { report.push({ name: f.name, status: "skip", note: "파일 수 한도로 생략" }); continue; }
    tried++;
    try {
      const got = await download(f, fetchImpl);
      for (const d of await extract(got.name, got.buf)) {
        if (d.kind === "pdf" && pdf + d.size > LIMITS.pdfBytes) { report.push({ name: d.name, status: "skip", note: "PDF 용량 한도로 생략" }); continue; }
        if (d.text && chars + d.chars > LIMITS.textChars) { report.push({ name: d.name, status: "skip", note: "글자 수 한도로 생략" }); continue; }
        docs.push(d); chars += d.chars || 0; pdf += d.kind === "pdf" ? d.size : 0;
        report.push({ name: d.name, status: "ok", note: d.kind === "pdf" ? "PDF " + Math.max(1, Math.round(d.size / 1024)) + "KB" : "글자 " + d.chars + "자" });
      }
    } catch (e) {
      report.push({ name: f.name, status: "error", note: (e && e.message) || String(e) });
    }
  }
  if (!files.length) report.push({ name: "-", status: "error", note: "첨부파일 정보가 없습니다" });
  return { docs, report };
}

// ───────── 한 공고 분석 ─────────
async function analyzeOne(item, ctx) {
  const prev = ctx.data.items[item.id] || {};
  const entry = { item, status: "error", attempts: (prev.attempts || 0) + 1, checkedAt: ctx.now.toISOString() };
  try {
    const { docs, report } = await gatherDocs(item, ctx.client, ctx.fetchImpl);
    entry.files = report;
    if (!docs.length) {
      entry.status = "nofiles";
      entry.error = "분석할 문서를 받지 못했습니다: " + report.map((r) => r.name + "(" + r.note + ")").join(", ");
      return entry;
    }
    const r = await AI.analyze({ Anthropic: ctx.Anthropic, apiKey: ctx.aiKey, docs, item, company: ctx.cfg.company });
    entry.status = "done";
    entry.review = Object.assign({}, r.result, {
      analyzedAt: ctx.now.toISOString(), files: docs.map((d) => d.name), usage: r.usage, model: r.model, source: "server"
    });
    delete entry.error;
  } catch (e) {
    entry.status = "error";
    entry.error = (e && e.message) || String(e);
  }
  return entry;
}

function isClosed(item, now) {
  if (item.kind !== "bid" || !item.deadline) return false;
  const d = C.parseKst(item.deadline);
  return d ? d < now : false;
}

// ───────── 전체 실행 ─────────
async function run(opts) {
  const env = opts.env, now = opts.now || new Date(), log = opts.log || console.log;
  const fetchImpl = opts.fetchImpl || ((u, o) => fetch(u, o));
  const cfg = loadConfig(opts.configPath || CONFIG_PATH);
  const dataPath = opts.dataPath || DATA_PATH;
  const data = loadData(dataPath);
  const g2bKey = (env.G2B_SERVICE_KEY || "").trim(), aiKey = (env.ANTHROPIC_API_KEY || "").trim();
  if (!g2bKey) throw new Error("G2B_SERVICE_KEY 가 없습니다. 저장소 Settings → Secrets and variables → Actions 에 등록하세요.");
  if (!aiKey) throw new Error("ANTHROPIC_API_KEY 가 없습니다. 저장소 Settings → Secrets and variables → Actions 에 등록하세요.");

  const client = new C.Client(g2bKey, { fetchImpl, sleep: opts.sleep });
  const ctx = { cfg, data, client, fetchImpl, Anthropic: opts.Anthropic, aiKey, now };
  const w = C.computeWindow(now, data.lastRun ? new Date(data.lastRun) : null, cfg.firstRunDays);
  log("조회기간 " + C.fmtKst(w.start) + " ~ " + C.fmtKst(w.end) + " | 키워드 " + cfg.keywords.join(", "));

  const settings = { keywords: cfg.keywords, excludes: cfg.excludes, categories: cfg.categories,
                     sources: { bid: !!cfg.sources.bid, prespec: !!cfg.sources.prespec, orderplan: false } };
  const col = await C.collect(client, settings, w.start, w.end, (p) => log("· " + p.label + "(" + p.category + ") 조회 중"));
  col.errors.forEach((e) => log("  ! " + e));

  // 분석 후보: 새로 찾은 공고 + 지난번에 미뤘거나 실패한 공고(재시도 한도 안)
  const cand = new Map();
  for (const it of col.items) {
    if (it.excluded.length || isClosed(it, now)) continue;
    const prev = data.items[it.id];
    if (prev && (prev.status === "done" || prev.status === "skipped")) continue;
    if (prev && (prev.attempts || 0) >= cfg.maxAttempts) continue;
    cand.set(it.id, Object.assign({}, it, { limits: (prev && prev.item && prev.item.limits) || it.limits }));
  }
  for (const [id, e] of Object.entries(data.items)) {
    if (cand.has(id) || !e.item || isClosed(e.item, now)) continue;
    if ((e.status === "pending" || e.status === "error" || e.status === "nofiles") && (e.attempts || 0) < cfg.maxAttempts) cand.set(id, e.item);
  }

  // 참가자격 판정 (입찰공고는 업종·지역 제한 조회)
  const queue = [], summary = { collected: col.items.length, candidates: cand.size, analyzed: 0, failed: 0, skipped: 0, pending: 0, cost: 0 };
  for (const it of cand.values()) {
    if (it.kind === "bid" && !(it.limits && it.limits.ok)) it.limits = await C.fetchBidLimits(client, it);
    const ev = C.assess(it, cfg.company);
    if (ev.level === "no" || (ev.level === "small" && !cfg.analyzeSmall)) {
      data.items[it.id] = { item: it, status: "skipped", reason: ev.label + " — " + ev.reasons.join(" / "), checkedAt: now.toISOString() };
      summary.skipped++;
      continue;
    }
    queue.push({ it, rank: ev.level === "small" ? 1 : 0 });
  }
  // 1억 이상(참가 가능·확인 필요) 먼저, 마감이 가까운 순
  queue.sort((a, b) => a.rank - b.rank || String(a.it.deadline || "9").localeCompare(String(b.it.deadline || "9")));

  const todo = queue.slice(0, cfg.maxAnalysesPerRun);
  for (const q of queue.slice(cfg.maxAnalysesPerRun)) {
    const prev = data.items[q.it.id] || {};
    data.items[q.it.id] = { item: q.it, status: "pending", attempts: prev.attempts || 0, checkedAt: now.toISOString(), note: "실행당 분석 한도로 다음 실행에 분석" };
    summary.pending++;
  }
  for (const q of todo) {
    log("▶ 분석: " + q.it.title + " (" + q.it.no + ")");
    const entry = await analyzeOne(q.it, ctx);
    data.items[q.it.id] = entry;
    if (entry.status === "done") {
      summary.analyzed++; summary.cost += entry.review.usage.cost;
      log("  ✓ " + entry.review.small_business_rule + " / 참가 " + entry.review.midsize_eligible + " · $" + entry.review.usage.cost.toFixed(2));
    } else {
      summary.failed++;
      log("  ✕ " + entry.error);
    }
    data.updatedAt = new Date().toISOString();
    saveData(dataPath, data);   // 한 건마다 저장 (중간에 멈춰도 결과 보존)
  }

  // 오래된 기록 정리, 실행 기록 남기기
  const cutoff = new Date(now.getTime() - LIMITS.keepDays * 864e5).toISOString();
  for (const [id, e] of Object.entries(data.items)) {
    const t = (e.review && e.review.analyzedAt) || e.checkedAt || "";
    if (t < cutoff) delete data.items[id];
  }
  if (!col.errors.length) data.lastRun = now.toISOString();   // 조회가 일부 실패하면 같은 기간을 다음에 다시 조회
  data.config = publicConfig(cfg);
  data.updatedAt = new Date().toISOString();
  const failures = Object.values(data.items).filter((e) => e.status === "nofiles" || e.status === "error").slice(0, 5).map((e) => e.error);
  data.runs.unshift({ at: now.toISOString(), window: [w.start.toISOString(), w.end.toISOString()], ...summary,
                      cost: Math.round(summary.cost * 100) / 100, errors: col.errors.concat(summary.failed ? failures : []).slice(0, 8) });
  data.runs = data.runs.slice(0, LIMITS.runs);
  saveData(dataPath, data);
  log("완료: 조회 " + summary.collected + "건 · 분석 " + summary.analyzed + "건 · 실패 " + summary.failed + "건 · 건너뜀 " + summary.skipped +
      "건 · 다음으로 미룸 " + summary.pending + "건 · 비용 약 $" + summary.cost.toFixed(2));
  return { summary, collectErrors: col.errors };
}

module.exports = { run, fileScore, attachmentsFor, gatherDocs, extract, contentName, loadConfig, LIMITS };

if (require.main === module) {
  const Anthropic = require("@anthropic-ai/sdk");
  run({ env: process.env, Anthropic: Anthropic.default || Anthropic }).then((r) => {
    // 나라장터 조회가 전부 실패한 경우만 실패로 표시 (GitHub 이 메일로 알려 줌)
    const all = r.collectErrors.length && r.summary.collected === 0 && r.collectErrors.length >= 2;
    process.exitCode = all ? 1 : 0;
  }, (e) => {
    console.error("[오류] " + ((e && e.message) || e));
    process.exitCode = 1;
  });
}
