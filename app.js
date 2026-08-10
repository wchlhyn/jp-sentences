"use strict";

const DAILY_SIZE = 200;
const STALE_DAYS = 3;

/* ---------- IndexedDB ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("jp-practice", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("progress", { keyPath: "id" });
      db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => {
      if (result && "result" in result) resolve(result.result);
      else resolve(undefined);
    };
    t.onerror = () => reject(t.error);
  });
}

const Progress = {
  db: null,
  async init() { this.db = await openDb(); },
  all() { return tx(this.db, "progress", "readonly", s => s.getAll()); },
  put(rec) { return tx(this.db, "progress", "readwrite", s => s.put(rec)); },
  get(id) { return tx(this.db, "progress", "readonly", s => s.get(id)); },
  kvGet(key) { return tx(this.db, "kv", "readonly", s => s.get(key)); },
  kvPut(key, val) { return tx(this.db, "kv", "readwrite", s => s.put(val, key)); },
};

/* ---------- furigana DSL ---------- */

function parseFuri(src) {
  const segs = [];
  const re = /\[([^|\]]+)\|([^\]]+)\]|([^[]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) segs.push({ base: m[1], ruby: m[2] });
    else segs.push({ base: m[3] });
  }
  return segs;
}

function plainText(src) {
  return parseFuri(src).map(s => s.base).join("");
}

function renderJp(src, parent) {
  for (const seg of parseFuri(src)) {
    if (seg.ruby) {
      const ruby = document.createElement("ruby");
      ruby.append(seg.base);
      const rt = document.createElement("rt");
      rt.textContent = seg.ruby;
      ruby.append(rt);
      parent.append(ruby);
    } else {
      parent.append(seg.base);
    }
  }
}

/* ---------- speech ---------- */

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = "ja-JP";
  const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith("ja"));
  if (voice) utt.voice = voice;
  utt.rate = 0.9;
  speechSynthesis.speak(utt);
}
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // warm up voice list

/* ---------- daily set ---------- */

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function buildOrder(pack) {
  const recs = new Map((await Progress.all()).map(r => [r.id, r]));
  const misread = [];
  const unseen = [];
  const seen = [];
  for (const s of pack.sentences) {
    const r = recs.get(s.id);
    if (r && r.misread) misread.push(s);
    else if (!r) unseen.push(s);
    else seen.push([r.seenAt, s]);
  }
  seen.sort((a, b) => a[0] - b[0]);
  return [...misread, ...unseen, ...seen.map(x => x[1])];
}

async function getDailySet(pack) {
  const stored = await Progress.kvGet("daily");
  const byId = new Map(pack.sentences.map(s => [s.id, s]));

  if (stored && stored.date === todayKey()) {
    // keep today's progress, but top the set up when it's smaller than
    // DAILY_SIZE (cap raised, or a fresh pack landed mid-day)
    const ids = stored.ids.filter(id => byId.has(id));
    if (ids.length < DAILY_SIZE) {
      const have = new Set(ids);
      for (const s of await buildOrder(pack)) {
        if (ids.length >= DAILY_SIZE) break;
        if (!have.has(s.id)) { ids.push(s.id); have.add(s.id); }
      }
      await Progress.kvPut("daily", {
        date: stored.date, ids, pos: Math.min(stored.pos, ids.length),
      });
    }
    const sentences = ids.map(id => byId.get(id));
    if (sentences.length) {
      return { sentences, pos: Math.min(stored.pos, sentences.length) };
    }
  }

  const sentences = (await buildOrder(pack)).slice(0, DAILY_SIZE);
  await Progress.kvPut("daily", { date: todayKey(), ids: sentences.map(s => s.id), pos: 0 });
  return { sentences, pos: 0 };
}

/* ---------- UI ---------- */

const screen = document.getElementById("screen");
const navBack = document.getElementById("nav-back");
const navCount = document.getElementById("nav-count");

