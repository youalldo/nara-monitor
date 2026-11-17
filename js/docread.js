/* 공고문·제안요청서 파일에서 글자를 꺼낸다 (브라우저 안에서만 처리, 서버로 보내지 않음)
 *
 *  - HWP (한글 5.0 바이너리): OLE 복합문서 → BodyText/SectionN 레코드 → 문단 글자(HWPTAG_PARA_TEXT)
 *  - HWPX (한글 개방형): ZIP → Contents/sectionN.xml 의 <hp:t>
 *  - DOCX: ZIP → word/document.xml 의 <w:t>
 *  - TXT: UTF-8, 안 되면 EUC-KR
 *  - PDF: 글자를 꺼내지 않고 그대로 AI 에 보낸다(표·서식까지 읽음) → kind "pdf"
 *
 * 압축 해제는 브라우저 내장 DecompressionStream("deflate-raw"), OLE 해석은 SheetJS 의 CFB 를 쓴다.
 * 브라우저(window.NaraDoc)와 Node(테스트) 양쪽에서 쓴다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NaraDoc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function DocError(msg) { this.name = "DocError"; this.message = msg; }
  DocError.prototype = Object.create(Error.prototype);

  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function le16(b, o) { return b[o] | (b[o + 1] << 8); }
  function le32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function inflateRaw(data) {
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new DocError("이 브라우저는 압축 해제를 지원하지 않습니다. 최신 크롬·엣지에서 열어 주세요."));
    }
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  // ───────── ZIP (HWPX, DOCX) ─────────
  function unzip(buf) {
    var b = u8(buf), eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (le32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new DocError("압축(ZIP) 형식이 아닙니다");
    var count = le16(b, eocd + 10), off = le32(b, eocd + 16), entries = {};
    var utf8 = new TextDecoder("utf-8"), cp949 = null;
    try { cp949 = new TextDecoder("euc-kr"); } catch (e) { cp949 = null; }
    for (var n = 0; n < count; n++) {
      if (le32(b, off) !== 0x02014b50) throw new DocError("ZIP 목록이 손상되었습니다");
      var flags = le16(b, off + 8), method = le16(b, off + 10), csize = le32(b, off + 20), nlen = le16(b, off + 28),
          xlen = le16(b, off + 30), clen = le16(b, off + 32), lho = le32(b, off + 42);
      var raw = b.subarray(off + 46, off + 46 + nlen), name;
      // 한국 Windows 에서 만든 ZIP 은 파일 이름이 CP949(EUC-KR) — UTF-8 표시(bit 11)가 없으면 CP949 로 읽는다
      if (flags & 0x800 || !cp949) name = utf8.decode(raw);
      else { try { name = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch (e) { name = cp949.decode(raw); } }
      entries[name] = { method: method, csize: csize, lho: lho };
      off += 46 + nlen + xlen + clen;
    }
    return {
      names: Object.keys(entries),
      read: function (name) {
        var e = entries[name];
        if (!e) return Promise.resolve(null);
        var p = e.lho, start = p + 30 + le16(b, p + 26) + le16(b, p + 28), data = b.subarray(start, start + e.csize);
        if (e.method === 0) return Promise.resolve(data);
        if (e.method === 8) return inflateRaw(data);
        return Promise.reject(new DocError("지원하지 않는 압축 방식(" + e.method + ")"));
      }
    };
  }

  function xmlText(xml, tTag, pTag, tabTag, brTag) {
    var re = new RegExp("<" + tTag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tTag + ">|</" + pTag + ">|<" + tabTag + "\\b[^>]*/>|<" + brTag + "\\b[^>]*/>", "g");
    var out = "", m;
    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) {   // 글자 안에 탭·줄바꿈 태그가 들어 있을 수 있다
        out += decodeEntities(m[1].replace(new RegExp("<" + tabTag + "\\b[^>]*/>", "g"), "\t")
          .replace(new RegExp("<" + brTag + "\\b[^>]*/>", "g"), "\n").replace(/<[^>]+>/g, ""));
      }
      else if (m[0].indexOf("</") === 0) out += "\n";
      else if (m[0].indexOf(tabTag) >= 0) out += "\t";
      else out += "\n";
    }
    return out;
  }
  function decodeEntities(t) {
    return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&amp;/g, "&");
  }
  function natural(a, b) { return (+(a.match(/(\d+)\.xml$/) || [0, 0])[1]) - (+(b.match(/(\d+)\.xml$/) || [0, 0])[1]); }

  function readHwpx(buf) {
    var z = unzip(buf);
    var secs = z.names.filter(function (n) { return /^Contents\/section\d+\.xml$/i.test(n); }).sort(natural);
    if (!secs.length) throw new DocError("HWPX 본문(Contents/section*.xml)을 찾지 못했습니다");
    return secs.reduce(function (p, name) {
      return p.then(function (acc) {
        return z.read(name).then(function (d) { return acc + xmlText(new TextDecoder("utf-8").decode(d), "hp:t", "hp:p", "hp:tab", "hp:lineBreak") + "\n"; });
      });
    }, Promise.resolve(""));
  }

  function readDocx(buf) {
    var z = unzip(buf);
    return z.read("word/document.xml").then(function (d) {
      if (!d) throw new DocError("DOCX 본문을 찾지 못했습니다");
      return xmlText(new TextDecoder("utf-8").decode(d), "w:t", "w:p", "w:tab", "w:br");
    });
  }

  // ───────── HWP 5.0 (OLE 복합문서) ─────────
  var HWPTAG_PARA_TEXT = 67;
  function paraText(rec) {
    var out = "", n = rec.length >> 1;
    for (var i = 0; i < n; i++) {
      var c = rec[2 * i] | (rec[2 * i + 1] << 8);
      if (c >= 32) { out += String.fromCharCode(c); continue; }
      if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {   // 1글자짜리 제어문자
        if (c === 10) out += "\n";
        else if (c >= 24) out += " ";
        continue;
      }
      if (c === 9) out += "\t";             // 탭(인라인 제어문자)
      i += 7;                               // 인라인·확장 제어문자는 8글자(16바이트)를 차지
    }
    return out;
  }
  function hwpRecords(b) {
    var out = [], p = 0;
    while (p + 4 <= b.length) {
      var h = le32(b, p); p += 4;
      var tag = h & 0x3ff, size = (h >>> 20) & 0xfff;
      if (size === 0xfff) { size = le32(b, p); p += 4; }
      if (p + size > b.length) break;
      if (tag === HWPTAG_PARA_TEXT) out.push(paraText(b.subarray(p, p + size)));
      p += size;
    }
    return out;
  }

  function readHwp(buf, CFB) {
    if (!CFB) return Promise.reject(new DocError("HWP 해석 모듈이 없습니다"));
    var cfb;
    try { cfb = CFB.read(u8(buf), { type: "array" }); } catch (e) { return Promise.reject(new DocError("HWP 파일을 열지 못했습니다 (손상되었거나 HWP 5.0 형식이 아님)")); }
    function stream(name) {
      var e = CFB.find(cfb, "/" + name);   // SheetJS CFB 는 "/폴더/스트림" 형태로 찾는다
      return e && e.content ? u8(e.content) : null;
    }
    var head = stream("FileHeader");
    if (!head || head.length < 40 || new TextDecoder("ascii").decode(head.subarray(0, 17)) !== "HWP Document File") {
      return Promise.reject(new DocError("HWP 5.0 문서가 아닙니다 (HWP 3.0 등 옛 형식은 한글에서 HWP/HWPX 로 다시 저장해 주세요)"));
    }
    var flags = le32(head, 36), compressed = !!(flags & 1);
    if (flags & 2) return Promise.reject(new DocError("암호가 걸린 HWP 입니다. 한글에서 암호를 풀고 다시 저장해 주세요"));
    if (flags & 4) return Promise.reject(new DocError("배포용(보기 전용) HWP 라 글자를 꺼낼 수 없습니다. 한글에서 PDF 로 저장해 올려 주세요"));
    var secs = [];
    for (var i = 0; i < 1000; i++) {
      var s = stream("BodyText/Section" + i);
      if (!s) break;
      secs.push(s);
    }
    if (!secs.length) return Promise.reject(new DocError("HWP 본문(BodyText)을 찾지 못했습니다"));
    return secs.reduce(function (p, s) {
      return p.then(function (acc) {
        return (compressed ? inflateRaw(s) : Promise.resolve(s)).then(function (raw) { return acc.concat(hwpRecords(raw)); });
      });
    }, Promise.resolve([])).then(function (paras) { return paras.join("\n"); });
  }

  // ───────── 텍스트 ─────────
  function readTxt(buf) {
    var b = u8(buf);
    try { return Promise.resolve(new TextDecoder("utf-8", { fatal: true }).decode(b)); } catch (e) {
      try { return Promise.resolve(new TextDecoder("euc-kr").decode(b)); } catch (e2) { return Promise.resolve(new TextDecoder("utf-8").decode(b)); }
    }
  }

  function tidy(t) {
    return String(t).replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function kindOf(name, b) {
    var ext = (String(name).match(/\.([a-z0-9]+)$/i) || [0, ""])[1].toLowerCase();
    if (b && b.length >= 4) {
      if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";            // %PDF
      if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return ext === "doc" ? "doc" : "hwp"; // OLE
      if (b[0] === 0x50 && b[1] === 0x4b) return ext === "docx" ? "docx" : "hwpx";                     // ZIP
    }
    return ext;
  }

  /** 파일 하나 → { name, kind, text?(hwp/hwpx/docx/txt), pdfBase64?(pdf), chars, size } */
  function readFile(name, buf, CFB) {
    var b = u8(buf), kind = kindOf(name, b);
    var done = function (text) {
      text = tidy(text);
      if (!text) throw new DocError("글자를 찾지 못했습니다 (그림으로 된 문서일 수 있습니다. PDF 로 올려 주세요)");
      return { name: name, kind: kind, text: text, chars: text.length, size: b.length };
    };
    if (kind === "pdf") return Promise.resolve({ name: name, kind: "pdf", pdfBase64: toBase64(b), chars: 0, size: b.length });
    if (kind === "hwp") return readHwp(b, CFB).then(done);
    if (kind === "hwpx") return readHwpx(b).then(done);
    if (kind === "docx") return readDocx(b).then(done);
    if (kind === "txt" || kind === "md" || kind === "csv") return readTxt(b).then(done);
    if (kind === "doc") return Promise.reject(new DocError("옛 Word(.doc) 형식은 읽지 못합니다. DOCX 나 PDF 로 저장해 올려 주세요"));
    return Promise.reject(new DocError("지원하지 않는 파일 형식입니다 (HWP·HWPX·PDF·DOCX·TXT 가능)"));
  }

  function toBase64(b) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
    return typeof btoa === "function" ? btoa(s) : Buffer.from(b).toString("base64");
  }

  return { readFile: readFile, unzip: unzip, readHwp: readHwp, readHwpx: readHwpx, readDocx: readDocx,
           paraText: paraText, hwpRecords: hwpRecords, kindOf: kindOf, DocError: DocError };
});
