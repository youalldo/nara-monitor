// 실행: node --test tests/core.test.js   (네트워크 불필요 — 가짜 API 응답 사용)
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/core.js");

const NOW = new Date("2026-11-09T22:30:00Z"); // 한국시간 2026-11-10 07:30
const ok = (items, total) => JSON.stringify({ response: { header: { resultCode: "00", resultMsg: "정상" },
  body: { items, numOfRows: 2, pageNo: 1, totalCount: total == null ? items.length : total } } });
const GATEWAY_XML = "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>" +
  "<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>" +
  "</cmmMsgHeader></OpenAPI_ServiceResponse>";

const BIDS = [
  { bidNtceNo: "R26BK00000001", bidNtceOrd: "000", bidNtceNm: "2027~2031 중장기 경영 전략 수립 연구용역",
    ntceInsttNm: "가상시", dminsttNm: "가상시 기획과", bidNtceDt: "2026-11-09 10:12:00",
    bidClseDt: "2026-11-20 10:00:00", presmptPrce: "181818182", asignBdgtAmt: "200000000",
    bidNtceDtlUrl: "https://www.g2b.go.kr/link/x?bidPbancNo=R26BK00000001", ntceKindNm: "등록공고",
    ntceSpecDocUrl1: "https://example.invalid/f1", ntceSpecFileNm1: "제안요청서.hwp" },
  { bidNtceNo: "R26BK00000002", bidNtceOrd: "000", bidNtceNm: "○○로 도로 포장 설계 용역", bidNtceDt: "2026-11-09 11:00:00" },
  { bidNtceNo: "R26BK00000003", bidNtceOrd: "001", bidNtceNm: "소규모 환경영향평가 용역", bidNtceDt: "2026-11-09 12:00:00" },
];
const PRESPEC_ONE = { item: { bfSpecRgstNo: "R26BD00000009", prdctClsfcNoNm: "조직진단 및 인력운영 효율화 컨설팅",
  orderInsttNm: "가상공사", asignBdgtAmt: "50000000", rcptDt: "2026-11-09 15:00:00", opninRgstClseDt: "2026-11-14 18:00:00",
  specDocFileUrl1: "https://example.invalid/s1", ofclNm: "홍길동", ofclTelNo: "02-000-0000" } };
const PLANS = [
  { orderPlanUntyNo: "R26DD00000001", bizNm: "성과평가 체계 개선 용역", orderInsttNm: "가상재단",
    orderYear: "2027", orderMnth: "3", sumOrderAmt: "70000000", nticeDt: "2026-11-09 09:00:00" },
  { orderPlanUntyNo: "R26DD00000002", bizNm: "경영 컨설팅(오래된 계획)", orderInsttNm: "가상재단",
    orderYear: "2026", orderMnth: "02", nticeDt: "2026-01-05 09:00:00" },
];

function fakeFetch(handler) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url); const op = u.pathname.split("/").pop();
    const params = Object.fromEntries(u.searchParams);
    calls.push({ op, params });
    const [status, body] = handler(op, params);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  f.calls = calls;
  return f;
}
const normalHandler = (op, p) => {
  const page = +p.pageNo, rows = +p.numOfRows;
  if (op === "getBidPblancListInfoServcPPSSrch") return [200, ok(BIDS.slice((page - 1) * rows, page * rows), BIDS.length)];
  if (op === "getPublicPrcureThngInfoServc") return [200, JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: PRESPEC_ONE, totalCount: "1" } } })];
  if (op === "getOrderPlanSttusListServc") return [404, "API not found"];
  if (op === "getOrderPlanSttusListServcPPSSrch") return [200, ok(PLANS)];
  return [404, "API not found"];
};
const noSleep = () => Promise.resolve();

test("응답 형태 해석", () => {
  assert.equal(C.parseResponse(ok([{ a: 1 }, { a: 2 }])).total, 2);
  assert.deepEqual(C.parseResponse(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: { a: 1 } }, totalCount: 1 } } })), { items: [{ a: 1 }], total: 1 });
  assert.deepEqual(C.parseResponse(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: "", totalCount: 0 } } })), { items: [], total: 0 });
  assert.deepEqual(C.parseResponse(JSON.stringify({ response: { header: { resultCode: "03", resultMsg: "NODATA_ERROR" } } })), { items: [], total: 0 });
  const xml = "<response><header><resultCode>00</resultCode></header><body><items><item><bidNtceNm>A &amp; B</bidNtceNm></item></items><totalCount>1</totalCount></body></response>";
  assert.deepEqual(C.parseResponse(xml), { items: [{ bidNtceNm: "A & B" }], total: 1 });
});

test("오류 해석과 안내문", () => {
  assert.throws(() => C.parseResponse(GATEWAY_XML), (e) => e.code === "30" && /활용신청/.test(e.message));
  const err = JSON.stringify({ "nkoneps.com.response.ResponseError": { header: { resultCode: "07", resultMsg: "입력범위값 초과 에러" } } });
  assert.throws(() => C.parseResponse(err), (e) => e.code === "07" && !e.notFound());
  assert.equal(new C.Client("ab%2Bcd%3D%3D").key, "ab+cd==");
});

