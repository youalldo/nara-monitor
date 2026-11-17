// 서버 자동 분석(server/analyze.js) — 나라장터·첨부파일·Claude 를 모두 가짜로 바꿔 전체 흐름 시험
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const S = require("../server/analyze.js");

function zip(files, { cp949Names = false } = {}) {
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nm = cp949Names ? Buffer.from(name.replace("제안요청서", "\xc1\xa6\xbe\xc8\xbf\xe4\xc3\xbb\xbc\xad"), "latin1") : Buffer.from(name);
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content), data = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(cp949Names ? 0 : 0x800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const hwpx = (text) => zip({ "mimetype": "application/hwp+zip", "Contents/section0.xml": `<s><hp:p><hp:t>${text}</hp:t></hp:p></s>` });

const NOW = new Date("2026-11-17T01:00:00Z");   // 한국시간 11/17 10:00
const kst = (h) => { const d = new Date(NOW.getTime() - h * 3600e3 + 9 * 3600e3); return d.toISOString().slice(0, 16).replace("T", " ") + ":00"; };
const FUT = "2026-11-28 10:00:00";
const B = (n, nm, prc, extra) => Object.assign({ bidNtceNo: "R26BK0000000" + n, bidNtceOrd: "000", bidNtceNm: nm, ntceInsttNm: "조달청", dminsttNm: "가상기관" + n,
  bidNtceDt: kst(n), bidClseDt: FUT, presmptPrce: String(prc) }, extra || {});
const BIDS = [
  B(1, "중장기 경영전략 수립 연구용역", 181818182, { ntceSpecDocUrl1: "https://files.test/1/notice", ntceSpecFileNm1: "입찰공고문.hwpx", ntceSpecDocUrl2: "https://files.test/1/form", ntceSpecFileNm2: "제출서식.hwpx" }),
  B(2, "조직문화 진단 컨설팅", 60000000, { ntceSpecDocUrl1: "https://files.test/2/bundle", ntceSpecFileNm1: "공고첨부.zip" }),
  B(3, "경영평가 대응 컨설팅", 150000000, { ntceSpecDocUrl1: "https://files.test/3/x", ntceSpecFileNm1: "공고문.hwpx" }),
  B(4, "성과관리 체계 고도화", 130000000, { ntceSpecDocUrl1: "https://files.test/4/blocked", ntceSpecFileNm1: "공고문.pdf" }),
  B(5, "전략 로드맵 수립", 120000000, { ntceSpecDocUrl1: "https://files.test/5/notice", ntceSpecFileNm1: "공고문.pdf" }),
  B(6, "소규모 환경영향평가 용역", 200000000),                       // 제외어
  B(7, "중장기 발전전략(마감 지남)", 150000000, { bidClseDt: "2026-11-01 10:00:00" }),
];
const LIC = { R26BK00000003: ["엔지니어링사업/1144"] };
const EORDER = { R26BK00000001: [{ eorderAtchFileNm: "제안요청서.hwpx", eorderAtchFileUrl: "https://files.test/1/rfp", eorderDocDivNm: "제안요청서" }] };
const ok = (items) => JSON.stringify({ response: { header: { resultCode: "00" }, body: { items, totalCount: items.length } } });
const NODATA = JSON.stringify({ response: { header: { resultCode: "03" } } });

function makeFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url), op = u.pathname.split("/").pop(), p = Object.fromEntries(u.searchParams);
    const resp = (status, body, headers = {}) => ({ ok: status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null },
      text: async () => String(body), arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
    if (u.host === "apis.data.go.kr") {
      if (op === "getBidPblancListInfoServcPPSSrch") return resp(200, ok(BIDS));
      if (op === "getPublicPrcureThngInfoServc") return resp(200, ok([{ bfSpecRgstNo: "R26BD00000009", prdctClsfcNoNm: "조직진단 컨설팅", orderInsttNm: "가상공사", asignBdgtAmt: "165000000", rcptDt: kst(2), opninRgstClseDt: FUT, specDocFileUrl1: "https://files.test/pre/spec" }]));
      if (op === "getBidPblancListInfoLicenseLimit") { const l = LIC[p.bidNtceNo] || ["학술연구용역/1169"]; return resp(200, ok(l.map((x) => ({ lcnsLmtNm: x })))); }
      if (op === "getBidPblancListInfoPrtcptPsblRgn") return resp(200, NODATA);
      if (op === "getBidPblancListInfoEorderAtchFileInfo") { const e = EORDER[p.bidNtceNo]; return resp(200, e ? ok(e) : NODATA); }
      return resp(404, "API not found");
    }
    const f = u.pathname;
    if (f === "/1/rfp") return resp(200, hwpx("제안요청서: 평가 정량20 기술70 가격10"));
    if (f === "/1/notice") return resp(200, hwpx("입찰공고문: 중소기업·소상공인 확인서 소지자"));
    if (f === "/1/form") return resp(200, hwpx("서식"));
    if (f === "/2/bundle") return resp(200, zip({ "제안요청서.hwpx": hwpx("1억 미만이지만 중소기업 확인서 소지자 참가 가능"), "readme.png": "x" }, { cp949Names: true }));
    if (f === "/4/blocked") return resp(200, "<!DOCTYPE html><html>로그인</html>", { "content-type": "text/html" });
    if (f === "/5/notice") return resp(200, Buffer.from("%PDF-1.4 공고문"), { "content-disposition": "attachment; filename*=UTF-8''%EA%B3%B5%EA%B3%A0%EB%AC%B8.pdf" });
    if (f === "/pre/spec") return resp(200, hwpx("사전규격 규격서"));
    return resp(404, "not found");
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeAnthropic(log) {
  return class FakeAnthropic {
    constructor(o) { this.key = o.apiKey; this.beta = { messages: { stream: (params) => {
      log.push(params);
      const text = params.messages[0].content.map((c) => c.text || "").join("");
      const small = /1억 미만이지만/.test(text);
      const out = { notice_no: "", title: "t", client: "c", budget_vat_included: null, estimated_price: null, period: "5개월", submission: "전자",
        deadlines: "", eligibility: "중소기업·소상공인 확인서", evaluation_ratio: "정량평가(20) 기술평가(70) 가격평가(10)", quantitative: "수행실적(10)",
        scope: "진단", notes: "", small_business_rule: "중소기업 참가(중기업 가능)", small_business_evidence: small ? "중소기업 확인서 소지자 참가 가능" : "중소기업·소상공인 확인서 소지자",
        midsize_eligible: "가능", check_points: "실적 확인" };
      return { finalMessage: async () => ({ stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 30000, output_tokens: 2000 } }) };
    } } }; }
  };
}

