/* 나라장터 키워드 모니터 — 핵심 로직 (화면과 무관한 부분)
 *
 * 공공데이터포털(data.go.kr) 조달청 나라장터 Open API 를 브라우저에서 직접 호출한다.
 * (data.go.kr 은 CORS 를 허용하므로 별도 서버가 필요 없다. 반드시 https 로 호출)
 *   - 입찰공고  ad/BidPublicInfoService      getBidPblancListInfo{구분}PPSSrch  inqryDiv=1(게시일시)
 *   - 사전규격  ao/HrcspSsstndrdInfoService  getPublicPrcureThngInfo{구분}      inqryDiv=1(등록일시)
 *   - 발주계획  ao/OrderPlanSttusService     getOrderPlanSttusList{구분}         inqryDiv=1 필수
 * 오퍼레이션 이름이 바뀌어도 동작하도록 후보 이름을 차례로 시도한다.
 *
 * 브라우저(window.NaraCore)와 Node(require, 테스트용) 양쪽에서 쓴다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NaraCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BASE_URL = "https://apis.data.go.kr/1230000";
  var CATEGORY_SUFFIX = { "용역": "Servc", "물품": "Thng", "공사": "Cnstwk", "외자": "Frgcpt" };
  var CATEGORIES = ["용역", "물품", "공사", "외자"];
  var KIND_LABEL = { bid: "입찰공고", prespec: "사전규격", orderplan: "발주계획" };

  var DEFAULT_SETTINGS = {
    serviceKey: "",
    keywords: ["경영", "전략", "중장기", "조직", "성과", "평가"],
    // 회사 실적 662건과 대조해 충돌이 없는 것만 선별 (2026-11): 실적 중 잘못 제외되는 건 0건
    excludes: ["환경영향평가", "전략환경영향평가", "환경영향", "교통영향평가", "재해영향평가", "건강영향평가",
               "기후변화영향평가", "개인정보영향평가", "지하안전평가", "지하안전영향평가", "해역이용영향평가",
               "문화유산영향평가", "감정평가", "성능평가", "안전성평가", "사면안정성평가", "지반안정성평가",
               "위험성평가", "위해성평가", "유해성평가", "독성평가", "시험평가", "기술가치평가", "자산재평가",
               "신용평가", "학력평가", "학업성취도평가", "평가문항", "측량성과", "성과공유회", "성과보고회",
               "성과발표회", "성과전시회", "조직검사", "조직배양", "인체조직", "산림경영", "경영안정자금", "전략물자"],
    sources: { bid: true, prespec: true, orderplan: true },
    categories: ["용역"],
    firstRunDays: 7,
    keepDays: 60,
    autoFetch: true,
    autoFetchMinutes: 60
  };

  // ───────────────────────── 오류 ─────────────────────────
  var ERROR_HINTS = {
    "01": "조달청 서버 내부 오류입니다. 잠시 후 다시 시도하세요.",
    "02": "조달청 DB 오류입니다. 잠시 후 다시 시도하세요.",
    "04": "HTTP 오류입니다. 잠시 후 다시 시도하세요.",
    "05": "조달청 서버 응답 지연입니다. 잠시 후 다시 시도하세요.",
    "06": "날짜 형식 오류입니다.",
    "07": "조회 기간이 허용 범위를 넘었습니다.",
    "08": "필수 요청값이 빠졌습니다.",
    "10": "요청 값이 잘못됐습니다.",
    "11": "필수 요청 값이 빠졌습니다.",
    "12": "해당 API 기능(오퍼레이션)이 없습니다.",
    "20": "서비스 접근 거부 — 공공데이터포털에서 이 API의 '활용신청'이 승인됐는지 확인하세요.",
    "21": "일시적으로 사용 중지된 서비스키입니다.",
    "22": "오늘 호출 한도를 넘었습니다. 내일 다시 시도하세요.",
    "30": "등록되지 않은 서비스키 — 키 오타 여부와 이 API를 '활용신청'했는지 확인하세요. (신청 직후에는 반영까지 1~2시간 걸릴 수 있습니다)",
    "31": "서비스키 활용기간이 끝났습니다. 공공데이터포털 마이페이지에서 연장 신청하세요.",
    "32": "등록되지 않은 IP 입니다.",
    "99": "알 수 없는 오류입니다."
  };
  var RETRYABLE = { "01": 1, "02": 1, "04": 1, "05": 1, "99": 1 };
  var AUTH_TEXT = {
    SERVICE_KEY_IS_NOT_REGISTERED: "30", SERVICE_ACCESS_DENIED: "20",
    LIMITED_NUMBER_OF_SERVICE_REQUESTS: "22", DEADLINE_HAS_EXPIRED: "31",
    UNREGISTERED_IP: "32", NO_OPENAPI_SERVICE: "12"
  };
  var PARAM_REJECT = { "06": 1, "07": 1, "08": 1, "10": 1, "11": 1 };

  function G2BError(code, detail, httpStatus) {
    this.name = "G2BError";
    this.code = code || "";
    this.detail = String(detail || "").trim();
    this.httpStatus = httpStatus == null ? null : httpStatus;
    this.message = this.describe();
  }
  G2BError.prototype = Object.create(Error.prototype);
  G2BError.prototype.constructor = G2BError;
  G2BError.prototype.hint = function () {
    if (!this.code && this.httpStatus === 0) {
      return "인터넷 연결을 확인하세요. 회사망이라면 보안 정책으로 apis.data.go.kr 접속이 막혀 있을 수 있습니다.";
    }
    return ERROR_HINTS[this.code] || "";
  };
  G2BError.prototype.retryable = function () {
    if (RETRYABLE[this.code]) return true;
    var h = this.httpStatus;
    return h !== null && (h === 0 || h >= 500 || h === 429);
  };
  G2BError.prototype.notFound = function () {
    return this.code === "12" || this.httpStatus === 404 || /not found/i.test(this.detail);
  };
  G2BError.prototype.describe = function () {
    var parts = [];
    if (this.code) parts.push("[코드 " + this.code + "]");
    else if (this.httpStatus) parts.push("[HTTP " + this.httpStatus + "]");
    if (this.detail) parts.push(this.detail);
    var hint = this.hint();
    if (hint) parts.push("→ " + hint);
    return parts.join(" ") || "알 수 없는 오류";
  };

  // ───────────────────────── 응답 해석 ─────────────────────────
  function s(v) { return v == null ? "" : String(v).trim(); }
  function normCode(c) { var t = s(c); return /^\d+$/.test(t) ? (t.length < 2 ? "0" + t : t) : t; }
  function toInt(v) { var n = parseInt(s(v).replace(/,/g, ""), 10); return isNaN(n) ? 0 : n; }

  function normalizeItems(items) {
    if (Array.isArray(items)) return items.filter(isObj);
    if (isObj(items)) {
      var inner = items.item;
      if (Array.isArray(inner)) return inner.filter(isObj);
      if (isObj(inner)) return [inner];
    }
    return [];
  }
  function isObj(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }

  function decodeXml(t) {
    return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }

  function parseXml(t) {
    function grab(tag) {
      var m = t.match(new RegExp("<" + tag + ">\\s*([^<]*?)\\s*</" + tag + ">"));
      return m ? m[1] : "";
    }
    var reason = grab("returnReasonCode");
    if (reason) {
      var rc = normCode(reason);
      if (rc === "00" || rc === "03") return { items: [], total: 0 };
      throw new G2BError(rc, grab("returnAuthMsg") || grab("errMsg"));
    }
    var code = normCode(grab("resultCode"));
    if (code === "03") return { items: [], total: 0 };
    if (code && code !== "00") throw new G2BError(code, grab("resultMsg"));
    if (!code) throw new G2BError("", "해석할 수 없는 XML 응답: " + t.slice(0, 200));
    var items = [], re = /<item>([\s\S]*?)<\/item>/g, m;
    while ((m = re.exec(t))) {
      var o = {}, fre = /<(\w+)>([\s\S]*?)<\/\1>/g, f;
      while ((f = fre.exec(m[1]))) o[f[1]] = decodeXml(f[2].trim());
      items.push(o);
    }
    return { items: items, total: toInt(grab("totalCount")) };
  }

  /** API 응답 본문 → {items, total}. 오류면 G2BError. */
  function parseResponse(text) {
    var t = s(text).replace(/^﻿/, "");
    if (!t) throw new G2BError("", "빈 응답");
    if (t.charAt(0) === "<") return parseXml(t);
    var data;
    try { data = JSON.parse(t); } catch (e) {
      for (var mk in AUTH_TEXT) if (t.indexOf(mk) >= 0) throw new G2BError(AUTH_TEXT[mk], mk);
      throw new G2BError("", "해석할 수 없는 응답: " + t.slice(0, 200));
    }
    if (!isObj(data)) throw new G2BError("", "예상하지 못한 응답 형식: " + t.slice(0, 200));
    for (var k in data) {
      if (k.indexOf("ResponseError") >= 0 && isObj(data[k])) {
        var h = data[k].header || data[k];
        throw new G2BError(normCode(h.resultCode), h.resultMsg || "");
      }
    }
    var resp = isObj(data.response) ? data.response : data;
    var header = resp.header || {};
    var code = normCode(header.resultCode);
    if (code === "03") return { items: [], total: 0 };
    if (code && code !== "00") throw new G2BError(code, header.resultMsg || "");
    if (!code && !("body" in resp)) throw new G2BError("", s(data.message || data.resultMsg) || t.slice(0, 200));
    var body = resp.body;
    if (!isObj(body)) return { items: [], total: 0 };
    return { items: normalizeItems(body.items), total: toInt(body.totalCount) };
  }

  // ───────────────────────── 한국시간 도우미 ─────────────────────────
  // 모든 시각은 Date(절대 시각)로 다루고, 표시·API 용 문자열만 한국시간(UTC+9)으로 만든다.
  var KST = 9 * 3600e3, DAY = 864e5;
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function kst(d) {
    var x = new Date(d.getTime() + KST);
    return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), wd: x.getUTCDay() };
  }
  function apiDt(d) { var k = kst(d); return "" + k.y + p2(k.mo) + p2(k.d) + p2(k.h) + p2(k.mi); }
  function fmtKst(d) { var k = kst(d); return k.y + "-" + p2(k.mo) + "-" + p2(k.d) + " " + p2(k.h) + ":" + p2(k.mi); }
  function kstMidnight(d) { var k = kst(d); return new Date(Date.UTC(k.y, k.mo - 1, k.d) - KST); }
  function addDays(d, n) { return new Date(d.getTime() + n * DAY); }
  function ymAdd(d, months) {
    var k = kst(d), m = k.mo - 1 + months, y = k.y + Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return "" + y + p2(m + 1);
  }
  /** 'YYYY-MM-DD HH:MM' 또는 'YYYY-MM-DD' (한국시간) → Date */
  function parseKst(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(s(str));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0) - KST);
  }

  /** 조회 기간: days 지정 > 마지막 조회 전날 0시 > 첫 조회 기본값. 최대 31일. */
  function computeWindow(now, lastRun, firstRunDays, days) {
    var start;
    if (days) start = addDays(kstMidnight(now), -(Math.max(days, 1) - 1));
    else if (lastRun) start = addDays(kstMidnight(lastRun), -1);
    else start = addDays(kstMidnight(now), -(Math.max(firstRunDays || 7, 1) - 1));
    var floor = addDays(kstMidnight(now), -31);
    if (start < floor) start = floor;
    return { start: start, end: now };
  }

  function dateChunks(start, end, days) {
    if (!days) return [[start, end]];
    var out = [], cur = start;
    while (cur < end) {
      var nxt = new Date(Math.min(cur.getTime() + days * DAY, end.getTime()));
      out.push([cur, nxt]);
      cur = nxt;
    }
    return out.length ? out : [[start, end]];
  }

  // ───────────────────────── 항목 정리 ─────────────────────────
  function first(raw) {
    for (var i = 1; i < arguments.length; i++) { var v = s(raw[arguments[i]]); if (v) return v; }
    return "";
  }
  function toAmount(v) {
    var t = s(v).replace(/,/g, "");
    if (!t) return null;
    var n = Math.floor(parseFloat(t));
    return isFinite(n) && n > 0 ? n : null;
  }
  /** '2026-11-10 10:23:45' / '202611101023' → '2026-11-10 10:23' (시간 없으면 날짜만) */
  function normDt(v) {
    var d = s(v).replace(/\D/g, "");
    if (d.length < 8) return "";
    var date = d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8);
    return d.length >= 12 ? date + " " + d.slice(8, 10) + ":" + d.slice(10, 12) : date;
  }
  function splitList(v) {
    var out = [];
    s(v).split(/[,\s]+/).forEach(function (x) {
      x = x.replace(/^[\["']+|[\]"']+$/g, "");
      if (x && out.indexOf(x) < 0) out.push(x);
    });
    return out;
  }
  function phoneJoin(name, tel) { return [name, tel ? "(" + tel + ")" : ""].filter(Boolean).join(" "); }
  function fmtWon(n) { return n ? n.toLocaleString("ko-KR") + "원" : ""; }

  function makeItem(kind, category, kw) {
    var base = {
      kind: kind, kind_label: KIND_LABEL[kind], category: category,
      id: "", no: "", title: "", agency: "", demand: "", posted: "", deadline: "", deadline_label: "",
      amount: null, amount_label: "", order_ym: "", url: "", files: [], details: {}
    };
    for (var k in kw) base[k] = kw[k];
    var det = {};
    for (var dk in base.details) if (s(base.details[dk])) det[dk] = s(base.details[dk]);
    base.details = det;
    return base;
  }

  function normalizeBid(raw, category) {
    var no = s(raw.bidNtceNo), ord = s(raw.bidNtceOrd) || "000";
    var presmpt = toAmount(raw.presmptPrce), budget = toAmount(raw.asignBdgtAmt);
    var files = [];
    for (var i = 1; i <= 10; i++) {
      var u = s(raw["ntceSpecDocUrl" + i]);
      if (/^https?:\/\//.test(u)) files.push({ name: s(raw["ntceSpecFileNm" + i]) || "첨부파일 " + i, url: u });
    }
    return makeItem("bid", category, {
      id: "bid:" + no + "-" + ord, no: no + "-" + ord,
      title: first(raw, "bidNtceNm"),
      agency: first(raw, "ntceInsttNm"), demand: first(raw, "dminsttNm"),
      posted: normDt(raw.bidNtceDt || raw.rgstDt),
      deadline: normDt(raw.bidClseDt), deadline_label: "입찰마감",
      amount: presmpt || budget, amount_label: presmpt ? "추정가격" : (budget ? "배정예산" : ""),
      url: first(raw, "bidNtceDtlUrl", "bidNtceUrl"), files: files,
      details: {
        "공고번호": no + "-" + ord,
        "공고종류": first(raw, "ntceKindNm"),
        "계약방법": first(raw, "cntrctCnclsMthdNm"),
        "낙찰방법": first(raw, "sucsfbidMthdNm"),
        "개찰일시": normDt(raw.opengDt),
        "배정예산": budget && presmpt ? fmtWon(budget) : "",
        "담당자": phoneJoin(first(raw, "ntceInsttOfclNm"), first(raw, "ntceInsttOfclTelNo"))
      }
    });
  }

  function normalizePrespec(raw, category) {
    var no = first(raw, "bfSpecRgstNo"), files = [];
    for (var i = 1; i <= 5; i++) {
      var u = s(raw["specDocFileUrl" + i]);
      if (/^https?:\/\//.test(u)) files.push({ name: s(raw["specDocFileNm" + i]) || "규격문서 " + i, url: u });
    }
    var days = s(raw.dlvrDaynum);
    return makeItem("prespec", category, {
      id: "prespec:" + (no || first(raw, "refNo")), no: no,
      title: first(raw, "prdctClsfcNoNm", "bizNm"),
      agency: first(raw, "orderInsttNm"), demand: first(raw, "rlDminsttNm"),
      posted: normDt(raw.rcptDt || raw.rgstDt),
      deadline: normDt(raw.opninRgstClseDt), deadline_label: "의견마감",
      amount: toAmount(raw.asignBdgtAmt), amount_label: "배정예산", files: files,
      details: {
        "사전규격번호": no,
        "참조번호": first(raw, "refNo"),
        "업무구분": first(raw, "bsnsDivNm"),
        "납품기한": normDt(raw.dlvrTmlmtDt) || (days ? days + "일" : ""),
        "관련 입찰공고": splitList(raw.bidNtceNoList).join(", "),
        "담당자": phoneJoin(first(raw, "ofclNm"), first(raw, "ofclTelNo"))
      }
    });
  }

  function orderYm(year, month) {
    var y = s(year).replace(/\D/g, ""), m = s(month).replace(/\D/g, "");
    if (m.length >= 6) { y = m.slice(0, 4); m = m.slice(4, 6); }
    var mi = parseInt(m, 10);
    return (y.length === 4 && mi >= 1 && mi <= 12) ? y + "-" + p2(mi) : "";
  }

  function hashStr(t) { // 짧은 안정 해시 (번호가 없는 발주계획용)
    var h = 2166136261;
    for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }

  function normalizeOrderplan(raw, category) {
    var no = first(raw, "orderPlanUntyNo");
    var title = first(raw, "bizNm", "prdctClsfcNoNm");
    var agency = first(raw, "orderInsttNm", "totlmngInsttNm");
    if (!no) {
      var parts = [s(raw.orderInsttCd), s(raw.orderYear), s(raw.orderPlanSno)];
      no = parts.every(Boolean) ? parts.join("-") : "h" + hashStr(agency + "|" + title + "|" + s(raw.orderYear));
    }
    var ym = orderYm(raw.orderYear, raw.orderMnth), tot = first(raw, "totlmngInsttNm");
    return makeItem("orderplan", category, {
      id: "orderplan:" + no, no: no, title: title, agency: agency,
      demand: tot !== agency ? tot : "",
      posted: normDt(raw.nticeDt || raw.chgDt),
      amount: toAmount(raw.sumOrderAmt) || toAmount(raw.orderContrctAmt), amount_label: "발주금액",
      order_ym: ym,
      details: {
        "발주계획번호": no,
        "발주예정": ym ? ym.slice(0, 4) + "년 " + parseInt(ym.slice(5), 10) + "월" : "",
        "계약방법": first(raw, "cntrctMthdNm"),
        "조달방식": first(raw, "prcrmntMethd"),
        "담당부서": first(raw, "deptNm"),
        "담당자": phoneJoin(first(raw, "ofclNm"), first(raw, "telNo")),
        "용도·내용": first(raw, "usgCntnts", "specCntnts").slice(0, 300),
        "관련 입찰공고": splitList(raw.bidNtceNoList).join(", ")
      }
    });
  }

  // ───────────────────────── 조회 대상 정의 ─────────────────────────
  function dtParams(a, b) { return { inqryDiv: "1", inqryBgnDt: apiDt(a), inqryEndDt: apiDt(b) }; }
  var SOURCES = {
    bid: {
      key: "bid", label: KIND_LABEL.bid, service: "ad/BidPublicInfoService",
      ops: function (x) { return ["getBidPblancListInfo" + x + "PPSSrch", "getBidPblancListInfo" + x]; },
      variants: function (a, b) { return [dtParams(a, b)]; },
      normalize: normalizeBid, chunkDays: 7, localDateFilter: false
    },
    prespec: {
      key: "prespec", label: KIND_LABEL.prespec, service: "ao/HrcspSsstndrdInfoService",
      ops: function (x) { return ["getPublicPrcureThngInfo" + x, "getPublicPrcureThngInfo" + x + "PPSSrch"]; },
      variants: function (a, b) { return [dtParams(a, b)]; },
      normalize: normalizePrespec, chunkDays: 7, localDateFilter: false
    },
    orderplan: {
      key: "orderplan", label: KIND_LABEL.orderplan, service: "ao/OrderPlanSttusService",
      ops: function (x) { return ["getOrderPlanSttusList" + x, "getOrderPlanSttusList" + x + "PPSSrch"]; },
      // 1순위: 게시일시 + 넓은 발주년월. 범위 초과 등으로 거부되면 2순위(이번 달)로 다시 시도.
      variants: function (a, b) {
        var p1 = dtParams(a, b), p2_ = dtParams(a, b);
        p1.orderBgnYm = ymAdd(b, -3); p1.orderEndYm = ymAdd(b, 9);
        p2_.orderBgnYm = ymAdd(b, 0); p2_.orderEndYm = ymAdd(b, 0);
        return [p1, p2_];
      },
      normalize: normalizeOrderplan, chunkDays: null, localDateFilter: true
    }
  };

  // ───────────────────────── 키워드 판정 ─────────────────────────
  function squash(t) { return s(t).replace(/\s+/g, "").toLowerCase(); }
  function uniq(arr) { var o = []; (arr || []).forEach(function (x) { x = s(x); if (x && o.indexOf(x) < 0) o.push(x); }); return o; }

  /** 제외어는 '그 부분을 지운 뒤에도 키워드가 남는지'로 판단한다.
   *  예) 키워드 '경영', 제외어 '환경영향' → "사후환경영향조사"는 제외, "중장기 경영전략 및 환경영향평가"는 수집 */
  function Matcher(keywords, excludes) {
    this.keywords = uniq(keywords);
    this.excludes = uniq(excludes);
    this.kw = this.keywords.map(function (k) { return [k, squash(k)]; }).filter(function (x) { return x[1]; });
    this.ex = this.excludes.map(function (k) { return [k, squash(k)]; }).filter(function (x) { return x[1]; })
      .sort(function (a, b) { return b[1].length - a[1].length; });
  }
  Matcher.prototype.hits = function (t) {
    return this.kw.filter(function (x) { return t.indexOf(x[1]) >= 0; }).map(function (x) { return x[0]; });
  };
  Matcher.prototype.match = function (title) {
    var t = squash(title), hits = this.hits(t);
    if (!hits.length) return { matched: [], excluded: [] };
    var stripped = t, found = [];
    this.ex.forEach(function (x) {
      if (stripped.indexOf(x[1]) >= 0) { found.push(x[0]); stripped = stripped.split(x[1]).join("|"); }
    });
    if (!found.length) return { matched: hits, excluded: [] };
    var remaining = this.hits(stripped);
    return remaining.length ? { matched: remaining, excluded: [] } : { matched: hits, excluded: found };
  };

  function cleanWords(list) {
    var out = [];
    (list || []).forEach(function (w) {
      w = s(w).replace(/\s+/g, " ");
      if (w && w.length <= 40 && out.indexOf(w) < 0) out.push(w);
    });
    return out;
  }

  // ───────────────────────── API 호출 ─────────────────────────
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function Client(serviceKey, opts) {
    opts = opts || {};
    var key = s(serviceKey);
    if (/%[0-9A-Fa-f]{2}/.test(key)) { try { key = decodeURIComponent(key); } catch (e) { /* 그대로 */ } }
    this.key = key;
    this.rows = opts.rows || 500;
    this.maxPages = opts.maxPages || 100;
    this.retries = opts.retries == null ? 3 : opts.retries;
    this.pause = opts.pause == null ? 150 : opts.pause;
    this.timeout = opts.timeout || 40000;
    this.fetchImpl = opts.fetchImpl || function (u, o) { return fetch(u, o); };
    this.sleep = opts.sleep || sleep;
    this.calls = 0;
    this.working = {};   // 이번 세션에 통한 (오퍼레이션, 파라미터) 조합 기억
  }

  Client.prototype.callOnce = function (url, params) {
    var self = this, qs = new URLSearchParams();
    Object.keys(params).forEach(function (k) { qs.append(k, String(params[k])); });
    self.calls++;
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, self.timeout) : null;
    var status = 0;
    return Promise.resolve()
      .then(function () { return self.fetchImpl(url + "?" + qs.toString(), ctrl ? { signal: ctrl.signal } : {}); })
      .then(function (resp) { status = resp.status; return resp.text().then(function (t) { return [resp, t]; }); },
            function (e) {
              throw new G2BError("", e && e.name === "AbortError" ? "응답 시간 초과" : "연결 실패 (" + (e && e.message || e) + ")", 0);
            })
      .then(function (pair) {
        if (timer) clearTimeout(timer);
        var resp = pair[0], text = pair[1];
        if (!resp.ok) {
          try { parseResponse(text); } catch (e) {
            if (e instanceof G2BError) { if (e.httpStatus == null) e.httpStatus = status; throw e; }
          }
          throw new G2BError("", "HTTP " + status, status);
        }
        return parseResponse(text);
      }, function (e) {
        if (timer) clearTimeout(timer);
        if (e instanceof G2BError) throw e;
        throw new G2BError("", "응답 읽기 실패 (" + (e && e.message || e) + ")", 0);
      });
  };

  Client.prototype.call = function (url, params) {
    var self = this, attempt = 0, delay = 2000;
    function go() {
      attempt++;
      return self.callOnce(url, params).catch(function (e) {
        if (!(e instanceof G2BError) || !e.retryable() || attempt >= self.retries) throw e;
        return self.sleep(delay).then(function () { delay *= 2; return go(); });
      });
    }
    return go();
  };

  /** 페이지를 넘기며 전체 item 을 모은다. */
  Client.prototype.fetchAll = function (service, op, params) {
    var self = this, url = BASE_URL + "/" + service + "/" + op, out = [], page = 1;
    function next() {
      var q = { serviceKey: self.key, type: "json", pageNo: page, numOfRows: self.rows };
      for (var k in params) q[k] = params[k];
      return self.call(url, q).then(function (r) {
        out = out.concat(r.items);
        if (!r.items.length || out.length >= r.total || page >= self.maxPages) return out;
        page++;
        return self.sleep(self.pause).then(next);
      });
    }
    return next();
  };

  /** 한 소스·한 업무구분·한 기간: 오퍼레이션 후보와 파라미터 대안을 차례로 시도 */
  function fetchWithFallback(client, src, sfx, a, b) {
    var ops = src.ops(sfx), variants = src.variants(a, b), combos = [];
    ops.forEach(function (op) { variants.forEach(function (_, vi) { combos.push([op, vi]); }); });
    var mem = client.working[src.key + sfx];
    if (mem) {
      combos = combos.filter(function (c) { return !(c[0] === mem[0] && c[1] === mem[1]); });
      combos.unshift(mem);
    }
    var skip = {}, lastErr = null, i = 0;
    function tryNext() {
      while (i < combos.length && skip[combos[i][0]]) i++;
      if (i >= combos.length) return Promise.reject(lastErr || new G2BError("", "알 수 없는 오류"));
      var c = combos[i++];
      return client.fetchAll(src.service, c[0], variants[c[1]]).then(function (items) {
        client.working[src.key + sfx] = c;
        return items;
      }, function (e) {
        if (!(e instanceof G2BError)) throw e;
        lastErr = e;
        if (e.notFound()) { skip[c[0]] = 1; return tryNext(); }
        if (PARAM_REJECT[e.code]) return tryNext();
        throw e;
      });
    }
    return tryNext();
  }

  function fetchSource(client, src, category, start, end) {
    var sfx = CATEGORY_SUFFIX[category], chunks = dateChunks(start, end, src.chunkDays), all = [];
    return chunks.reduce(function (p, ch) {
      return p.then(function () { return fetchWithFallback(client, src, sfx, ch[0], ch[1]); })
        .then(function (items) { all = all.concat(items); });
    }, Promise.resolve()).then(function () { return all; });
  }

  /** 설정에 따라 전체 조회 → 키워드에 맞는 항목만 반환 */
  function collect(client, settings, start, end, onProgress) {
    var matcher = new Matcher(settings.keywords, settings.excludes);
    var found = {}, errors = [], stats = {};
    var jobs = [];
    Object.keys(SOURCES).forEach(function (key) {
      if (!settings.sources[key]) return;
      settings.categories.forEach(function (cat) { jobs.push([SOURCES[key], cat]); });
    });
    var done = 0;
    return jobs.reduce(function (p, job) {
      return p.then(function () {
        var src = job[0], cat = job[1];
        var st = stats[src.key] = stats[src.key] || { label: src.label, fetched: 0, matched: 0, error: false };
        if (onProgress) onProgress({ label: src.label, category: cat, done: done, total: jobs.length });
        return fetchSource(client, src, cat, start, end).then(function (raws) {
          raws.forEach(function (raw) {
            var item = src.normalize(raw, cat);
            if (!item.title) return;
            if (src.localDateFilter) {
              var dt = parseKst(item.posted);
              if (dt && dt < start) return;
            }
            st.fetched++;
            var r = matcher.match(item.title);
            if (!r.matched.length) return;
            item.matched = r.matched; item.excluded = r.excluded;
            if (!found[item.id]) st.matched++;
            found[item.id] = item;
          });
        }, function (e) {
          st.error = true;
          errors.push(src.label + "(" + cat + ") 조회 실패: " + (e && e.message || e));
        }).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      return { items: Object.keys(found).map(function (k) { return found[k]; }), errors: errors, stats: stats };
    });
  }

  /** 연결 점검: 각 API 에 1건만 요청해 활용신청·키 상태 확인 */
  function checkConnection(client, settings, now) {
    var cat = settings.categories[0] || "용역", start = addDays(kstMidnight(now), -1), results = [];
    var oldRows = client.rows, oldMax = client.maxPages, oldRetries = client.retries;
    client.rows = 1; client.maxPages = 1; client.retries = 1;
    return Object.keys(SOURCES).reduce(function (p, key) {
      return p.then(function () {
        var src = SOURCES[key], ops = src.ops(CATEGORY_SUFFIX[cat]), params = src.variants(start, now)[0], i = 0;
        function attempt() {
          var op = ops[i++];
          var q = { serviceKey: client.key, type: "json", pageNo: 1, numOfRows: 1 };
          for (var k in params) q[k] = params[k];
          return client.call(BASE_URL + "/" + src.service + "/" + op, q).then(function (r) {
            results.push({ key: key, label: src.label, ok: true, total: r.total, op: op });
          }, function (e) {
            if (e instanceof G2BError && e.notFound() && i < ops.length) return attempt();
            results.push({ key: key, label: src.label, ok: false, error: e && e.message || String(e) });
          });
        }
        return attempt();
      });
    }, Promise.resolve()).then(function () {
      client.rows = oldRows; client.maxPages = oldMax; client.retries = oldRetries;
      return results;
    });
  }

  return {
    BASE_URL: BASE_URL, CATEGORIES: CATEGORIES, CATEGORY_SUFFIX: CATEGORY_SUFFIX, KIND_LABEL: KIND_LABEL,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, SOURCES: SOURCES,
    G2BError: G2BError, parseResponse: parseResponse,
    kst: kst, apiDt: apiDt, fmtKst: fmtKst, parseKst: parseKst, kstMidnight: kstMidnight, addDays: addDays,
    ymAdd: ymAdd, computeWindow: computeWindow, dateChunks: dateChunks,
    normDt: normDt, toAmount: toAmount, normalizeBid: normalizeBid, normalizePrespec: normalizePrespec,
    normalizeOrderplan: normalizeOrderplan,
    Matcher: Matcher, cleanWords: cleanWords, squash: squash,
    Client: Client, collect: collect, checkConnection: checkConnection
  };
});
