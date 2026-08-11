"use strict";

const STALE_DAYS = 3;
const TIERS = ["new", "struggle", "mid"];
const DEFAULT_RATIO = { new: 30, struggle: 30, mid: 40 };
const HISTORY_MAX = 1500;

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

/* ---------- drawing ---------- */

function tierOf(s) {
  return TIERS.includes(s.tier) ? s.tier : "mid";
}

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function weightedTier(available, ratio) {
  const weights = available.map(t => Math.max(0, Number(ratio[t]) || 0));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return available[Math.floor(Math.random() * available.length)];
  let r = Math.random() * total;
  for (let i = 0; i < available.length; i++) {
    r -= weights[i];
    if (r <= 0) return available[i];
  }
  return available[available.length - 1];
}

const App = {
  pack: null,
  history: { ids: [], pos: -1 },
  ratio: { ...DEFAULT_RATIO },
  stage: 0,
  view: "start",
  unseenLeft: null,

  byId(id) { return this._byId.get(id); },

  async load() {
    await Progress.init();
    this.pack = await loadPack();
    this._byId = new Map(this.pack.sentences.map(s => [s.id, s]));
    renderFooter(this.pack);
    this.ratio = (await Progress.kvGet("ratio")) || { ...DEFAULT_RATIO };
    const hist = await Progress.kvGet("history");
    if (hist && Array.isArray(hist.ids)) {
      hist.ids = hist.ids.filter(id => this._byId.has(id));
      hist.pos = Math.min(hist.pos, hist.ids.length - 1);
      this.history = hist;
    }
  },

  async persist() {
    if (this.history.ids.length > HISTORY_MAX) {
      const drop = this.history.ids.length - HISTORY_MAX;
      this.history.ids.splice(0, drop);
      this.history.pos -= drop;
    }
    await Progress.kvPut("history", this.history);
  },

  async draw() {
    const recs = new Map((await Progress.all()).map(r => [r.id, r]));
    const inHist = new Set(this.history.ids.slice(-5)); // avoid immediate repeats

    // misread flags resurface first, once per day each
    const misread = this.pack.sentences.filter(s => {
      const r = recs.get(s.id);
      return r && r.misread && (r.seenAt || 0) < todayStart() && !inHist.has(s.id);
    });
    if (misread.length) {
      this.unseenLeft = this.countUnseen(recs);
      return misread[Math.floor(Math.random() * misread.length)];
    }

    const unseenBy = { new: [], struggle: [], mid: [] };
    for (const s of this.pack.sentences) {
      if (!recs.has(s.id) && !inHist.has(s.id)) unseenBy[tierOf(s)].push(s);
    }
    this.unseenLeft = TIERS.reduce((a, t) => a + unseenBy[t].length, 0);
    const available = TIERS.filter(t => unseenBy[t].length);
    if (available.length) {
      const pool = unseenBy[weightedTier(available, this.ratio)];
      return pool[Math.floor(Math.random() * pool.length)];
    }

    // everything seen: least-recently-seen repeats
    const seen = this.pack.sentences
      .filter(s => recs.has(s.id) && !inHist.has(s.id))
      .sort((a, b) => (recs.get(a.id).seenAt || 0) - (recs.get(b.id).seenAt || 0));
    const cand = seen.slice(0, 20);
    return cand.length ? cand[Math.floor(Math.random() * cand.length)] : null;
  },

  countUnseen(recs) {
    let n = 0;
    for (const s of this.pack.sentences) if (!recs.has(s.id)) n++;
    return n;
  },

  async next() {
    const current = this.history.ids[this.history.pos];
    if (current) {
      const rec = (await Progress.get(current)) || { id: current, misread: false };
      rec.seenAt = Date.now();
      await Progress.put(rec);
    }
    if (this.history.pos < this.history.ids.length - 1) {
      this.history.pos++;
    } else {
      const s = await this.draw();
      if (!s) { this.showEmpty(); return; }
      this.history.ids.push(s.id);
      this.history.pos++;
    }
    await this.persist();
    this.showCard();
  },

  async prev() {
    if (this.history.pos > 0) {
      this.history.pos--;
      await this.persist();
      this.showCard();
    } else {
      this.showStart();
    }
  },

  back() {
    if (this.view === "card") this.prev();
    else this.showStart();
  },

  /* ---------- screens ---------- */

  async showStart() {
    this.view = "start";
    navBack.hidden = true;
    navCount.textContent = "";
    const recs = new Map((await Progress.all()).map(r => [r.id, r]));
    const counts = { new: 0, struggle: 0, mid: 0 };
    for (const s of this.pack.sentences) if (!recs.has(s.id)) counts[tierOf(s)]++;

    const ratioRow = el("div", { class: "ratio-row" });
    for (const t of TIERS) {
      const input = el("input", {
        type: "number", min: "0", max: "100", inputmode: "numeric",
        value: String(this.ratio[t] ?? 0),
      });
      input.addEventListener("change", async () => {
        this.ratio[t] = Math.max(0, Number(input.value) || 0);
        await Progress.kvPut("ratio", this.ratio);
      });
      ratioRow.append(el("label", {}, [
        el("span", {}, [`${t} (${counts[t]})`]), input,
      ]));
    }

    screen.replaceChildren(el("div", { class: "center" }, [
      el("h1", {}, ["今日の文"]),
      el("p", {}, [`${counts.new + counts.struggle + counts.mid} unseen sentences`]),
      el("p", { class: "hint" }, ["draw ratio"]),
      ratioRow,
      btn("big-btn", this.history.pos >= 0 ? "Continue" : "Start", () => {
        if (this.history.pos >= 0) this.showCard();
        else this.next();
      }),
    ]));
  },

  showCard() {
    this.view = "card";
    const s = this.byId(this.history.ids[this.history.pos]);
    if (!s) { this.showStart(); return; }
    this.stage = 0;
    navBack.hidden = false;
    const left = this.unseenLeft !== null ? ` · ${this.unseenLeft} left` : "";
    navCount.textContent = `#${this.history.pos + 1}${left}`;

    const jp = el("div", { class: "jp" });
    renderJp(s.jp, jp);
    const en = el("div", { class: "en" }, [s.en]);
    en.append(el("span", { class: "target-note" },
      [`target: ${s.target} · ${tierOf(s)}`]));

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

    const prevBtn = btn("", "←", () => this.prev());
    if (this.history.pos === 0) prevBtn.disabled = true;

    screen.replaceChildren(
      card,
      el("div", { class: "controls" }, [
        prevBtn,
        btn("", "🔊", () => speak(plainText(s.jp))),
        misreadBtn,
        btn("primary", "next →", () => this.next()),
      ]),
      el("div", { class: "hint" }, ["tap the sentence: furigana → English → hide"]),
    );
  },

  showEmpty() {
    this.view = "end";
    navBack.hidden = false;
    navCount.textContent = "";
    screen.replaceChildren(el("div", { class: "center" }, [
      el("h1", {}, ["終わり 🎉"]),
      el("p", {}, ["Nothing left to draw — the pack is empty."]),
    ]));
  },
};

const screen = document.getElementById("screen");
const navBack = document.getElementById("nav-back");
const navCount = document.getElementById("nav-count");
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

App.load().then(() => App.showStart()).catch(err => {
  screen.replaceChildren(el("div", { class: "center" }, [
    el("h1", {}, ["Couldn't load"]),
    el("p", {}, [String(err)]),
  ]));
});
