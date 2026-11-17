// 실행: node --test tests/   (공고문 파일 읽기·AI 요청 구성 — 네트워크 불필요)
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const D = require("../js/docread.js");
const AI = require("../js/ai.js");
const X = require("../vendor/xlsx-0.18.5.full.min.js");

// ── 시험용 파일 만들기 ──
function zip(files) { // { name: string(내용) } → deflate ZIP
  const parts = [], central = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const nm = Buffer.from(name), raw = Buffer.from(content), data = zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function hwpRecord(tag, payload) { const h = Buffer.alloc(4); h.writeUInt32LE(tag | (payload.length << 20), 0); return Buffer.concat([h, payload]); }
function paraText(units) { const b = Buffer.alloc(units.length * 2); units.forEach((u, i) => b.writeUInt16LE(u, i * 2)); return b; }
const str = (s) => [...s].map((c) => c.charCodeAt(0));
function hwp({ compressed = true, flags = 0, sections }) {
  const head = Buffer.alloc(256); head.write("HWP Document File", 0, "ascii"); head.writeUInt32LE(0x05000300, 32);
  head.writeUInt32LE((compressed ? 1 : 0) | flags, 36);
  const cfb = X.CFB.utils.cfb_new();
  X.CFB.utils.cfb_add(cfb, "/FileHeader", head);
  sections.forEach((recs, i) => {
    const raw = Buffer.concat(recs);
    X.CFB.utils.cfb_add(cfb, "/BodyText/Section" + i, compressed ? zlib.deflateRawSync(raw) : raw);
  });
  return Buffer.from(X.CFB.write(cfb, { type: "buffer" }));
}

test("HWP: 문단·표·탭·줄바꿈 제어문자 처리, 여러 구역", async () => {
  const tableCtrl = [11, 0x6c74, 0x6273, 0, 0, 0, 0, 11];          // 확장 제어문자(표) = 8글자
  const sec0 = [
    hwpRecord(66, Buffer.alloc(22)),                                 // PARA_HEADER (무시)
    hwpRecord(67, paraText([...str("제안요청서"), 13])),
    hwpRecord(67, paraText([...tableCtrl, ...str("평가항목"), 9, 0, 0, 0, 0, 0, 0, 9, ...str("배점"), 13])),
    hwpRecord(67, paraText([...str("가격평가 10점"), 10, ...str("기술평가 90점"), 13])),
  ];
  const sec1 = [hwpRecord(67, paraText([...str("과업기간: 계약일로부터 5개월"), 13]))];
  const r = await D.readFile("rfp.hwp", hwp({ sections: [sec0, sec1] }), X.CFB);
  assert.equal(r.kind, "hwp");
  assert.equal(r.text, "제안요청서\n평가항목\t배점\n가격평가 10점\n기술평가 90점\n과업기간: 계약일로부터 5개월");
  const plain = await D.readFile("plain.hwp", hwp({ compressed: false, sections: [sec1] }), X.CFB);
  assert.equal(plain.text, "과업기간: 계약일로부터 5개월");
});

test("HWP: 배포용·암호 문서는 이유를 알려 줌", async () => {
  await assert.rejects(D.readFile("d.hwp", hwp({ flags: 4, sections: [[]] }), X.CFB), /배포용/);
  await assert.rejects(D.readFile("p.hwp", hwp({ flags: 2, sections: [[]] }), X.CFB), /암호/);
});

test("HWPX·DOCX·TXT·PDF", async () => {
  const sec = '<hs:sec xmlns:hp="x"><hp:p><hp:run><hp:t>입찰참가자격</hp:t></hp:run></hp:p>' +
    '<hp:p><hp:run><hp:t>중소기업&amp;소상공인<hp:tab/>확인서</hp:t></hp:run></hp:p>' +
    '<hp:p><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>수행실적</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:p></hs:sec>';
  const hx = await D.readFile("공고문.hwpx", zip({ "mimetype": "application/hwp+zip", "Contents/section1.xml": '<x><hp:p><hp:t>둘째 구역</hp:t></hp:p></x>', "Contents/section0.xml": sec }));
  assert.equal(hx.kind, "hwpx");
  assert.equal(hx.text, "입찰참가자격\n중소기업&소상공인\t확인서\n수행실적\n\n둘째 구역");
  const dx = await D.readFile("과업지시서.docx", zip({ "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>과업 범위</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">1. 현황 진단</w:t></w:r></w:p></w:body></w:document>' }));
  assert.equal(dx.text, "과업 범위\n1. 현황 진단");
  const tx = await D.readFile("메모.txt", Buffer.from("평가비율 80:20\r\n"));
  assert.equal(tx.text, "평가비율 80:20");
  const pdf = await D.readFile("rfp.pdf", Buffer.from("%PDF-1.7 ..."));
  assert.equal(pdf.kind, "pdf"); assert.equal(Buffer.from(pdf.pdfBase64, "base64").toString().slice(0, 8), "%PDF-1.7");
  await assert.rejects(D.readFile("a.xls", Buffer.from("xx")), /지원하지 않는/);
});

test("AI 요청 구성: PDF 는 문서 블록, 나머지는 문서 태그, 질문은 마지막", () => {
  const docs = [{ name: "rfp.pdf", kind: "pdf", pdfBase64: "QUJD" }, { name: "공고<1>.hwp", kind: "hwp", text: "참가자격 & 평가" }];
  const c = AI.buildContent(docs, { no: "R26BK1-000", title: "조직진단", agency: "조달청", demand: "가상기관", amount: 90000000, amount_label: "추정가격" },
    { size: "중기업", codes: ["1169"], region: "서울특별시" });
  assert.equal(c[0].type, "document"); assert.equal(c[0].source.media_type, "application/pdf");
  assert.equal(c[1].type, "text");
  assert.match(c[1].text, /<document name="공고&lt;1&gt;.hwp">\n참가자격 &amp; 평가/);
  assert.match(c[1].text, /보유 업종코드\(나라장터 입찰참가자격 등록\): 1169/);
  assert.match(c[1].text, /검토 양식 칸을 채워 주세요\.$/);
  // 스키마: 모든 객체 additionalProperties false, required = 전체 속성
  assert.equal(AI.SCHEMA.additionalProperties, false);
  assert.deepEqual([...AI.SCHEMA.required].sort(), Object.keys(AI.SCHEMA.properties).sort());
  const v = AI.validate(Object.fromEntries(AI.SCHEMA.required.map((k) => [k, k === "small_business_rule" ? "엉뚱" : ""])));
  assert.equal(v.small_business_rule, "판단 불가"); assert.equal(v.midsize_eligible, "확인 필요");
});