const App = {
  pack: null,
  daily: null,
  pos: 0,
  stage: 0,
  misreadToday: 0,

  async start() {
    await Progress.init();
    this.pack = await loadPack();
    renderFooter(this.pack);
    this.daily = await getDailySet(this.pack);
    this.pos = this.daily.pos;
    if (this.pos >= this.daily.sentences.length) this.showEnd();
    else this.showStart();
  },

  showStart() {
    navBack.hidden = true;
    navCount.textContent = "";
    screen.replaceChildren(el("div", { class: "center" }, [
      el("h1", {}, ["今日の文"]),
      el("p", {}, [`${this.daily.sentences.length} sentences today`]),
      btn("big-btn", this.pos > 0 ? "Continue" : "Start", () => this.showCard()),
    ]));
  },

  showCard() {
    const s = this.daily.sentences[this.pos];
    this.stage = 0;
    navBack.hidden = false;
    navCount.textContent = `${this.pos + 1} / ${this.daily.sentences.length}`;

    const jp = el("div", { class: "jp" });
    renderJp(s.jp, jp);
    const en = el("div", { class: "en" }, [s.en]);
    en.append(el("span", { class: "target-note" }, [`target: ${s.target}`]));

    const card = el("div", { class: "card" }, [jp, en]);
    card.addEventListener("click", () => {
      this.stage = (this.stage + 1) % 3;
      card.classList.toggle("show-furi", this.stage >= 1);
      card.classList.toggle("show-en", this.stage >= 2);
    });

    const misreadBtn = btn("", "misread ✗", async () => {
      const rec = (await Progress.get(s.id)) || { id: s.id, seenAt: 0, misread: false };
      rec.misread = !rec.misread;
      await Progress.put(rec);
      misreadBtn.classList.toggle("on", rec.misread);
    });
    Progress.get(s.id).then(r => { if (r && r.misread) misreadBtn.classList.add("on"); });

    const nextBtn = btn("primary",
      this.pos + 1 >= this.daily.sentences.length ? "finish" : "next →",
      () => this.advance(s));

    screen.replaceChildren(
      card,
      el("div", { class: "controls" }, [
        btn("", "🔊", () => speak(plainText(s.jp))),
        misreadBtn,
        nextBtn,
      ]),
      el("div", { class: "hint" }, ["tap the sentence: furigana → English → hide"]),
    );
  },

  async advance(s) {
    const rec = (await Progress.get(s.id)) || { id: s.id, misread: false };
    rec.seenAt = Date.now();
    if (rec.misread) this.misreadToday++;
    await Progress.put(rec);
    this.pos++;
    const daily = await Progress.kvGet("daily");
    daily.pos = this.pos;
    await Progress.kvPut("daily", daily);
    if (this.pos >= this.daily.sentences.length) this.showEnd();
    else this.showCard();
  },

  back() {
    if (this.pos > 0 && !navBack.hidden && screen.querySelector(".card")) {
      this.pos--;
      this.showCard();
    } else {
      this.showStart();
    }
  },

  showEnd() {
    navBack.hidden = false;
    navCount.textContent = "";
    screen.replaceChildren(el("div", { class: "center" }, [
      el("h1", {}, ["終わり 🎉"]),
      el("p", {}, [`${this.daily.sentences.length} sentences done.`]),
      el("p", {}, [this.misreadToday
        ? `${this.misreadToday} flagged misread — they'll lead tomorrow's set.`
        : "Nothing flagged misread. See you tomorrow."]),
    ]));
  },
};

navBack.addEventListener("click", () => App.back());

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function btn(cls, label, onClick) {
  const b = el("button", cls ? { class: cls } : {}, [label]);
  b.addEventListener("click", e => { e.stopPropagation(); onClick(); });
  return b;
}

/* ---------- pack + footer ---------- */

async function loadPack() {
  const res = await fetch("./pack.json");
  if (!res.ok) throw new Error(`pack.json: ${res.status}`);
  return res.json();
}

function renderFooter(pack) {
  const span = document.getElementById("pack-age");
  const generated = new Date(pack.generated_at);
  const ageDays = (Date.now() - generated.getTime()) / 86400000;
  span.textContent = `pack: ${pack.sentences.length} sentences · ${generated.toISOString().slice(0, 10)}`
    + (pack.placeholder ? " · placeholder" : "");
  if (ageDays > STALE_DAYS && !pack.placeholder) {
    span.classList.add("stale");
    span.textContent += ` · ${Math.floor(ageDays)} days old — is the pipeline running?`;
  }
}

/* ---------- boot ---------- */

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}

App.start().catch(err => {
  screen.replaceChildren(el("div", { class: "center" }, [
    el("h1", {}, ["Couldn't load"]),
    el("p", {}, [String(err)]),
  ]));
});
