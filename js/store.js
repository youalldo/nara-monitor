/* 브라우저 저장소
 *  - 수집한 공고: IndexedDB (용량 넉넉함)
 *  - 설정·조회 기록: localStorage
 * 저장소를 쓸 수 없는 환경(사생활 보호 창 등)에서는 메모리에만 두고 계속 동작한다.
 */
(function (root) {
  "use strict";
  var DB_NAME = "nara-monitor", DB_VER = 1, STORE = "items";
  var SETTINGS_KEY = "nara.settings.v1", META_KEY = "nara.meta.v1";
  var dbPromise = null, memory = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error("IndexedDB 없음"));
      var req;
      try { req = root.indexedDB.open(DB_NAME, DB_VER); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("저장소가 다른 탭에서 사용 중입니다")); };
    }).catch(function (e) {
      memory = memory || {};
      throw e;
    });
    return dbPromise;
  }

  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode), store = tx.objectStore(STORE), req = fn(store);
        tx.oncomplete = function () { resolve(req && "result" in req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  var Store = {
    persistent: true,

    init: function () {
      return openDb().then(function () { Store.persistent = true; }, function () { Store.persistent = false; });
    },
    allItems: function () {
      if (!Store.persistent) return Promise.resolve(Object.keys(memory).map(function (k) { return memory[k]; }));
      return run("readonly", function (s) { return s.getAll(); }).then(function (r) { return r || []; });
    },
    putItems: function (items) {
      if (!items.length) return Promise.resolve();
      if (!Store.persistent) { items.forEach(function (i) { memory[i.id] = i; }); return Promise.resolve(); }
      return run("readwrite", function (s) { items.forEach(function (i) { s.put(i); }); });
    },
    deleteItems: function (ids) {
      if (!ids.length) return Promise.resolve();
      if (!Store.persistent) { ids.forEach(function (id) { delete memory[id]; }); return Promise.resolve(); }
      return run("readwrite", function (s) { ids.forEach(function (id) { s.delete(id); }); });
    },
    clearItems: function () {
      if (!Store.persistent) { memory = {}; return Promise.resolve(); }
      return run("readwrite", function (s) { return s.clear(); });
    },

    loadSettings: function (defaults) {
      var saved = readJson(SETTINGS_KEY) || {};
      var out = JSON.parse(JSON.stringify(defaults));
      Object.keys(saved).forEach(function (k) {
        if (saved[k] == null) return;
        if (k === "sources" && typeof saved[k] === "object") Object.assign(out.sources, saved[k]);
        else out[k] = saved[k];
      });
      return out;
    },
    saveSettings: function (s) { return writeJson(SETTINGS_KEY, s); },
    loadMeta: function () { return readJson(META_KEY) || {}; },
    saveMeta: function (m) { return writeJson(META_KEY, m); }
  };

  function readJson(key) {
    try { var t = root.localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch (e) { return null; }
  }
  function writeJson(key, val) {
    try { root.localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  root.NaraStore = Store;
})(typeof self !== "undefined" ? self : this);
