/* 공고문·제안요청서 AI 분석 (Claude API, 공식 Anthropic SDK)
 *
 * 브라우저에서 사용자의 API 키로 api.anthropic.com 에 직접 요청한다(키는 이 브라우저에만 저장).
 * 결과는 정해진 JSON 형식(구조화 출력)으로 받아 '용역리서칭' 검토 양식 칸에 그대로 넣는다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NaraAI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MODEL = "claude-opus-5-5";
  var PRICE = { input: 4 / 1e6, output: 20 / 1e6 };      // 달러/토큰 (Claude Opus 5.5)
  var SMALL_RULES = ["소기업·소상공인만 참가", "중소기업 참가(중기업 가능)", "기업규모 제한 없음", "판단 불가"];

  function str(desc) { return { type: "string", description: desc }; }
  var SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["notice_no", "title", "client", "budget_vat_included", "estimated_price", "period", "submission",
      "deadlines", "eligibility", "evaluation_ratio", "quantitative", "scope", "notes",
      "small_business_rule", "small_business_evidence", "midsize_eligible", "check_points"],
    properties: {
      notice_no: str("입찰공고번호(예: R25BK00624726-000). 문서에 없으면 빈 문자열"),
      title: str("용역명"),
      client: str("발주처. 조달청이 대행하면 실제 수요기관"),
      budget_vat_included: { anyOf: [{ type: "integer" }, { type: "null" }], description: "사업금액(원, 부가세 포함): 배정예산·사업예산·기초금액 중 문서에 있는 것. 없으면 null" },
      estimated_price: { anyOf: [{ type: "integer" }, { type: "null" }], description: "추정가격(원, 부가세 제외). 없으면 null" },
      period: str("과업기간 (예: 계약체결일로부터 5개월)"),
      submission: str("접수구분: 가격입찰서·제안서 제출 방법 (예: 전자 / 방문제출 / 우편, 또는 '전자(가격) / 방문제출(제안서)')"),
      deadlines: str("가격/제안서 입찰 마감일과 주요 일정. 한 줄에 하나씩 (입찰참가등록 마감, 가격 마감, 제안서 마감, 제안발표 등)"),
      eligibility: str("입찰참가자격 요약: 업종(업종코드), 중소기업·소상공인 확인서 등 기업규모, 실적·인력 요건, 지역, 공동수급 허용 여부. 한 줄에 하나씩"),
      evaluation_ratio: str("평가비율. 예: '정량평가(20) 기술평가(70) 가격평가(10)'. 기술평가 안에 정량·정성이 나뉘면 함께 표기"),
      quantitative: str("정량평가 항목별 배점과 만점 기준(수행실적, 전문인력, 경영상태·신용평가 등). 한 줄에 한 항목, 예: '수행실적(6): 유사과제 합산 1.1억 이상 만점, 분야: 경영전략·조직진단'"),
      scope: str("과업내용 핵심 3~8개, 한 줄에 하나씩"),
      notes: str("고려/참고 사항: 제출서류(4대보험 가입자 명부 등), 상주·발표 요구, 보고서 인쇄 부수, 제출 유의사항, 담당자 연락처 등. 한 줄에 하나씩"),
      small_business_rule: { type: "string", enum: SMALL_RULES, description: "기업규모 참가 제한 판단" },
      small_business_evidence: str("기업규모 판단의 근거가 된 문서 문구를 원문 그대로 인용. 관련 문구가 없으면 '관련 문구 없음'"),
      midsize_eligible: { type: "string", enum: ["가능", "불가", "확인 필요"], description: "아래 '우리 회사' 기준 참가 가능 여부(기업규모·업종·지역·실적 요건 종합)" },
      check_points: str("우리 회사가 입찰 전에 확인하거나 준비할 점 1~4줄 (예: 정량 실적 충족 여부, 업종 등록, 소상공인 확인서 필요 여부)")
    }
  };

  var SYSTEM = [
    "당신은 한국 공공조달(나라장터) 용역 입찰을 검토하는 컨설팅회사 입찰 담당자를 돕습니다.",
    "제공된 입찰공고문·제안요청서·과업지시서를 읽고, 사내 '용역리서칭' 검토 양식의 칸을 채웁니다.",
    "",
    "작성 원칙",
    "- 문서에 있는 내용만 씁니다. 문서에 없으면 빈 문자열(금액은 null)로 두고 추측하지 않습니다.",
    "- 숫자, 날짜, 배점, 금액은 문서 표기를 그대로 옮깁니다. 날짜는 'YYYY.MM.DD(요일) HH:MM' 형식으로 씁니다.",
    "- 검토자가 엑셀 셀에서 바로 읽도록 짧게 쓰고, 여러 항목은 줄바꿈으로 나눕니다. 머리말이나 설명 문장은 붙이지 않습니다.",
    "",
    "기업규모 제한 판단 (small_business_rule)",
    "- 「중소기업제품 구매촉진 및 판로지원에 관한 법률」상 추정가격 1억원 미만 용역은 보통 소기업·소상공인으로, 1억원 이상 고시금액 미만은 중소기업(중기업 포함)으로 참가를 제한합니다. 다만 공고마다 예외가 있으므로 반드시 문서 문구로 판단합니다.",
    "- '소기업' 또는 '소상공인'만 참가할 수 있다는 문구(예: 소기업·소상공인 확인서 소지자)가 있으면 '소기업·소상공인만 참가'.",
    "- '중소기업' 확인서 또는 '중소기업·소상공인 확인서' 소지자, 중소기업자 간 제한이면 중기업도 참가할 수 있으므로 '중소기업 참가(중기업 가능)'. '소기업'과 '중소기업'을 혼동하지 마세요.",
    "- 기업규모 제한을 적용하지 않는다는 문구가 있거나 제한 문구 없이 일반경쟁·대기업 참여 가능이 명시되면 '기업규모 제한 없음'.",
    "- 문서로 확정할 수 없으면 '판단 불가'. small_business_evidence 에는 판단 근거 문구를 원문 그대로 인용합니다.",
    "",
    "midsize_eligible 은 사용자 메시지의 '우리 회사' 정보와 문서의 참가자격(기업규모, 업종코드, 지역, 실적·인력 요건)을 함께 보고 판단합니다. 문서만으로 확정할 수 없는 요건이 남아 있으면 '확인 필요'로 둡니다."
  ].join("\n");

  function escapeXml(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  /** 요청 본문의 user content 를 만든다 (문서 먼저, 질문은 마지막) */
  function buildContent(docs, item, company) {
    var blocks = [];
    docs.filter(function (d) { return d.kind === "pdf"; }).forEach(function (d) {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.pdfBase64 }, title: d.name });
    });
    var texts = docs.filter(function (d) { return d.text; });
    var body = "";
    if (texts.length) {
      body += "<documents>\n" + texts.map(function (d) {
        return '<document name="' + escapeXml(d.name) + '">\n' + escapeXml(d.text) + "\n</document>";
      }).join("\n") + "\n</documents>\n\n";
    }
    company = company || {};
    var codes = (company.codes || []).join(", ") || "없음";
    body += "<우리_회사>\n기업규모: " + (company.size === "소기업" ? "소기업·소상공인" : "중기업") +
      "\n보유 업종코드(나라장터 입찰참가자격 등록): " + codes +
      "\n소재지: " + (company.region || "미입력") + "\n</우리_회사>\n\n";
    if (item) {
      body += "<나라장터_목록정보>\n공고번호: " + (item.no || "") + "\n용역명: " + (item.title || "") +
        "\n공고기관: " + (item.agency || "") + "\n수요기관: " + (item.demand || "") +
        (item.amount ? "\n" + (item.amount_label || "금액") + ": " + item.amount + "원" : "") +
        "\n</나라장터_목록정보>\n\n";
    }
    body += "위 문서를 읽고 검토 양식 칸을 채워 주세요.";
    blocks.push({ type: "text", text: body });
    return blocks;
  }

  function friendlyError(e, SDK) {
    var A = SDK && SDK.default;
    if (A) {
      if (e instanceof A.APIUserAbortError) return "분석을 취소했습니다.";
      if (e instanceof A.AuthenticationError) return "Claude API 키가 올바르지 않습니다. [설정]에서 키를 확인하세요.";
      if (e instanceof A.PermissionDeniedError) return "이 API 키로는 사용할 수 없습니다(권한 없음). Anthropic Console 에서 키 권한을 확인하세요.";
      if (e instanceof A.RateLimitError) return "요청이 많아 잠시 제한되었습니다. 1분쯤 뒤 다시 시도하세요.";
      if (e instanceof A.BadRequestError) {
        if (/credit balance/i.test(e.message)) return "Anthropic 계정의 크레딧이 부족합니다. console.anthropic.com 의 Billing 에서 충전하세요.";
        if (/too long|too large|exceed/i.test(e.message)) return "문서가 너무 커서 한 번에 분석할 수 없습니다. 꼭 필요한 파일(공고문·제안요청서)만 올려 주세요.";
        return "요청이 거절되었습니다: " + e.message;
      }
      if (e instanceof A.APIConnectionError) return "Claude API 에 연결하지 못했습니다. 인터넷 연결(회사망이면 api.anthropic.com 허용 여부)을 확인하세요.";
      if (e instanceof A.APIError) return "Claude API 오류(" + e.status + "): " + e.message;
    }
    return (e && e.message) || String(e);
  }

  function validate(out) {
    if (!out || typeof out !== "object") throw new Error("AI 응답 형식이 올바르지 않습니다");
    SCHEMA.required.forEach(function (k) { if (!(k in out)) throw new Error("AI 응답에 '" + k + "' 항목이 없습니다"); });
    if (SMALL_RULES.indexOf(out.small_business_rule) < 0) out.small_business_rule = "판단 불가";
    if (["가능", "불가", "확인 필요"].indexOf(out.midsize_eligible) < 0) out.midsize_eligible = "확인 필요";
    return out;
  }

  /**
   * 분석 실행. opts: { apiKey, SDK(번들 전역), docs, item, company, signal, onStatus }
   * → { result, usage: {input, output, cost}, model }
   */
  function analyze(opts) {
    var SDK = opts.SDK, A = SDK.default;
    var client = new A({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    var params = {
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",             // 안전 분류기가 거절하면 서버가 다른 모델로 이어서 처리
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: buildContent(opts.docs, opts.item, opts.company) }]
    };
    if (opts.onStatus) opts.onStatus("AI 가 문서를 읽고 있습니다…");
    var stream = client.beta.messages.stream(params, { signal: opts.signal });
    stream.on("text", function () { if (opts.onStatus) opts.onStatus("검토 양식을 작성하고 있습니다…"); });
    return stream.finalMessage().then(function (msg) {
      if (msg.stop_reason === "refusal") throw new Error("AI 가 이 문서 분석을 거절했습니다. 다른 파일로 다시 시도해 보세요.");
      if (msg.stop_reason === "max_tokens") throw new Error("분석 결과가 너무 길어 중간에 끊겼습니다. 파일 수를 줄여 다시 시도하세요.");
      var text = msg.content.filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("");
      var out;
      try { out = JSON.parse(text); } catch (e) { throw new Error("AI 응답을 해석하지 못했습니다. 다시 시도해 주세요."); }
      var u = msg.usage || {};
      var input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      return {
        result: validate(out),
        usage: { input: input, output: u.output_tokens || 0, cost: input * PRICE.input + (u.output_tokens || 0) * PRICE.output },
        model: msg.model || MODEL
      };
    }).catch(function (e) { throw new Error(friendlyError(e, SDK)); });
  }

  /** 키 확인: 모델 정보 조회(무료)로 키가 유효한지 본다 */
  function checkKey(apiKey, SDK) {
    var client = new SDK.default({ apiKey: apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    return client.models.retrieve(MODEL).then(function (m) { return m.display_name || m.id; })
      .catch(function (e) { throw new Error(friendlyError(e, SDK)); });
  }

  /** 대략적인 입력 크기 안내용 (한글 1자 ≈ 1토큰으로 넉넉히 계산) */
  function estimate(docs) {
    var chars = 0, pdfBytes = 0;
    docs.forEach(function (d) { chars += d.chars || 0; if (d.kind === "pdf") pdfBytes += d.size || 0; });
    var tokens = chars + Math.round(pdfBytes / 60);     // PDF 는 대략 60바이트 ≈ 1토큰(쪽당 글자+그림)
    return { tokens: tokens, cost: tokens * PRICE.input + 3000 * PRICE.output };
  }

  return { MODEL: MODEL, SCHEMA: SCHEMA, SYSTEM: SYSTEM, SMALL_RULES: SMALL_RULES,
           buildContent: buildContent, analyze: analyze, checkKey: checkKey, estimate: estimate, validate: validate };
});