function setup(cfgOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nara-srv-"));
  const cfg = Object.assign(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "analysis-config.json"), "utf8")), cfgOverride || {});
  fs.writeFileSync(path.join(dir, "cfg.json"), JSON.stringify(cfg));
  return { dir, configPath: path.join(dir, "cfg.json"), dataPath: path.join(dir, "reviews.json") };
}
const env = { G2B_SERVICE_KEY: "K", ANTHROPIC_API_KEY: "A" };
const quiet = () => {};

test("첨부파일 우선순위·이름 해석", () => {
  assert.equal(S.fileScore("제안요청서(최종).hwp"), 2);
  assert.equal(S.fileScore("입찰공고문.hwp"), 2);
  assert.equal(S.fileScore("제안서 제출 서식.hwp"), 0);
  assert.equal(S.fileScore("청렴계약이행서약서.hwp"), 0);
  assert.equal(S.fileScore("붙임1.hwp"), 1);
  assert.equal(S.contentName("attachment; filename*=UTF-8''%EA%B3%B5%EA%B3%A0.pdf"), "공고.pdf");
  assert.equal(S.contentName('attachment; filename="a.hwp"'), "a.hwp");
});

test("전체 흐름: 조회 → 참가자격 → 첨부 → AI → reviews.json", async () => {
  const t = setup({ maxAnalysesPerRun: 10 }), ai = [], fetchImpl = makeFetch();
  const r = await S.run({ env, now: NOW, fetchImpl, Anthropic: makeAnthropic(ai), configPath: t.configPath, dataPath: t.dataPath, log: quiet, sleep: async () => {} });
  const d = JSON.parse(fs.readFileSync(t.dataPath, "utf8"));
  const st = Object.fromEntries(Object.entries(d.items).map(([k, v]) => [k, v.status]));
  assert.deepEqual(st, {
    "bid:R26BK00000003-000": "skipped",      // 업종 미보유 → 참가 불가
    "bid:R26BK00000001-000": "done",
    "bid:R26BK00000004-000": "nofiles",      // 첨부 대신 웹페이지
    "bid:R26BK00000005-000": "done",
    "prespec:R26BD00000009": "done",
    "bid:R26BK00000002-000": "done",         // 1억 미만도 분석 (예외 공고 찾기)
  });
  assert.ok(!("bid:R26BK00000006-000" in d.items), "제외어 공고는 분석 안 함");
  assert.ok(!("bid:R26BK00000007-000" in d.items), "마감 지난 공고는 분석 안 함");
  // 1번: e발주 제안요청서가 먼저, 제출서식은 제외
  const e1 = d.items["bid:R26BK00000001-000"];
  assert.deepEqual(e1.files.map((f) => f.name), ["제안요청서.hwpx", "입찰공고문.hwpx"]);
  assert.deepEqual(e1.review.files, ["제안요청서.hwpx", "입찰공고문.hwpx"]);
  assert.equal(e1.review.source, "server");
  // 2번: CP949 이름의 ZIP 안 문서
  assert.equal(d.items["bid:R26BK00000002-000"].review.files[0], "공고첨부.zip › 제안요청서.hwpx");
  // 4번: 실패 사유 기록
  assert.match(d.items["bid:R26BK00000004-000"].error, /웹페이지/);
  // 5번: PDF 는 문서 블록으로
  const pdfReq = ai.find((p) => p.messages[0].content.some((c) => c.type === "document"));
  assert.equal(pdfReq.messages[0].content[0].source.media_type, "application/pdf");
  assert.equal(pdfReq.model, "claude-opus-5-5");
  assert.equal(pdfReq.output_config.format.type, "json_schema");
  // 순서: 1억 이상 먼저, 1억 미만(2번)은 마지막
  assert.match(ai[ai.length - 1].messages[0].content.at(-1).text, /조직문화 진단 컨설팅/);
  assert.equal(r.summary.analyzed, 4); assert.equal(r.summary.skipped, 1); assert.equal(r.summary.failed, 1);
  assert.equal(d.runs[0].analyzed, 4); assert.equal(d.runs[0].cost, Math.round(4 * (30000 * 4 + 2000 * 20) / 1e6 * 100) / 100);
  assert.equal(d.lastRun, NOW.toISOString());
  assert.deepEqual(d.config.keywords.slice(0, 2), ["경영", "전략"]);
  // 두 번째 실행: 끝난 공고는 다시 분석하지 않고, 실패(4번)만 재시도
  const ai2 = [];
  const r2 = await S.run({ env, now: new Date(NOW.getTime() + 3 * 3600e3), fetchImpl: makeFetch(), Anthropic: makeAnthropic(ai2), configPath: t.configPath, dataPath: t.dataPath, log: quiet, sleep: async () => {} });
  assert.equal(ai2.length, 0); assert.equal(r2.summary.failed, 1);
  assert.equal(JSON.parse(fs.readFileSync(t.dataPath, "utf8")).items["bid:R26BK00000004-000"].attempts, 2);
});