test("키워드·제외어 판정", () => {
  const m = new C.Matcher(["경영", "전략", "중장기", "평가"], ["환경영향", "환경영향평가", "전략환경영향평가", "감정평가"]);
  assert.deepEqual(m.match("중장 기 경영전략").matched, ["경영", "전략", "중장기"]);
  assert.deepEqual(m.match("소규모 환경영향 평가 용역"), { matched: ["경영", "평가"], excluded: ["환경영향평가"] });
  assert.deepEqual(m.match("사후환경영향조사"), { matched: ["경영"], excluded: ["환경영향"] });
  assert.deepEqual(m.match("OO지구 전략환경영향평가").excluded, ["전략환경영향평가"]);
  assert.deepEqual(m.match("중장기 발전전략 및 전략환경영향평가"), { matched: ["전략", "중장기"], excluded: [] });
  assert.deepEqual(m.match("기관 경영평가 및 자산 감정평가"), { matched: ["경영", "평가"], excluded: [] });
  assert.deepEqual(m.match("도로 포장"), { matched: [], excluded: [] });
});

test("조회 기간 (한국시간)", () => {
  assert.equal(C.apiDt(NOW), "202611100730");
  let w = C.computeWindow(NOW, null, 7);
  assert.equal(C.fmtKst(w.start), "2026-11-04 00:00");
  w = C.computeWindow(NOW, C.parseKst("2026-11-06 07:30"), 7); // 금 → 월
  assert.equal(C.fmtKst(w.start), "2026-11-05 00:00");
  assert.equal(C.fmtKst(C.computeWindow(NOW, null, 7, 1).start), "2026-11-10 00:00");
  assert.equal(C.fmtKst(C.computeWindow(NOW, C.parseKst("2025-01-01"), 7).start), "2026-10-10 00:00"); // 최대 31일
  assert.equal(C.dateChunks(C.addDays(NOW, -15), NOW, 7).length, 3);
  assert.equal(C.ymAdd(NOW, -3), "202608");
  assert.equal(C.ymAdd(NOW, 9), "202708");
});

test("항목 정리", () => {
  const b = C.normalizeBid(BIDS[0], "용역");
  assert.equal(b.id, "bid:R26BK00000001-000");
  assert.equal(b.amount, 181818182);
  assert.equal(b.amount_label, "추정가격");
  assert.equal(b.deadline, "2026-11-20 10:00");
  assert.equal(b.files[0].name, "제안요청서.hwp");
  assert.equal(b.details["배정예산"], "200,000,000원");
  const p = C.normalizePrespec(PRESPEC_ONE.item, "용역");
  assert.equal(p.deadline_label, "의견마감");
  assert.equal(p.details["담당자"], "홍길동 (02-000-0000)");
  const o = C.normalizeOrderplan(PLANS[0], "용역");
  assert.equal(o.order_ym, "2027-03");
  assert.equal(o.details["발주예정"], "2027년 3월");
});

test("전체 조회: 페이지 넘김·오퍼레이션 대체·기간 필터·제외어", async () => {
  const f = fakeFetch(normalHandler);
  const client = new C.Client("TESTKEY", { fetchImpl: f, rows: 2, sleep: noSleep });
  const settings = Object.assign({}, C.DEFAULT_SETTINGS, { excludes: ["환경영향평가", "환경영향"] });
  const w = C.computeWindow(NOW, null, 7);
  const r = await C.collect(client, settings, w.start, w.end);
  const bidCalls = f.calls.filter((c) => c.op === "getBidPblancListInfoServcPPSSrch");
  assert.equal(bidCalls.length, 2, "입찰공고 2페이지");
  assert.equal(bidCalls[0].params.inqryBgnDt, "202611040000");
  assert.equal(bidCalls[0].params.inqryEndDt, "202611100730");
  assert.equal(bidCalls[0].params.serviceKey, "TESTKEY");
  assert.ok(f.calls.some((c) => c.op === "getOrderPlanSttusListServcPPSSrch"), "발주계획 대체 오퍼레이션");
  const ids = r.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["bid:R26BK00000001-000", "bid:R26BK00000003-001", "orderplan:R26DD00000001", "prespec:R26BD00000009"]);
  assert.deepEqual(r.items.find((i) => i.id === "bid:R26BK00000003-001").excluded, ["환경영향평가"]);
  assert.deepEqual(r.errors, []);
});

test("키 오류: 모든 소스 실패를 각각 보고", async () => {
  const f = fakeFetch(() => [200, GATEWAY_XML]);
  const client = new C.Client("BAD", { fetchImpl: f, sleep: noSleep });
  const w = C.computeWindow(NOW, null, 1);
  const r = await C.collect(client, C.DEFAULT_SETTINGS, w.start, w.end);
  assert.equal(r.errors.length, 3);
  assert.match(r.errors[0], /입찰공고\(용역\) 조회 실패: \[코드 30\]/);
});

test("일시 오류는 재시도, 네트워크 실패는 안내", async () => {
  let n = 0;
  const f = fakeFetch((op, p) => (++n === 1 ? [503, "busy"] : [200, ok([])]));
  const client = new C.Client("K", { fetchImpl: f, sleep: noSleep });
  await client.fetchAll("ad/BidPublicInfoService", "getBidPblancListInfoServcPPSSrch", {});
  assert.equal(n, 2);
  const down = new C.Client("K", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, sleep: noSleep, retries: 2 });
  await assert.rejects(down.fetchAll("x", "y", {}), (e) => e.httpStatus === 0 && /인터넷 연결/.test(e.message));
});

test("연결 점검", async () => {
  const f = fakeFetch(normalHandler);
  const client = new C.Client("K", { fetchImpl: f, sleep: noSleep });
  const res = await C.checkConnection(client, C.DEFAULT_SETTINGS, NOW);
  assert.deepEqual(res.map((x) => [x.key, x.ok]), [["bid", true], ["prespec", true], ["orderplan", true]]);
  assert.equal(client.rows, 500, "점검 후 원래 설정 복구");
});
