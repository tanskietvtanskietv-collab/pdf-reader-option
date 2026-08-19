# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web PDF reader for Japanese architectural / construction drawings. The Node.js
backend parses an uploaded PDF, extracts the text layer **with per-glyph
geometry**, and answers searches with both a hit count and bounding box
coordinates. The Vue client renders the PDF and paints the server's coordinates
over it. Two fixed terminology dictionaries drive the search panel: **Wakugumi**
(73 terms) and **Jikugumi** (88 terms).

The server is the single source of truth for counts, coordinates, and the
dictionaries. The client is a renderer — it must never re-implement matching.

## Commands

```bash
npm run install:all           # installs server/ and client/ (no root deps)
npm run dev                   # API :3000 + Vite :5173, prefixed output
npm test                      # -> npm --prefix server test
npm run build                 # builds client/dist
npm start                     # server serves API + client/dist on :3000
```

Single test by name:

```bash
node --test --test-name-pattern "rotated labels" server/test/run-tests.mjs
npm --prefix server run fixture   # regenerate server/test/fixtures/sample.pdf
```

`npm run dev` uses [scripts/dev.mjs](scripts/dev.mjs), a dependency-free
replacement for `concurrently` — the root package.json intentionally has **no**
dependencies. Vite proxies `/api` to `API_TARGET` (default `http://127.0.0.1:3000`).

## Architecture

```
upload ──► parsePdf ──► page index (memory) ─┐
                       PDF bytes (temp disk) │
                                             ├─► searchDocument ──► counts + bounds
query ──► NFKC normalize ──► escaped regex ──┘                          │
                                                                        ▼
                            client: pdf.js canvas + absolutely positioned overlays
```

- [server/src/services/pdfParser.js](server/src/services/pdfParser.js) — pdf.js
  extraction and **all** coordinate maths. `parsePdf` walks pages; `buildPageIndex`
  is the pure function that turns pdf.js text items into the searchable index;
  `rectsForRange` projects a match range back onto boxes.
- [server/src/services/search.js](server/src/services/search.js) — regex execution,
  counting, and match → coordinate conversion. Owns no geometry of its own.
- [server/src/services/documentStore.js](server/src/services/documentStore.js) —
  the entire session cache. **Swapping in Redis means replacing only this file**;
  nothing else touches storage.
- [server/src/utils/normalize.js](server/src/utils/normalize.js) /
  [regex.js](server/src/utils/regex.js) — the two correctness-critical helpers
  (see below).
- [client/src/components/PdfViewer.vue](client/src/components/PdfViewer.vue) —
  canvas rendering, zoom, lazy page window, highlight overlay.
- [client/src/components/SearchPanel.vue](client/src/components/SearchPanel.vue) —
  dictionary rows, count badges, searched ticks. Holds only per-row *edits*;
  results live in [App.vue](client/src/App.vue) keyed by `${category}#${index}`.

## The search pipeline (the part that needs care)

Four invariants, each of which exists because of a specific failure mode:

1. **NFKC with an index map.** Page text and query are both NFKC folded so
   `ｽﾃﾝﾊﾟｲﾌﾟ`, `ステンパイプ` and `ＷＦ`/`WF` are interchangeable. A plain
   `.normalize('NFKC')` is not enough: it changes string length (`ﾊ` + `ﾟ` → `パ`
   is 2 chars → 1), so `normalizeWithMap()` returns `srcStart`/`srcEnd` arrays
   that project every normalised character back onto its **span** of source
   glyphs. Use the span, not just the start — a match ending on a composed
   character otherwise highlights one glyph short.
2. **Escape before compiling.** The dictionaries contain `(H)`, `(B)`, `+レ`,
   `24(`, `E-`, `CH=`, `NO.7`, `-180`. Never build a regex from a raw term.
   `escapeRegExp` deliberately does **not** escape `-`: it is a literal outside a
   character class, and `\-` is an invalid escape under the `u` flag, which would
   throw on `E-`, `24-` and `ｱ-ﾁﾀﾚ壁`.
3. **Line breaks are preserved.** `buildPageIndex` inserts `\n` at `hasEOL` with
   `charItem = -1`, so a term can never match across two unrelated lines.
   Whitespace *inside* a term becomes `\s*`, so `BALCONY FINE TESURI` still
   matches when the text layer drops the spaces.
4. **Glyph-weighted sub-string slicing.** pdf.js reports one advance width per
   text item, not per glyph. A match inside an item is sliced by cumulative
   weight with full-width glyphs (CJK, kana, full-width latin) counting 2× against
   half-width ones — far more accurate than an even split on mixed labels.
   Half-width katakana (U+FF61–FF9F) is weight 1; do not fold it into the
   full-width range.

Search is case-insensitive by default (`koubai yane`, `check hood` are lowercase
in the dictionary but uppercase in drawings).

## Coordinate contract

