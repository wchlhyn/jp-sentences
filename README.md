# JP Sentences (PWA)

Static daily Japanese sentence-practice app. Served from GitHub Pages; reads
`pack.json` (published nightly by the pipeline box) and keeps all progress in
IndexedDB on the device. No backend, no accounts — if the pipeline dies, the
site keeps working with stale content (the footer turns amber after 3 days).

- Tap a sentence: furigana → English + target word → hide.
- 12 sentences a day, misread-flagged ones resurface first, then unseen.
- 🔊 uses on-device `speechSynthesis` (ja-JP).
- Works offline via a service worker; `pack.json` is network-first with cache
  fallback.

`pack.json` currently contains placeholder sentences (`"placeholder": true`);
the pipeline replaces it with generated content.

## Deploy

Enable GitHub Pages on this repo, branch `main`, root directory. Then on iOS:
open the URL in Safari → Share → Add to Home Screen.

## Local preview

```sh
python3 -m http.server 8080
```

## Writing drill

The 書 tab is a daily handwriting sheet (`writing.json`): recall prompts for
kanji from mature Anki vocabulary, with component breakdowns and stroke-order
animations. "Couldn't recall" flags stay in IndexedDB and resurface locally
after two days — the box never sees them.

Stroke data is from [KanjiVG](https://kanjivg.tagaini.net/) by Ulrich Apel,
licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
