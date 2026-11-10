/* '예시 데이터로 둘러보기' 용 가상 공고 (실제 공고 아님 — 기관명도 모두 가상) */
(function (root) {
  "use strict";
  // [구분, 사업명, 발주기관, 수요기관, 금액, [며칠 전, 시], 마감까지 일수 / 발주예정 몇 달 후]
  var SAMPLES = [
    ["bid", "2027~2031 중장기 경영전략 수립 연구용역", "예시광역시", "예시광역시 기획조정실", 180000000, [0, 9], 9],
    ["bid", "조직진단 및 적정인력 산정 컨설팅 용역", "한국샘플진흥원", "", 95000000, [0, 10], 6],
    ["bid", "기관 성과관리체계 고도화 및 BSC 재설계 용역", "가상공사", "가상공사 경영지원처", 64000000, [0, 11], 2],
    ["bid", "2026년도 공공기관 경영평가 대응 컨설팅", "예시개발공사", "", 120000000, [1, 14], 1],
    ["bid", "ESG 경영 전략 수립 및 지속가능경영보고서 발간", "모의환경공단", "", 88000000, [1, 16], 10],
    ["bid", "디지털 전환(DX) 추진 전략 수립 컨설팅", "샘플시설관리공단", "", 150000000, [2, 9], 12],
    ["bid", "직무분석 기반 성과평가 제도 개선 용역", "예시도 교육청", "예시도교육청 총무과", 42000000, [2, 15], -1],
    ["bid", "소규모 환경영향평가 용역", "가상군", "", 38000000, [0, 13], 7],
    ["bid", "청사 정밀안전진단 및 성능평가 용역", "예시시", "", 55000000, [1, 10], 8],
    ["prespec", "공공서비스 혁신 중장기 발전계획 수립 용역", "예시특별자치시", "", 200000000, [0, 10], 4],
    ["prespec", "통합 성과평가 시스템 구축 ISP", "가상연구원", "", 130000000, [0, 14], 5],
    ["prespec", "기관 비전 및 경영목표 재정립 컨설팅", "샘플관광공사", "", 70000000, [1, 11], 2],
    ["prespec", "인사·조직 운영 효율화 방안 연구용역", "모의광역시 도시공사", "", 48000000, [2, 9], -1],
    ["orderplan", "2027년 경영혁신 전략 수립 용역", "가상교통공사", "", 150000000, [0, 9], 2],
    ["orderplan", "조직 및 정원 진단 컨설팅", "예시시 시설공단", "", 60000000, [0, 9], 3],
    ["orderplan", "고객만족도 조사 및 서비스 품질 평가", "샘플문화재단", "", 35000000, [1, 13], 4],
    ["orderplan", "R&D 성과분석 및 중장기 투자전략 연구", "가상과학기술원", "", 250000000, [2, 10], 5]
  ];

  function demoItems(C, settings, now) {
    var matcher = new C.Matcher(settings.keywords, settings.excludes);
    var today = C.kstMidnight(now), out = [];
    SAMPLES.forEach(function (r, n) {
      var kind = r[0], ago = r[5][0], hour = r[5][1], due = r[6];
      var posted = new Date(C.addDays(today, -ago).getTime() + hour * 3600e3 + ((n * 7) % 60) * 60e3);
      var m = matcher.match(r[1]);
      if (!m.matched.length) return;
      var it = {
        kind: kind, kind_label: C.KIND_LABEL[kind], category: "용역", id: kind + ":DEMO" + n,
        title: r[1], agency: r[2], demand: r[3], posted: C.fmtKst(posted), deadline: "", deadline_label: "",
        amount: r[4], amount_label: "", order_ym: "", url: "", files: [], details: {},
        matched: m.matched, excluded: m.excluded,
        first_seen: (ago === 0 ? now : C.addDays(now, -ago)).toISOString()
      };
      var no;
      if (kind === "bid") {
        no = "R26BK9" + String(n).padStart(7, "0") + "-000";
        it.no = no; it.deadline = C.fmtKst(new Date(C.addDays(today, due).getTime() + 10 * 3600e3));
        it.deadline_label = "입찰마감"; it.amount_label = "추정가격"; it.url = "https://www.g2b.go.kr";
        it.files = [{ name: "제안요청서.hwp", url: "https://www.g2b.go.kr" }, { name: "과업지시서.pdf", url: "https://www.g2b.go.kr" }];
        it.details = { "공고번호": no, "공고종류": "등록공고", "계약방법": "제한경쟁", "낙찰방법": "협상에 의한 계약", "담당자": "홍길동 (02-000-0000)" };
      } else if (kind === "prespec") {
        no = "R26BD9" + String(n).padStart(7, "0");
        it.no = no; it.deadline = C.fmtKst(new Date(C.addDays(today, due).getTime() + 18 * 3600e3));
        it.deadline_label = "의견마감"; it.amount_label = "배정예산";
        it.files = [{ name: "규격문서 1", url: "https://www.g2b.go.kr" }];
        it.details = { "사전규격번호": no, "업무구분": "용역", "담당자": "김예시 (000-000-0000)" };
      } else {
        no = "R26DD9" + String(n).padStart(7, "0");
        var ym = C.ymAdd(now, due);
        it.no = no; it.order_ym = ym.slice(0, 4) + "-" + ym.slice(4); it.amount_label = "발주금액";
        it.details = { "발주계획번호": no, "발주예정": ym.slice(0, 4) + "년 " + parseInt(ym.slice(4), 10) + "월", "계약방법": "협상에 의한 계약", "담당부서": "기획예산팀" };
      }
      out.push(it);
    });
    return out;
  }
  root.NaraDemo = { items: demoItems };
})(typeof self !== "undefined" ? self : this);