Every box the API returns is in **PDF points, top-left origin, scale 1**, i.e. a
pdf.js viewport at `{ scale: 1 }`. The client multiplies by the current zoom and
positions an overlay div — no other conversion anywhere. Keep it that way.

`rectFromRun` derives the box from the item's angle (`dir` along the baseline,
`up` towards the ascender), so rotated CAD labels produce an upright axis-aligned
box rather than a sideways one. A match spanning two text items returns one
merged `bounds` plus the individual `rects`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/pdf/upload` | `file` field; validates MIME **and** the `%PDF-` signature. Optional `previousDocId` is released server-side. |
| GET | `/api/pdf/:docId/file` | Raw bytes — what the client renders. |
| GET | `/api/pdf/:docId/page/:n` | Page geometry; `?include=text` adds the normalised text layer. Returns geometry, **not** a rasterised image (that would need a native canvas binding). |
| POST | `/api/pdf/search` | `{ docId, query, category }` → `{ totalMatches, pages[], results[] }` |
| POST | `/api/pdf/search/batch` | Whole category in one round trip; **counts only, no coordinates** — the client fetches those when a row becomes active. |
| GET | `/api/categories` | Dictionaries; the client never hardcodes them. |

Search options: `caseInsensitive` (default true), `looseSpacing` (whitespace
between every character, default false), `padding` (points, default 0.5).

## UI layout and scroll model

65 / 35 split, and **the browser window never scrolls** — `html, body, #app` are
`overflow: hidden`, `.layout` and both columns carry `overflow: hidden` plus
`min-height/min-width: 0`, and each pane owns its scroller with
`overscroll-behavior: contain`.

- Viewer opens at a **fixed 100 %** (`fitMode = 'custom'`, `zoom = 1`); fit
  width / fit page remain available from the toolbar. The scroll container uses
  block layout with `margin: 0 auto` per page — flex `align-items: center` clips
  the left edge of a page wider than the pane and makes it unreachable.
- Pages render lazily in a ±3 page window around the visible set
  (`RENDER_WINDOW`); canvases outside it are zeroed. Any zoom change invalidates
  every rendered canvas.
- Right panel: category radios + actions stay pinned, only the term list scrolls.
  Enter on a row runs that search, scrolls the viewer to the first hit, updates
  the `Found: n` badge and puts a **✓ next to the row number** (green = found,
  grey = searched with zero hits). The tick means "searched", the badge means
  "found".

## Session cache

Spatial index in process memory keyed by `docId`; PDF bytes in a `mkdtemp`
directory. Entries expire after `DOC_TTL_MS` (1 h), a sweeper runs every
`DOC_SWEEP_MS`, at most `DOC_MAX` (12) documents are kept with oldest evicted
first, a new upload releases the caller's previous `docId`, and SIGINT/SIGTERM
wipe the temp directory. `shutdown()` resets the cached temp-dir promise —
without that, any upload after a shutdown writes into a deleted directory.

Env: `PORT`, `HOST`, `MAX_UPLOAD_BYTES`, `DOC_TTL_MS`, `DOC_SWEEP_MS`, `DOC_MAX`,
`SEARCH_MAX_RESULTS`, `API_TARGET`.

## Dictionaries

[server/src/data/categories.js](server/src/data/categories.js) keeps the raw
lists verbatim from the specification — including the duplicates that exist there
(`テラス`, `VCK`) — so they stay diffable against the spec. `getCategory()`
de-duplicates while preserving order, because the UI renders one row per term.
Note that `ｱ-ﾁﾀﾚ壁` (hyphen) and `ｱｰﾁﾀﾚ壁` (prolonged sound mark) are distinct
terms after NFKC and both must survive.

## Tests

[server/test/run-tests.mjs](server/test/run-tests.mjs), `node:test`, three tiers:

1. Unit — normalisation, regex escaping, every dictionary term compiling.
2. Geometry — `buildPageIndex` fed synthetic pdf.js text items, so placement,
   sub-string offsets, weighting, cross-item matches, line-break isolation and
   rotation are covered **without pdf.js**. This is why `buildPageIndex` and
   `multiplyTransform` (a local copy of pdf.js `Util.transform`) are exported and
   why the cmap paths resolve lazily — the module must import before
   `npm install`.
3. Integration — a hand-built PDF fixture ([test/make-fixture.mjs](server/test/make-fixture.mjs))
   with a CID font (`UniJIS-UCS2-H`), half-width katakana with a separate voiced
   mark, and a rotated label. These self-skip if `pdfjs-dist` is missing.

pdf.js needs `cmaps/` and `standard_fonts/` passed explicitly or Japanese
(Adobe-Japan1) drawings decode to garbage — server resolves them from
`node_modules`, client copies them into `public/pdfjs/` via the `predev`/`prebuild`
hook in [client/scripts/copy-pdfjs-assets.mjs](client/scripts/copy-pdfjs-assets.mjs).