test("실행당 분석 한도: 넘친 공고는 다음 실행에 분석", async () => {
  const t = setup({ maxAnalysesPerRun: 2 }), ai = [];
  const r = await S.run({ env, now: NOW, fetchImpl: makeFetch(), Anthropic: makeAnthropic(ai), configPath: t.configPath, dataPath: t.dataPath, log: quiet, sleep: async () => {} });
  assert.equal(r.summary.analyzed + r.summary.failed, 2); assert.equal(r.summary.pending, 3);
  const r2 = await S.run({ env, now: new Date(NOW.getTime() + 864e5 * 5), fetchImpl: makeFetch(), Anthropic: makeAnthropic(ai), configPath: t.configPath, dataPath: t.dataPath, log: quiet, sleep: async () => {} });
  assert.ok(r2.summary.analyzed + r2.summary.failed >= 2, "미룬 공고를 조회기간과 상관없이 이어서 분석");
});

test("1억 미만 분석 끄기·비밀값 없음", async () => {
  const t = setup({ analyzeSmall: false }), ai = [];
  await S.run({ env, now: NOW, fetchImpl: makeFetch(), Anthropic: makeAnthropic(ai), configPath: t.configPath, dataPath: t.dataPath, log: quiet, sleep: async () => {} });
  const d = JSON.parse(fs.readFileSync(t.dataPath, "utf8"));
  assert.equal(d.items["bid:R26BK00000002-000"].status, "skipped");
  await assert.rejects(S.run({ env: { G2B_SERVICE_KEY: "K" }, now: NOW, fetchImpl: makeFetch(), Anthropic: makeAnthropic([]), configPath: t.configPath, dataPath: t.dataPath, log: quiet }), /ANTHROPIC_API_KEY/);
});
