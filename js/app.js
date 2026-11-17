/* 나라장터 키워드 모니터 — 화면 */
(function () {
  "use strict";
  var VERSION = "1.4.0";
  var C = window.NaraCore, Store = window.NaraStore, Demo = window.NaraDemo;
  var KIND = C.KIND_LABEL;
  var WD = ["일", "월", "화", "수", "목", "금", "토"];
  var DAY = 864e5;

  var S = {
    settings: null, meta: {}, items: [], rows: [], demo: false, busy: false, suggest: null,
    ui: { tab: "all", kws: {}, q: "", onlyNew: false, hideClosed: true, showEx: false, sort: "posted", urgent: false, elig: "eligible" }
  };

  // ───────────────────────── 공통 도우미 ─────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) { u = String(u || "").trim(); return /^https?:\/\//i.test(u) ? u : ""; }
  function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var toastTimer;
  function toast(msg, ms) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, ms || 2600);
  }

  // 날짜 문자열은 모두 한국시간 "YYYY-MM-DD HH:MM"
  function parts(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(s || "");
    return m ? m.slice(1).map(function (x) { return x == null ? null : +x; }) : null;
  }
  function kstMs(s, endOfDay) {
    var p = parts(s); if (!p) return null;
    var h = p[3] == null ? (endOfDay ? 23 : 0) : p[3], mi = p[4] == null ? (endOfDay ? 59 : 0) : p[4];
    return Date.UTC(p[0], p[1] - 1, p[2], h - 9, mi);
  }
  function nowKstDay() { var d = new Date(Date.now() + 9 * 3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function fmt(s, withYear) {
    var p = parts(s); if (!p) return s || "";
    var wd = WD[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    var d = (withYear ? p[0] + "." : "") + p[1] + "/" + p[2] + "(" + wd + ")";
    return p[3] == null ? d : d + " " + String(p[3]).padStart(2, "0") + ":" + String(p[4]).padStart(2, "0");
  }
  function dday(s) {
    var p = parts(s); if (!p) return null;
    if (kstMs(s, true) < Date.now()) return { txt: "마감", cls: "over", n: -1 };
    var n = Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - nowKstDay()) / DAY);
    return { txt: n === 0 ? "오늘" : "D-" + n, cls: n <= 3 ? "urgent" : (n <= 7 ? "soon" : ""), n: n };
  }
  function isClosed(it) { var ms = kstMs(it.deadline, true); return ms != null && ms < Date.now(); }
  function won(n) {
    if (!n) return "";
    var eok = Math.floor(n / 1e8), man = Math.round((n % 1e8) / 1e4), out = "";
    if (man === 10000) { eok += 1; man = 0; }
    if (eok) out += eok.toLocaleString("ko-KR") + "억";
    if (man) out += (out ? " " : "") + man.toLocaleString("ko-KR") + "만";
    return (out || n.toLocaleString("ko-KR")) + "원";
  }
  function ymLabel(s) { return s ? s.slice(0, 4) + "년 " + (+s.slice(5, 7)) + "월" : ""; }
  function isoToKst(iso) { return iso ? C.fmtKst(new Date(iso)) : ""; }
  function ago(iso) {
    if (!iso) return "";
    var m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
    if (m < 1) return "방금";
    if (m < 60) return m + "분 전";
    if (m < 1440) return Math.round(m / 60) + "시간 전";
    return Math.round(m / 1440) + "일 전";
  }
  function isNew(it) { return (it.first_seen || "") >= new Date(Date.now() - DAY).toISOString(); }
  function elig(it) { return C.assess(it, S.settings.company); }
  function eligVisible(it) {
    var l = elig(it).level;
    if (S.ui.elig === "eligible") return l === "ok" || l === "check";
    if (S.ui.elig === "small") return l !== "no";
    return true;
  }

  // ───────────────────────── 데이터 처리 ─────────────────────────
  /** 현재 설정으로 모든 항목 재판정. 키워드·수집대상에서 빠졌거나 보관기간이 지난 항목은 정리 */
  function rematchAndPrune(items, settings, now) {
    var m = new C.Matcher(settings.keywords, settings.excludes);
    var cutoff = new Date(now.getTime() - settings.keepDays * DAY).toISOString();
    var keep = [], removed = [];
    items.forEach(function (it) {
      var r = m.match(it.title);
      var off = !settings.sources[it.kind] || settings.categories.indexOf(it.category) < 0;
      if (!r.matched.length || off || (it.first_seen || "") < cutoff) { removed.push(it.id); return; }
      it.matched = r.matched; it.excluded = r.excluded;
      keep.push(it);
    });
    return { keep: keep, removed: removed };
  }

  function countCalls(n) {
    var day = C.fmtKst(new Date()).slice(0, 10);
    if (!S.meta.calls || S.meta.calls.day !== day) S.meta.calls = { day: day, n: 0 };
    S.meta.calls.n += n;
  }

  function persistItems(res) {
    if (S.demo) return Promise.resolve();
    return Store.putItems(res.keep).then(function () { return Store.deleteItems(res.removed); });
  }

  function setBusy(on, text, frac) {
    $("progress").hidden = !on;
    if (on) {
      $("progressText").textContent = text || "조회 중…";
      $("progressBar").style.width = Math.round((frac || 0) * 100) + "%";
    }
    ["fetchBtn", "fetchRange"].forEach(function (id) { $(id).disabled = on; });
    $("fetchBtn").textContent = on ? "조회 중…" : "지금 조회";
  }

  function runFetch(days) {
    if (S.busy) return Promise.resolve();
    if (!S.settings.serviceKey) { openSettings(); toast("먼저 서비스키를 넣어 주세요"); return Promise.resolve(); }
    if (S.demo) { S.demo = false; S.items = []; }
    S.busy = true; setBusy(true, "조회 준비 중…", 0.02);
    var now = new Date(), runId = now.toISOString();
    var last = S.meta.lastRun ? new Date(S.meta.lastRun) : null;
    var w = C.computeWindow(now, last, S.settings.firstRunDays, days);
    var client = new C.Client(S.settings.serviceKey);
    S.meta.lastAttempt = runId; Store.saveMeta(S.meta);

    return C.collect(client, S.settings, w.start, w.end, function (p) {
      setBusy(true, p.label + "(" + p.category + ") 조회 중… " + (p.done + 1) + "/" + p.total, (p.done + 0.5) / p.total);
    }).then(function (r) {
      var byId = {}, fresh = [];
      S.items.forEach(function (it) { byId[it.id] = it; });
      r.items.forEach(function (it) {
        var old = byId[it.id];
        it.first_seen = old ? old.first_seen : runId;
        if (old && old.limits) it.limits = old.limits;
        if (!old) fresh.push(it);
        byId[it.id] = it;
      });
      var res = rematchAndPrune(Object.keys(byId).map(function (k) { return byId[k]; }), S.settings, now);
      S.items = res.keep;
      var keys = Object.keys(r.stats);
      var allFailed = keys.length > 0 && keys.every(function (k) { return r.stats[k].error; });
      var newShown = fresh.filter(function (it) { return !it.excluded.length && res.keep.indexOf(it) >= 0; }).length;
      // 일부라도 실패하면 '마지막 조회'를 앞당기지 않아 다음에 같은 기간을 다시 조회한다
      if (!r.errors.length) S.meta.lastRun = runId;
      else if (!S.meta.lastRun) S.meta.lastRun = null;
      S.meta.window = [w.start.toISOString(), w.end.toISOString()];
      S.meta.errors = r.errors;
      S.meta.lastNew = newShown;
      S.meta.lastRunId = runId;
      return enrichLimits(client, S.items).then(function () {
        countCalls(client.calls);
        Store.saveMeta(S.meta);
        return persistItems(res);
      }).then(function () { return { newShown: newShown, errors: r.errors, allFailed: allFailed }; });
    }).then(function (x) {
      S.busy = false; setBusy(false); S.suggest = null;
      renderAll();
      if (x.allFailed) toast("조회하지 못했습니다. 화면 위 안내를 확인하세요.", 4500);
      else toast((x.newShown ? "새 공고 " + x.newShown + "건을 찾았습니다" : "새 공고가 없습니다") + (x.errors.length ? " (일부 조회 실패)" : ""));
    }).catch(function (e) {
      S.busy = false; setBusy(false);
      S.meta.errors = ["조회 중 오류: " + (e && e.message || e)];
      Store.saveMeta(S.meta);
      renderAll();
    });
  }

  /** 키워드에 걸린 입찰공고의 업종(면허)·지역 제한 조회 (공고당 2회 호출, 한 번 성공하면 다시 부르지 않음) */
  var LIMIT_MAX = 60;
  function enrichLimits(client, items) {
    var todo = items.filter(function (it) {
      return it.kind === "bid" && !it.excluded.length && !isClosed(it) && !(it.limits && it.limits.ok);
    }).slice(0, LIMIT_MAX);
    var i = 0;
    function next() {
      if (i >= todo.length) return Promise.resolve();
      var it = todo[i++];
      setBusy(true, "참가자격(업종·지역 제한) 확인 중… " + i + "/" + todo.length, 0.85 + 0.15 * i / todo.length);
      return C.fetchBidLimits(client, it).then(function (L) { it.limits = L; }).then(next);
    }
    return next();
  }

  function maybeAutoFetch() {
    if (S.demo || S.busy || !S.settings.serviceKey || !S.settings.autoFetch) return;
    var last = S.meta.lastAttempt ? Date.parse(S.meta.lastAttempt) : 0;
    if (Date.now() - last >= S.settings.autoFetchMinutes * 60e3) runFetch(null);
  }

  // ───────────────────────── 화면 그리기 ─────────────────────────
  function passes(it, ignoreTab, ignoreKw) {
    var u = S.ui;
    if (!u.showEx && it.excluded.length) return false;
    if (u.onlyNew && !isNew(it)) return false;
    if (u.hideClosed && it.kind === "bid" && isClosed(it)) return false;
    if (!eligVisible(it)) return false;
    if (u.urgent) { var d = it.kind === "bid" && dday(it.deadline); if (!d || d.n < 0 || d.n > 3) return false; }
    if (!ignoreKw) {
      var sel = Object.keys(u.kws).filter(function (k) { return u.kws[k]; });
      if (sel.length && !it.matched.some(function (k) { return u.kws[k]; })) return false;
    }
    if (u.q) {
      var hay = (it.title + " " + it.agency + " " + it.demand + " " + it.no).toLowerCase().replace(/\s+/g, "");
      var words = u.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
    }
    if (!ignoreTab && u.tab !== "all" && it.kind !== u.tab) return false;
    return true;
  }
  function cmpPosted(a, b) {
    var x = (b.posted || "") + (b.first_seen || ""), y = (a.posted || "") + (a.first_seen || "");
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function dlKey(it) { // 진행중 마감 → 발주예정월 → 마감된 것
    if (it.deadline) return (isClosed(it) ? "3" : "1") + it.deadline;
    if (it.order_ym) return "2" + it.order_ym;
    return "4";
  }
  function sorter(a, b) {
    if (S.ui.sort === "amount") return (b.amount || 0) - (a.amount || 0) || cmpPosted(a, b);
    if (S.ui.sort === "deadline") { var ka = dlKey(a), kb = dlKey(b); return ka < kb ? -1 : ka > kb ? 1 : cmpPosted(a, b); }
    return cmpPosted(a, b);
  }
  function highlight(title, kws) {
    var t = esc(title); if (!kws.length) return t;
    var list = kws.slice().sort(function (a, b) { return b.length - a.length; }).map(function (k) { return reEsc(esc(k)); });
    return t.replace(new RegExp(list.join("|"), "g"), function (m) { return "<mark>" + m + "</mark>"; });
  }

  function card(it) {
    var closed = it.kind === "bid" && isClosed(it), fresh = isNew(it);
    var h = '<article class="item' + (fresh ? " is-new" : "") + (closed ? " closed" : "") + (it.excluded.length ? " excluded" : "") + '">';
    var ev = elig(it);
    h += '<div class="row1"><span class="badge k-' + it.kind + '">' + KIND[it.kind] + "</span>";
    h += '<span class="badge e-' + ev.level + '" title="' + esc(ev.reasons.join(" / ")) + '">' + esc(ev.label) + "</span>";
    if (fresh) h += '<span class="badge b-new">NEW</span>';
    if (it.excluded.length) h += '<span class="badge b-ex">제외어 · ' + esc(it.excluded.join(", ")) + "</span>";
    var kindNm = it.details && it.details["공고종류"];
    if (kindNm && kindNm !== "등록공고") h += '<span class="badge b-ex">' + esc(kindNm) + "</span>";
    h += "<span>" + esc(it.category) + "</span>";
    if (it.posted) h += "<span>· " + fmt(it.posted) + " 게시</span>";
    h += '<span>· 키워드 <span class="kw">' + esc(it.matched.join(", ")) + "</span></span></div>";
    var title = highlight(it.title, it.matched), url = safeUrl(it.url);
    h += '<h3 class="title">' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + title + '<span class="ext">나라장터 ↗</span></a>' : title) + "</h3>";
    var orgs = [];
    if (it.agency) orgs.push("<span>" + (it.kind === "bid" ? "공고 " : "발주 ") + esc(it.agency) + "</span>");
    if (it.demand && it.demand !== it.agency) orgs.push("<span>" + (it.kind === "orderplan" ? "총괄 " : "수요 ") + esc(it.demand) + "</span>");
    h += '<div class="orgs">' + orgs.join("") + "</div>";
    h += '<div class="facts"><div class="fact"><span class="l">' + esc(it.amount_label || "금액") + '</span><span class="v' + (it.amount ? "" : " none") + '">' + (it.amount ? won(it.amount) : "미공개") + "</span></div>";
    if (it.deadline) {
      var d = dday(it.deadline);
      h += '<div class="fact"><span class="l">' + esc(it.deadline_label) + '</span><span class="v">' + fmt(it.deadline) + (d ? '<span class="dday ' + d.cls + '">' + d.txt + "</span>" : "") + "</span></div>";
    }
    if (it.order_ym) h += '<div class="fact"><span class="l">발주예정</span><span class="v">' + ymLabel(it.order_ym) + "</span></div>";
    h += "</div>";
    var det = it.details || {}, keys = Object.keys(det), files = (it.files || []).filter(function (f) { return safeUrl(f.url); });
    {
      h += "<details><summary>상세 정보 · 참가자격 판단</summary>";
      h += "<dl><dt>참가자격 판단</dt><dd><b>" + esc(ev.label) + '</b><ul class="elig-why">' +
           ev.reasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></dd></dl>";
      if (keys.length) {
        h += "<dl>";
        keys.forEach(function (k) {
          var v = esc(det[k]);
          if (/번호$/.test(k)) v += ' <button class="linkish" type="button" data-copy="' + esc(det[k]) + '">복사</button>';
          h += "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>";
        });
        h += "</dl>";
      }
      if (files.length) {
        h += '<div class="files">';
        files.forEach(function (f) { h += '<a href="' + esc(safeUrl(f.url)) + '" target="_blank" rel="noopener noreferrer">📎 ' + esc(f.name) + "</a>"; });
        h += "</div>";
      }
      h += "</details>";
    }
    return h + "</article>";
  }

  function renderHeader() {
    var st = S.settings, m = S.meta, parts_ = [];
    if (S.demo) parts_.push("<b>예시 화면</b>");
    else if (m.lastAttempt) parts_.push("마지막 조회 <b>" + esc(fmt(isoToKst(m.lastAttempt))) + "</b> (" + ago(m.lastAttempt) + ")");
    else if (st.serviceKey) parts_.push("아직 조회하지 않았습니다");
    if (m.calls && m.calls.day === C.fmtKst(new Date()).slice(0, 10)) parts_.push("오늘 API " + m.calls.n + "회 사용");
    parts_.push("키워드 " + st.keywords.map(esc).join(", "));
    $("sub").innerHTML = parts_.join(" · ");
  }

  function renderBanners() {
    var h = "";
    if (S.demo) {
      h += '<div class="banner info"><span class="grow"><b>예시 화면</b> — 실제 공고가 아닌 가상의 예시입니다. 서비스키를 넣으면 실제 나라장터 공고로 바뀝니다.</span>' +
           '<button class="btn" type="button" data-act="exit-demo">예시 끄기</button></div>';
    }
    if (!Store.persistent) {
      h += '<div class="banner err"><span class="grow"><b>이 브라우저에서는 기록이 저장되지 않습니다</b> (사생활 보호 창 등). 창을 닫으면 조회 기록이 사라집니다.</span></div>';
    }
    if (S.suggest) {
      var what = S.suggest.words.length ? "새로 추가한 키워드(" + S.suggest.words.map(esc).join(", ") + ")" : "새로 켠 수집 대상";
      h += '<div class="banner info"><span class="grow">' + what + "로 지난 공고도 찾아볼까요?</span>" +
           '<button class="btn primary" type="button" data-act="suggest-run">최근 7일 다시 조회</button>' +
           '<button class="btn" type="button" data-act="suggest-close">닫기</button></div>';
    }
    if (!S.demo && S.meta.errors && S.meta.errors.length) {
      h += '<div class="banner err"><span class="grow"><b>일부 자료를 가져오지 못했습니다.</b> 다음 조회 때 같은 기간을 다시 조회합니다.<ul>' +
           S.meta.errors.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul></span>" +
           '<button class="btn" type="button" data-act="open-settings">설정·연결 점검</button></div>';
    }
    $("banners").innerHTML = h;
  }

  function renderTiles() {
    var vis = S.items.filter(function (it) { return !it.excluded.length && eligVisible(it); });
    function n(f) { return vis.filter(f).length; }
    var tiles = [
      { lbl: "신규 (최근 24시간)", num: n(isNew), cls: "hl", act: "new" },
      { lbl: "진행중 입찰공고", num: n(function (i) { return i.kind === "bid" && !isClosed(i); }), act: "bid" },
      { lbl: "사전규격", num: n(function (i) { return i.kind === "prespec"; }), act: "prespec" },
      { lbl: "발주계획", num: n(function (i) { return i.kind === "orderplan"; }), act: "orderplan" },
      { lbl: "3일 내 입찰마감", num: n(function (i) { var d = i.kind === "bid" && dday(i.deadline); return d && d.n >= 0 && d.n <= 3; }), cls: "warn", act: "urgent" }
    ];
    $("tiles").innerHTML = tiles.map(function (t) {
      return '<button type="button" class="tile ' + (t.cls || "") + '" data-tile="' + t.act + '"><div class="lbl">' + t.lbl +
             '</div><div class="num">' + t.num.toLocaleString("ko-KR") + "<small>건</small></div></button>";
    }).join("");
  }

  function renderList() {
    var c = { all: 0, bid: 0, prespec: 0, orderplan: 0 };
    S.items.forEach(function (it) { if (passes(it, true)) { c.all++; c[it.kind]++; } });
    $("tabs").innerHTML = ["all", "bid", "prespec", "orderplan"].map(function (k) {
      return '<button type="button" data-tab="' + k + '" aria-pressed="' + (S.ui.tab === k) + '">' + (k === "all" ? "전체" : KIND[k]) + '<span class="cnt">' + c[k] + "</span></button>";
    }).join("");
    var kc = {};
    S.items.forEach(function (it) { if (passes(it, false, true)) it.matched.forEach(function (k) { kc[k] = (kc[k] || 0) + 1; }); });
    $("kwChips").innerHTML = S.settings.keywords.map(function (k) {
      return '<button type="button" class="chip" data-kw="' + esc(k) + '" aria-pressed="' + !!S.ui.kws[k] + '">' + esc(k) + '<span class="cnt">' + (kc[k] || 0) + "</span></button>";
    }).join("");

    var rows = S.items.filter(function (it) { return passes(it); }).sort(sorter);
    S.rows = rows;
    var sortTxt = { posted: "최신 게시순", deadline: "마감 임박순", amount: "금액 큰 순" }[S.ui.sort];
    var hidSmall = 0, hidNo = 0;
    if (S.ui.elig !== "all") S.items.forEach(function (it) {
      if (it.excluded.length && !S.ui.showEx) return;
      var l = elig(it).level;
      if (l === "no") hidNo++; else if (l === "small" && S.ui.elig === "eligible") hidSmall++;
    });
    var hidTxt = (hidSmall || hidNo) ? ' · 참가자격으로 숨긴 공고: ' + (hidSmall ? "1억 미만 " + hidSmall + "건 " : "") + (hidNo ? "참가 불가 " + hidNo + "건 " : "") +
      '<button class="linkish" type="button" data-act="show-all-elig">모두 보기</button>' : "";
    $("info").innerHTML = rows.length.toLocaleString("ko-KR") + "건 표시 중 · " + sortTxt + hidTxt +
      (S.ui.urgent ? ' · <b>3일 내 입찰마감만</b> <button class="linkish" type="button" data-act="clear-urgent">해제</button>' : "");
    if (rows.length) { $("list").innerHTML = rows.map(card).join(""); return; }
    var msg;
    if (!S.items.length) msg = S.busy ? "나라장터에서 공고를 가져오는 중입니다…" :
      (S.meta.lastAttempt ? "보관 중인 공고가 없습니다. 위의 [지금 조회]로 다시 조회하거나, 기간을 '최근 7일'로 골라 조회해 보세요." : "아직 조회한 공고가 없습니다. 위의 [지금 조회]를 눌러 보세요.");
    else msg = "조건에 맞는 공고가 없습니다." + (S.ui.onlyNew ? " '신규만'을 끄면 보관 중인 전체를 볼 수 있습니다." : "");
    $("list").innerHTML = '<div class="empty">' + msg + "</div>";
  }

  function setElig(v) {
    S.ui.elig = v; $("elig").value = v;
    S.settings.eligView = v; Store.saveSettings(S.settings);
    renderTiles(); renderList();
  }

  function renderAll() {
    var noKey = !S.settings.serviceKey && !S.demo;
    $("onboard").hidden = !noKey;
    ["tiles", "toolbar", "info", "list"].forEach(function (id) { $(id).hidden = noKey; });
    renderHeader(); renderBanners();
    if (!noKey) { renderTiles(); renderList(); }
  }

  // ───────────────────────── 내보내기 ─────────────────────────
  var HEAD = ["구분", "신규", "업무구분", "사업명", "발주/공고기관", "수요/총괄기관", "금액구분", "금액(원)", "게시일시",
              "마감구분", "마감일시", "발주예정", "매칭키워드", "제외어", "번호", "담당자", "링크", "참가자격", "입찰참가범위"];
  function exportRows() {
    return S.rows.map(function (it) {
      return [KIND[it.kind], isNew(it) ? "NEW" : "", it.category, it.title, it.agency, it.demand, it.amount_label,
        it.amount || "", it.posted, it.deadline ? it.deadline_label : "", it.deadline, ymLabel(it.order_ym),
        it.matched.join(", "), it.excluded.join(", "), it.no, (it.details || {})["담당자"] || "", safeUrl(it.url),
        elig(it).label, elig(it).scope];
    });
  }
  function fileStamp() { return C.fmtKst(new Date()).slice(0, 10); }
  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportCsv() {
    if (!S.rows.length) { toast("내보낼 공고가 없습니다"); return; }
    var q = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [HEAD.join(",")].concat(exportRows().map(function (r) { return r.map(q).join(","); }));
    download(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), "nara_" + fileStamp() + ".csv");
  }
  var xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "vendor/xlsx-0.18.5.full.min.js";
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { xlsxPromise = null; reject(new Error("엑셀 모듈을 불러오지 못했습니다")); };
      document.head.appendChild(s);
    });
    return xlsxPromise;
  }
  // 사용자가 쓰던 '용역리서칭' 검토 양식과 같은 열 순서·너비 (A열 비움, 2행 제목, S1 '의견')
  var REVIEW_HEAD = ["업데이트날짜", "입찰공고번호", "입찰진행여부", "작성자", "유형", "키워드", "발주처", "용역명",
    "사업금액(단위:원,VAT포함)", "과업기간", "접수구분", "가격/제안서 입찰 마감일", "입찰참가범위", "평가비율", "정량점수",
    "과업내용", "고려/참고 사항", "본공고 확인/소상공인 확인 등"];
  var REVIEW_WIDTHS = [2, 17, 23, 16, 11, 8, 16, 28, 64, 13, 19, 30, 31, 56, 38, 58, 56, 93, 76];
  var TYPE_NAME = { bid: "실공고", prespec: "사전규격", orderplan: "발주계획" };
  function dotDate(x) { return x ? String(x).replace(/-/g, ".") : ""; }
  function reviewRow(it) {
    var m = it.meta || {}, d = it.details || {}, ev = elig(it);
    var vat = it.kind === "bid" ? (m.budget || (m.presmpt ? Math.round(m.presmpt * 1.1) : "")) : (it.amount || "");
    var period = it.kind === "prespec" ? (m.period || d["납품기한"] || "") : (it.kind === "orderplan" ? "미정" : "");
    var recv = it.kind === "bid" ? (m.bidMethd || "") : "미정";
    var due = it.kind === "bid" ? dotDate(it.deadline)
      : it.kind === "prespec" ? "미정 (사전규격 의견마감 " + dotDate(it.deadline) + ")"
      : "미정 (발주예정 " + (ymLabel(it.order_ym) || "미정") + ")";
    var note = [];
    if (m.cntrctMthd) note.push("계약방법: " + m.cntrctMthd);
    if (m.sucsfbidMthd) note.push("낙찰방법: " + m.sucsfbidMthd);
    var officer = m.officer || d["담당자"];
    if (officer) note.push("담당자: " + officer);
    if (it.files && it.files.length) note.push("첨부: " + it.files.map(function (f) { return f.name; }).join(", "));
    if (safeUrl(it.url)) note.push("공고: " + safeUrl(it.url));
    var why = ev.reasons.filter(function (r) { return !/1억 이상|참여 가능$|충족|제한 없음/.test(r); }).slice(0, 2);
    return ["", dotDate(C.fmtKst(new Date()).slice(0, 10)), it.no || "", "", (S.settings.company || {}).author || "",
      TYPE_NAME[it.kind], it.matched.join(", "), it.kind === "orderplan" ? it.agency : (it.demand || it.agency), it.title,
      vat, period, recv, due, ev.scope, "", "", it.kind === "orderplan" ? (m.usg || "") : "", note.join(" / "),
      ev.label + (why.length ? " — " + why.join(" / ") : "")];
  }
  function exportXlsx() {
    if (!S.rows.length) { toast("내보낼 공고가 없습니다"); return; }
    $("xlsxBtn").disabled = true;
    loadXlsx().then(function (X) {
      var rows = S.rows.map(reviewRow), blank = [];
      for (var i = 0; i < 18; i++) blank.push("");
      var aoa = [blank.concat(["의견"]), [""].concat(REVIEW_HEAD)].concat(rows);
      var ws = X.utils.aoa_to_sheet(aoa);
      ws["!cols"] = REVIEW_WIDTHS.map(function (w) { return { wch: w }; });
      ws["!autofilter"] = { ref: X.utils.encode_range({ s: { r: 1, c: 1 }, e: { r: rows.length + 1, c: 18 } }) };
      S.rows.forEach(function (it, i) {
        var u = safeUrl(it.url), r = i + 2;
        var t = ws[X.utils.encode_cell({ r: r, c: 8 })];
        if (u && t) t.l = { Target: u };
        var a = ws[X.utils.encode_cell({ r: r, c: 9 })];
        if (a && typeof a.v === "number") a.z = "#,##0";
      });
      var wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, "용역리서칭");
      X.writeFile(wb, "nara_review_" + fileStamp() + ".xlsx");
      toast("검토양식으로 " + rows.length + "건을 저장했습니다");
    }).catch(function (e) { toast(e.message + " — CSV 로 내려받아 주세요", 4000); })
      .then(function () { $("xlsxBtn").disabled = false; });
  }

  // ───────────────────────── 설정 창 ─────────────────────────
  var draft = null, draftBase = "";
  function snapshot(o) { return JSON.stringify({ k: o.serviceKey, kw: o.keywords, ex: o.excludes, s: o.sources, c: o.categories, a: o.autoFetch, am: o.autoFetchMinutes, kd: o.keepDays, co: o.company }); }

  function openSettings() {
    draft = JSON.parse(JSON.stringify(S.settings)); draft._added = {};
    draftBase = snapshot(draft);
    $("sKey").value = draft.serviceKey; $("sKey").type = "password"; $("sKeyShow").textContent = "보기";
    $("sKeyResult").innerHTML = ""; $("sMsg").textContent = "";
    $("sImportBox").hidden = true; $("sClearConfirm").hidden = true;
    $("sAuto").checked = !!draft.autoFetch;
    $("sAutoMin").value = String(draft.autoFetchMinutes);
    $("sKeep").value = String(draft.keepDays);
    draft.company = draft.company || JSON.parse(JSON.stringify(C.DEFAULT_SETTINGS.company));
    $("sSize").value = draft.company.size || "중기업";
    $("sRegion").value = draft.company.region || "";
    $("sAuthor").value = draft.company.author || "";
    renderDraft();
    var dlg = $("settings");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    if (!draft.serviceKey) setTimeout(function () { $("sKey").focus(); }, 50);
  }
  function closeSettings() { var dlg = $("settings"); if (dlg.open) dlg.close(); draft = null; }

  function renderDraft() {
    if (!draft) return;
    function chips(key, cls) {
      var arr = draft[key];
      return arr.length ? arr.map(function (w, i) {
        return '<span class="wchip ' + cls + (draft._added[key + ":" + w] ? " added" : "") + '">' + esc(w) +
               '<button type="button" aria-label="' + esc(w) + ' 삭제" title="삭제" data-del="' + key + '" data-i="' + i + '">×</button></span>';
      }).join("") : '<span class="note">' + (key === "keywords" ? "키워드를 1개 이상 넣어 주세요." : "제외어가 없습니다.") + "</span>";
    }
    $("sKwChips").innerHTML = chips("keywords", "");
    $("sExChips").innerHTML = chips("excludes", "ex");
    $("sCodeChips").innerHTML = draft.company.codes.length ? draft.company.codes.map(function (c, i) {
      return '<span class="wchip code">' + esc(c) + (C.INDUSTRY_NAMES[c] ? " " + esc(C.INDUSTRY_NAMES[c]) : "") +
             '<button type="button" aria-label="' + esc(c) + ' 삭제" title="삭제" data-del="codes" data-i="' + i + '">×</button></span>';
    }).join("") : '<span class="note">업종코드가 없으면 업종제한 공고는 모두 \'참가 불가\'로 판정됩니다.</span>';
    $("sKwN").textContent = draft.keywords.length + "개";
    $("sExN").textContent = draft.excludes.length + "개";
    $("sSources").innerHTML = ["bid", "prespec", "orderplan"].map(function (k) {
      return '<label><input type="checkbox" data-src="' + k + '"' + (draft.sources[k] ? " checked" : "") + "> " + KIND[k] + "</label>";
    }).join("");
    $("sCats").innerHTML = C.CATEGORIES.map(function (c) {
      return '<label><input type="checkbox" data-cat="' + c + '"' + (draft.categories.indexOf(c) >= 0 ? " checked" : "") + "> " + c + "</label>";
    }).join("");
    $("sDirty").textContent = snapshot(draft) !== draftBase ? "● 저장하지 않은 변경사항" : "";
  }

  function addWords(key, inputId) {
    var inp = $(inputId);
    var words = inp.value.split(/[,\n]/).map(function (w) { return w.replace(/\s+/g, " ").trim(); }).filter(Boolean);
    if (!words.length) { inp.focus(); return; }
    var tooLong = words.filter(function (w) { return w.length > 40; });
    if (tooLong.length) { toast("40자 이내로 넣어 주세요: " + tooLong[0].slice(0, 20) + "…"); return; }
    var dup = [], added = 0;
    words.forEach(function (w) {
      if (draft[key].indexOf(w) >= 0) { dup.push(w); return; }
      draft[key].push(w); draft._added[key + ":" + w] = true; added++;
    });
    inp.value = ""; inp.focus(); renderDraft();
    if (dup.length) toast("이미 있는 단어: " + dup.join(", "));
    else if (added) toast(added + "개 추가 — [저장]을 눌러야 반영됩니다");
  }

  function saveSettings() {
    draft.serviceKey = $("sKey").value.trim();
    draft.keywords = C.cleanWords(draft.keywords);
    draft.excludes = C.cleanWords(draft.excludes);
    if (!draft.keywords.length) { toast("검색 키워드를 1개 이상 넣어 주세요"); return; }
    if (!Object.keys(draft.sources).some(function (k) { return draft.sources[k]; })) { toast("수집 대상을 1개 이상 고르세요"); return; }
    if (!draft.categories.length) { toast("업무구분을 1개 이상 고르세요"); return; }
    draft.autoFetch = $("sAuto").checked;
    draft.autoFetchMinutes = +$("sAutoMin").value || 60;
    draft.keepDays = +$("sKeep").value || 60;
    var next = JSON.parse(JSON.stringify(draft)); delete next._added;
    closeSettings();
    applySettings(next);
  }

  function applySettings(next) {
    var old = S.settings;
    S.settings = next;
    Store.saveSettings(next);
    var res = rematchAndPrune(S.items, next, new Date());
    S.items = res.keep;
    persistItems(res);
    Object.keys(S.ui.kws).forEach(function (k) { if (next.keywords.indexOf(k) < 0) delete S.ui.kws[k]; });
    var added = next.keywords.filter(function (k) { return old.keywords.indexOf(k) < 0; });
    var srcAdded = Object.keys(next.sources).some(function (k) { return next.sources[k] && !old.sources[k]; }) ||
                   next.categories.some(function (c) { return old.categories.indexOf(c) < 0; });
    var firstKey = !old.serviceKey && next.serviceKey;
    S.suggest = (!firstKey && next.serviceKey && !S.demo && S.meta.lastAttempt && (added.length || srcAdded)) ? { words: added } : null;
    renderAll();
    toast("저장했습니다" + (res.removed.length ? " · 설정에 맞지 않는 공고 " + res.removed.length + "건 정리" : ""));
    if (firstKey) { if (S.demo) { S.demo = false; S.items = []; } runFetch(null); }
  }

  function testKey() {
    var key = $("sKey").value.trim(), out = $("sKeyResult");
    if (!key) { out.innerHTML = '<span class="bad">서비스키를 먼저 넣어 주세요.</span>'; return; }
    $("sKeyTest").disabled = true;
    out.innerHTML = '<span><span class="spin" aria-hidden="true"></span> 공공데이터포털에 연결하는 중…</span>';
    var client = new C.Client(key);
    C.checkConnection(client, draft, new Date()).then(function (res) {
      countCalls(client.calls); Store.saveMeta(S.meta);
      out.innerHTML = res.map(function (r) {
        return r.ok ? '<span class="okr">✓ ' + esc(r.label) + " — 정상 (어제~지금 " + r.total.toLocaleString("ko-KR") + "건)</span>"
                    : '<span class="bad">✕ ' + esc(r.label) + " — " + esc(r.error) + "</span>";
      }).join("") + (res.every(function (r) { return r.ok; }) ? '<span class="okr"><b>모두 정상입니다. [저장]을 누르세요.</b></span>' : "");
    }).catch(function (e) {
      out.innerHTML = '<span class="bad">점검 실패: ' + esc(e && e.message || e) + "</span>";
    }).then(function () { $("sKeyTest").disabled = false; });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard"));
  }

  // ───────────────────────── 이벤트 ─────────────────────────
  function bind() {
    $("fetchBtn").addEventListener("click", function () {
      var v = $("fetchRange").value;
      runFetch(v ? +v : null);
    });
    $("settingsBtn").addEventListener("click", openSettings);
    $("demoBtn").addEventListener("click", function () {
      S.demo = true; S.items = Demo.items(C, S.settings, new Date()); renderAll();
    });
    $("onboardForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var key = $("onboardKey").value.trim();
      if (!key) { $("onboardKey").focus(); return; }
      var next = JSON.parse(JSON.stringify(S.settings)); next.serviceKey = key;
      $("onboardKey").value = "";
      applySettings(next);
    });

    $("banners").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]"); if (!b) return;
      var a = b.dataset.act;
      if (a === "exit-demo") { S.demo = false; S.items = []; loadItems().then(renderAll); }
      else if (a === "suggest-run") { S.suggest = null; runFetch(7); }
      else if (a === "suggest-close") { S.suggest = null; renderBanners(); }
      else if (a === "open-settings") openSettings();
    });
    $("tabs").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-tab]"); if (!b) return;
      S.ui.tab = b.dataset.tab; S.ui.urgent = false; renderList();
    });
    $("kwChips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-kw]"); if (!b) return;
      S.ui.kws[b.dataset.kw] = !S.ui.kws[b.dataset.kw]; renderList();
    });
    var qt;
    $("q").addEventListener("input", function (e) {
      clearTimeout(qt); qt = setTimeout(function () { S.ui.q = e.target.value.trim(); renderList(); }, 120);
    });
    ["onlyNew", "hideClosed", "showEx"].forEach(function (id) {
      $(id).addEventListener("change", function (e) { S.ui[id] = e.target.checked; renderList(); });
    });
    $("sort").addEventListener("change", function (e) { S.ui.sort = e.target.value; renderList(); });
    $("elig").addEventListener("change", function (e) { setElig(e.target.value); });
    $("info").addEventListener("click", function (e) {
      if (e.target.closest("[data-act='clear-urgent']")) { S.ui.urgent = false; renderList(); }
      if (e.target.closest("[data-act='show-all-elig']")) { setElig("all"); }
    });
    $("tiles").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-tile]"); if (!b) return;
      var a = b.dataset.tile;
      S.ui.onlyNew = a === "new"; $("onlyNew").checked = S.ui.onlyNew;
      S.ui.urgent = a === "urgent";
      if (a === "new") { S.ui.tab = "all"; S.ui.sort = "posted"; }
      else if (a === "urgent") { S.ui.tab = "bid"; S.ui.sort = "deadline"; S.ui.hideClosed = true; $("hideClosed").checked = true; }
      else S.ui.tab = a;
      $("sort").value = S.ui.sort; renderList();
      $("toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("list").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-copy]"); if (!b) return;
      var v = b.dataset.copy;
      copyText(v).then(function () { toast("복사했습니다: " + v); }, function () { toast("복사가 안 되면 번호를 직접 선택해 복사하세요: " + v, 4000); });
    });
    $("csvBtn").addEventListener("click", exportCsv);
    $("xlsxBtn").addEventListener("click", exportXlsx);

    // 설정 창
    $("settingsForm").addEventListener("submit", function (e) { e.preventDefault(); saveSettings(); });
    $("settingsCancel").addEventListener("click", closeSettings);
    $("settingsClose").addEventListener("click", closeSettings);
    $("settings").addEventListener("cancel", function () { draft = null; });
    $("sKey").addEventListener("input", function () { if (draft) { draft.serviceKey = $("sKey").value.trim(); renderDraft(); } });
    $("sKeyShow").addEventListener("click", function () {
      var show = $("sKey").type === "password"; $("sKey").type = show ? "text" : "password"; $("sKeyShow").textContent = show ? "숨기기" : "보기";
    });
    $("sKeyTest").addEventListener("click", testKey);
    $("sKwAdd").addEventListener("click", function () { addWords("keywords", "sKwIn"); });
    function addCodes() {
      var inp = $("sCodeIn"), list = inp.value.split(/[,\s]+/).filter(Boolean), bad = [], added = 0;
      list.forEach(function (c) {
        if (!/^\d{4}$/.test(c)) { bad.push(c); return; }
        if (draft.company.codes.indexOf(c) < 0) { draft.company.codes.push(c); added++; }
      });
      inp.value = ""; renderDraft();
      toast(bad.length ? "업종코드는 숫자 4자리입니다: " + bad.join(", ") : (added ? added + "개 추가 — [저장]을 눌러야 반영됩니다" : "이미 있는 업종코드입니다"));
    }
    $("sCodeAdd").addEventListener("click", addCodes);
    $("sCodeIn").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addCodes(); } });
    $("sAuthor").addEventListener("input", function () { if (draft) { draft.company.author = $("sAuthor").value.trim(); renderDraft(); } });
    $("sExAdd").addEventListener("click", function () { addWords("excludes", "sExIn"); });
    [["sKwIn", "keywords"], ["sExIn", "excludes"]].forEach(function (p) {
      $(p[0]).addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addWords(p[1], p[0]); }
      });
    });
    $("settings").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-del]"); if (!b || !draft) return;
      var key = b.dataset.del, arr = key === "codes" ? draft.company.codes : draft[key], w = arr[+b.dataset.i];
      arr.splice(+b.dataset.i, 1); renderDraft();
      toast("'" + w + "' 삭제 — [저장]을 눌러야 반영됩니다");
    });
    $("settings").addEventListener("change", function (e) {
      var t = e.target; if (!draft) return;
      if (t.dataset.src) draft.sources[t.dataset.src] = t.checked;
      else if (t.dataset.cat) {
        var c = t.dataset.cat, i = draft.categories.indexOf(c);
        if (t.checked && i < 0) draft.categories.push(c);
        if (!t.checked && i >= 0) draft.categories.splice(i, 1);
        draft.categories.sort(function (a, b) { return C.CATEGORIES.indexOf(a) - C.CATEGORIES.indexOf(b); });
      } else if (t.id === "sAuto") draft.autoFetch = t.checked;
      else if (t.id === "sAutoMin") draft.autoFetchMinutes = +t.value;
      else if (t.id === "sKeep") draft.keepDays = +t.value;
      else if (t.id === "sSize") draft.company.size = t.value;
      else if (t.id === "sRegion") draft.company.region = t.value;
      renderDraft();
    });
    $("sExport").addEventListener("click", function () {
      var data = JSON.stringify({ app: "nara-monitor", v: 1, settings: Object.assign({}, draft, { serviceKey: $("sKey").value.trim(), _added: undefined }) });
      copyText(data).then(function () { $("sMsg").textContent = "설정을 복사했습니다. 다른 PC 에서 '설정 붙여넣기'에 넣으세요. (서비스키가 들어 있으니 다른 사람에게 보내지 마세요)"; },
        function () { $("sImportBox").hidden = false; $("sImportText").value = data; $("sImportText").select(); $("sMsg").textContent = "아래 글을 직접 복사(Ctrl+C)하세요."; });
    });
    $("sImportToggle").addEventListener("click", function () { $("sImportBox").hidden = !$("sImportBox").hidden; $("sImportText").focus(); });
    $("sImportApply").addEventListener("click", function () {
      try {
        var o = JSON.parse($("sImportText").value), st = o && o.settings;
        if (!st || !Array.isArray(st.keywords)) throw new Error();
        ["keywords", "excludes", "categories"].forEach(function (k) { if (Array.isArray(st[k])) draft[k] = C.cleanWords(st[k]); });
        if (st.sources) ["bid", "prespec", "orderplan"].forEach(function (k) { draft.sources[k] = !!st.sources[k]; });
        if (typeof st.serviceKey === "string" && st.serviceKey) { draft.serviceKey = st.serviceKey.trim(); $("sKey").value = draft.serviceKey; }
        ["autoFetch", "autoFetchMinutes", "keepDays"].forEach(function (k) { if (st[k] != null) draft[k] = st[k]; });
        if (st.company && Array.isArray(st.company.codes)) {
          draft.company = { size: st.company.size || "중기업", region: st.company.region || "", author: st.company.author || "",
                            codes: st.company.codes.filter(function (c) { return /^\d{4}$/.test(c); }) };
          $("sSize").value = draft.company.size; $("sRegion").value = draft.company.region; $("sAuthor").value = draft.company.author;
        }
        $("sAuto").checked = !!draft.autoFetch; $("sAutoMin").value = String(draft.autoFetchMinutes); $("sKeep").value = String(draft.keepDays);
        renderDraft(); $("sImportBox").hidden = true;
        $("sMsg").textContent = "설정을 불러왔습니다. 확인 후 [저장]을 누르세요.";
      } catch (e) { $("sMsg").textContent = "설정 형식이 올바르지 않습니다. '설정 복사'로 만든 글 전체를 붙여넣으세요."; }
    });
    $("sClear").addEventListener("click", function () { $("sClearConfirm").hidden = false; });
    $("sClearNo").addEventListener("click", function () { $("sClearConfirm").hidden = true; });
    $("sClearYes").addEventListener("click", function () {
      Store.clearItems().then(function () {
        S.items = []; S.meta.lastRun = null; S.meta.errors = []; Store.saveMeta(S.meta);
        $("sClearConfirm").hidden = true; $("sMsg").textContent = "저장된 공고를 모두 지웠습니다.";
        renderAll();
      });
    });

    // 테마
    var root = document.documentElement;
    function applyTheme(t) { if (t) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme"); }
    try { applyTheme(localStorage.getItem("nara-theme")); } catch (e) { /* 무시 */ }
    $("themeBtn").addEventListener("click", function () {
      var cur = root.getAttribute("data-theme");
      var dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      var next = dark ? "light" : "dark"; applyTheme(next);
      try { localStorage.setItem("nara-theme", next); } catch (e) { /* 무시 */ }
    });

    // 오래 열어 둔 탭으로 돌아오면 새 공고 확인
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { renderHeader(); maybeAutoFetch(); } });
    function topbarH() { document.documentElement.style.setProperty("--topbar-h", document.querySelector(".topbar").offsetHeight + "px"); }
    window.addEventListener("resize", topbarH); topbarH();
    setInterval(function () { if (!S.busy) renderHeader(); }, 60e3);
  }

  function loadItems() {
    return Store.allItems().then(function (items) {
      var res = rematchAndPrune(items, S.settings, new Date());
      S.items = res.keep;
      if (res.removed.length) Store.deleteItems(res.removed);
    }, function () { S.items = []; });
  }

  function start() {
    S.settings = Store.loadSettings(C.DEFAULT_SETTINGS);
    if ("aiKey" in S.settings) { delete S.settings.aiKey; Store.saveSettings(S.settings); }   // 옛 버전(1.2)에서 넣었을 수 있는 Claude API 키 정리
    S.meta = Store.loadMeta();
    $("version").textContent = "· v" + VERSION;
    S.ui.elig = S.settings.eligView || "eligible"; $("elig").value = S.ui.elig;
    $("sRegion").innerHTML = '<option value="">선택 안 함</option>' + C.REGION_NAMES.map(function (r) { return '<option value="' + r + '">' + r + "</option>"; }).join("");
    bind();
    Store.init().then(loadItems).then(function () {
      renderAll();
      maybeAutoFetch();
    });
  }

  start();
})();
