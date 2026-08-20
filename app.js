"use strict";

const STALE_DAYS = 3;
const TIERS = ["new", "struggle", "mid"];
const DEFAULT_RATIO = { new: 30, struggle: 30, mid: 40 };
const HISTORY_MAX = 1500;

/* ---------- IndexedDB ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("jp-practice", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("progress"))
        db.createObjectStore("progress", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("writing"))
        db.createObjectStore("writing", { keyPath: "kanji" });
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

/* ---------- writing drill tab ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const REVISIT_AFTER_MS = 2 * 86400000;

const Writing = {
  data: null,
  flags: new Map(),

  async fetchSheet() {
    if (this.data) return;
    try {
      const res = await fetch("./writing.json");
      this.data = res.ok ? await res.json() : null;
    } catch { this.data = null; }
  },

  async show() {
    App.view = "writing";
    navBack.hidden = true;
    navCount.textContent = "";
    await this.fetchSheet();
    if (!this.data) {
      screen.replaceChildren(el("div", { class: "center" },
        [el("p", {}, ["No writing sheet published yet."])]));
      return;
    }
    const flagRecs = (await tx(Progress.db, "writing", "readonly", s => s.getAll())) || [];
    this.flags = new Map(flagRecs.map(f => [f.kanji, f]));

    // flagged words resurface locally after a cooldown, ahead of the sheet;
    // the box never learns about the flag
    const sheetWords = new Set(this.data.sheet.map(e => e.word));
    const revisits = flagRecs
      .filter(f => f.entry && !sheetWords.has(f.entry.word)
        && Date.now() - f.flaggedAt >= REVISIT_AFTER_MS)
      .map(f => ({ ...f.entry, _revisit: true }));

    const nKanji = this.data.sheet.reduce((a, e) => a + e.kanji.length, 0);
    const list = el("div", { class: "wlist" });
    const gen = new Date(this.data.generated_at);
    const head = el("div", { class: "whead" },
      [`sheet ${this.data.generated_at.slice(0, 10)} · ${this.data.sheet.length} words · ${nKanji} kanji`
       + (revisits.length ? ` · ${revisits.length} revisit` : "")]);
    if ((Date.now() - gen.getTime()) / 86400000 > STALE_DAYS) {
      head.classList.add("stale");
      head.textContent += " — stale!";
    }
    list.append(head);
    for (const e of [...revisits, ...this.data.sheet]) list.append(this.card(e));
    list.append(el("div", { class: "hint" },
      ["tap a card: kanji + parts → stroke order → hide"]));
    screen.replaceChildren(list);
  },

  card(e) {
    let stage = 0;
    const prompt = el("div", { class: "wprompt" }, [
      el("span", { class: "wreading" }, [e.reading]),
      el("span", { class: "wmeaning" }, [`  /  ${e.meaning}`]),
      ...(e._revisit ? [el("span", { class: "wrevisit" }, [" ↻"])] : []),
    ]);
    const reveal = el("div", { class: "wreveal" });
    const strokes = el("div", { class: "wstrokes" });
    reveal.hidden = strokes.hidden = true;

    const flagBtn = btn("", "couldn't recall", async () => {
      if (this.flags.has(e.word)) {
        await tx(Progress.db, "writing", "readwrite", s => s.delete(e.word));
        this.flags.delete(e.word);
        flagBtn.classList.remove("on");
      } else {
        const entry = { ...e };
        delete entry._revisit;
        // store keyPath is "kanji" for historical reasons; the key is the word
        const rec = { kanji: e.word, flaggedAt: Date.now(), entry };
        await tx(Progress.db, "writing", "readwrite", s => s.put(rec));
        this.flags.set(e.word, rec);
        flagBtn.classList.add("on");
      }
    });
    if (this.flags.has(e.word)) flagBtn.classList.add("on");

    const card = el("div", { class: "card wcard" }, [
      prompt, reveal, strokes,
      el("div", { class: "controls wcontrols" }, [flagBtn]),
    ]);
    card.addEventListener("click", () => {
      stage = (stage + 1) % 3;
      if (stage === 1 && !reveal.childNodes.length) {
        for (const kb of e.kanji) {
          const block = el("div", { class: "wkblock" }, [
            el("div", { class: "wkanji" }, [kb.kanji]),
            el("div", { class: "wkinfo" }, [
              el("div", { class: "wcomp" }, [kb.components || "(no breakdown yet)"]),
              ...(kb.note ? [el("div", { class: "wnote" }, [kb.note])] : []),
            ]),
          ]);
          reveal.append(block);
        }
      }
      if (stage === 2 && !strokes.childNodes.length) this.buildStrokes(e, strokes);
      reveal.hidden = stage < 1;
      strokes.hidden = stage !== 2;
      if (stage === 2) this.animate(strokes);
    });
    return card;
  },

  buildStrokes(e, host) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let any = false;
    for (const kb of e.kanji) {
      if (!kb.strokes || !kb.strokes.length) continue;
      any = true;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 109 109");
      svg.classList.add("wsvg");
      for (const d of kb.strokes) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        p.classList.add(reduced ? "wink-static" : "wunder");
        svg.append(p);
      }
      if (reduced) {
        kb.strokes.forEach((d, i) => {
          const m = /M\s*([\d.]+)[,\s]+([\d.]+)/.exec(d);
          if (!m) return;
          const t = document.createElementNS(SVG_NS, "text");
          t.setAttribute("x", m[1]);
          t.setAttribute("y", m[2]);
          t.classList.add("wnum");
          t.textContent = String(i + 1);
          svg.append(t);
        });
      } else {
        for (const d of kb.strokes) {
          const p = document.createElementNS(SVG_NS, "path");
          p.setAttribute("d", d);
          p.classList.add("wink");
          svg.append(p);
        }
      }
      host.append(svg);
    }
    if (!any) {
      host.append(el("div", { class: "wnote" }, ["no stroke data for this word"]));
    } else if (!reduced) {
      host.append(btn("", "▶ replay", () => this.animate(host)));
    }
  },

  animate(host) {
    // strokes animate across all kanji of the word, left to right
    const inks = [...host.querySelectorAll(".wink")];
    if (!inks.length) return;
    for (const p of inks) {
      const len = p.getTotalLength();
      p.style.transition = "none";
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
    }
    host.getBoundingClientRect(); // flush styles before animating
    inks.forEach((p, i) => {
      setTimeout(() => {
        p.style.transition = "stroke-dashoffset 250ms ease";
        p.style.strokeDashoffset = "0";
      }, 80 + i * 400);
    });
  },
};

/* ---------- tabs ---------- */

const screen = document.getElementById("screen");
const navBack = document.getElementById("nav-back");
const navCount = document.getElementById("nav-count");
const tabSent = document.getElementById("tab-sent");
const tabWrite = document.getElementById("tab-write");
navBack.addEventListener("click", () => App.back());

function switchTab(tab) {
  Progress.kvPut("tab", tab);
  tabSent.classList.toggle("active", tab !== "write");
  tabWrite.classList.toggle("active", tab === "write");
  if (tab === "write") Writing.show();
  else App.showStart();
}
tabSent.addEventListener("click", () => switchTab("sent"));
tabWrite.addEventListener("click", () => switchTab("write"));

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

App.load().then(async () => {
  const tab = await Progress.kvGet("tab");
  switchTab(tab === "write" ? "write" : "sent");
}).catch(err => {
  screen.replaceChildren(el("div", { class: "center" }, [
    el("h1", {}, ["Couldn't load"]),
    el("p", {}, [String(err)]),
  ]));
});
