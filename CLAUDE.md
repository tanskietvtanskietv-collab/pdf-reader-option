# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web PDF reader for Japanese architectural / construction drawings. The Node.js
backend parses an uploaded PDF, extracts the text layer **with per-glyph
geometry**, and answers searches with both a hit count and bounding box
coordinates. The Vue client renders the PDF and paints the server's coordinates
over it. Two fixed terminology dictionaries drive the search panel: **Wakugumi**
(73 terms) and **Jikugumi** (88 terms).

On top of search the viewer offers red pencil / check-stamp markup, and **Save as
PDF** writes those marks into a copy of the document server-side.

The server is the single source of truth for counts, coordinates, and the
dictionaries. The client is a renderer — it must never re-implement matching.

**One idea explains most of this codebase:** every position — search hits,
annotations, exported ink — is expressed in **PDF points at scale 1, top-left
origin**, and converted to pixels only at the moment of drawing. Zoom, pan, the
resizable split and the export all stay correct for free because of it. Anything
that stores a screen pixel is a bug waiting for the next zoom change.

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
dependencies.

## How the client reaches the API

[client/src/api.js](client/src/api.js) calls **relative** `/api/...` paths. In dev
the page comes from Vite, so the browser requests `localhost:5173/api/...` and the
Vite proxy forwards to the API — same origin, no CORS preflight. In production
`npm start` serves the API and `client/dist` from one origin, so the same
relative paths keep working. Seeing `:5173/api/...` in devtools is correct; that
request is answered by Express.

Three knobs, all read through `loadEnv` in [client/vite.config.js](client/vite.config.js)
so `client/.env` works (a bare `process.env.VITE_*` in a Vite config only sees
shell variables, never `.env` files — that trips people up):

| Variable | Effect |
| --- | --- |
| `VITE_API_TARGET` | Proxy destination, default `http://127.0.0.1:3000`. **Keep this on loopback** — the proxy runs inside the dev server, so a hardcoded LAN IP buys nothing and breaks on the next DHCP lease. |
| `VITE_DEV_HOST` | Set to `0.0.0.0` to expose the *client* to the LAN. This, not the proxy target, is what other devices need. |
| `VITE_API_BASE` | **Build-time.** Baked into the bundle; makes the browser call an absolute API origin directly, bypassing the proxy (the server sends `cors()` headers). Unset by default. |

`VITE_API_TARGET` is **dev-only** — it configures the dev-server proxy and has no
effect on `vite build`. A statically hosted client (Render static site, S3, Pages)
therefore needs `VITE_API_BASE`; setting `VITE_API_TARGET` there does nothing and
leaves the client requesting `/api/...` from the static host, which 404s. Only the
single-origin deployment (`npm start`, Express serving `client/dist`) needs
neither.

`strictPort: true` — a silently shifted port (5174, 5175) is the usual reason
`/api` appears to break, so the dev server fails loudly instead.

## Env files

`server/.env` and `client/.env` both exist, each mirroring a checked-in
`.env.example`; `.env` is gitignored, `.env.example` is not. The server loads its
copy through `--env-file-if-exists=.env` in the npm scripts — Node's built-in
support, no `dotenv` package. Consequences worth knowing:

- Only read **at process start**; `--watch` restarts on source edits, not on
  `.env` edits.
- A real environment variable **wins over the file**, which is what makes
  platform-injected values (Render's `PORT`) work.
- Running `node src/index.js` directly bypasses the file entirely — use
  `npm start` / `npm run dev`.
- [render.yaml](render.yaml) sets its own vars; the backend needs `HOST=0.0.0.0`
  there or the container is unreachable.
- **`HOST` must stay `0.0.0.0`, never a specific LAN IP.** Pinning one interface
  excludes `127.0.0.1` — which is exactly what the Vite proxy targets — so every
  `/api` call starts returning 500 while `netstat` still shows a listener on
  :3000. `0.0.0.0` already covers the LAN address.

## Architecture

```
upload ──► parsePdf ──► page index (memory) ─┐
                       PDF bytes (temp disk) │
                                             ├─► searchDocument ──► counts + bounds
query ──► NFKC normalize ──► escaped regex ──┘                          │
                                                                        ▼
                            client: pdf.js canvas + absolutely positioned overlays
                                                                        │
      marks drawn on the client (PDF points) ──► burnAnnotations ──► /Ink annotations
                                                        │                 │
                                          the cached original is           ▼
                                          never modified          browser save dialog
                                                                  or writeToFolder()
```

**Server**

- [pdfParser.js](server/src/services/pdfParser.js) — pdf.js extraction and **all**
  coordinate maths. `parsePdf` walks pages; `buildPageIndex` is the pure function
  that turns pdf.js text items into the searchable index; `rectsForRange`
  projects a match range back onto boxes; `openDocument` is shared with the
  annotation writer.
- [search.js](server/src/services/search.js) — regex execution, counting, and
  match → coordinate conversion. Owns no geometry of its own.
- [documentStore.js](server/src/services/documentStore.js) — the entire session
  cache. **Swapping in Redis means replacing only this file**; nothing else
  touches storage.
- [annotate.js](server/src/services/annotate.js) — writes client marks into a PDF
  copy as `/Ink` annotations, using pdf.js rather than a second PDF library.
- [exportTargets.js](server/src/services/exportTargets.js) — folder browsing and
  file writing for Save As, plus the path confinement that keeps it safe.
- [normalize.js](server/src/utils/normalize.js) / [regex.js](server/src/utils/regex.js)
  — the two correctness-critical helpers (see below).

**Client**

- [PdfViewer.vue](client/src/components/PdfViewer.vue) — canvas rendering, zoom
  (toolbar and Ctrl+wheel), hand-tool panning, the pencil / check-stamp markup
  layer, lazy page window, highlight overlay.
- [SearchPanel.vue](client/src/components/SearchPanel.vue) — dictionary rows,
  count badges, searched ticks. Holds only per-row *edits*; results live in
  [App.vue](client/src/App.vue) keyed by `${category}#${index}`.
- [SaveDialog.vue](client/src/components/SaveDialog.vue) — folder picker for when
  the browser cannot open its own; [ThemeToggle.vue](client/src/components/ThemeToggle.vue)
  — the dark / light switch.
- [api.js](client/src/api.js) — every backend call in one place, plus the
  save-dialog helpers (`pickSaveLocation`, `writePdf`).

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
| POST | `/api/pdf/:docId/export` | Save As: `{ marks: [{ page, points[], width }] }` in **viewport points** -> a PDF copy with the marks burned in as `/Ink` annotations. Streams the bytes back, or writes to disk when `destination` is given. |
| GET | `/api/folders?path=` | Folders on the server machine for the save dialog; empty `path` = drives + shortcuts. |
| GET | `/api/folders/enabled` | Whether server-side saving is on, and its root. |
| GET | `/api/categories` | Dictionaries; the client never hardcodes them. |

Search options: `caseInsensitive` (default true), `looseSpacing` (whitespace
between every character, default false), `padding` (points, default 0.5).

## Theming

Two palettes, one token set, in [client/src/styles.css](client/src/styles.css):
`:root` / `:root[data-theme='light']` is light, `:root[data-theme='dark']` is
dark. **Components must only reference tokens** — a raw hex in a component is a
bug in one of the two themes. The few deliberate exceptions are things that sit
on the always-white PDF page: the annotation red, the search highlight yellow /
orange, and the page placeholder.

- [ThemeToggle.vue](client/src/components/ThemeToggle.vue) is a `role="switch"`
  button. **Light is the default and the OS preference is deliberately ignored**
  — a machine set to dark still opens the app light. Dark applies only when the
  user picked it here, and that choice is remembered in localStorage. Do not
  reintroduce a `prefers-color-scheme` check: only the stored value may select
  dark.
- The inline script in [client/index.html](client/index.html) sets
  `data-theme` **before first paint** from the same storage key, so there is no
  flash of the wrong theme. It repeats the default-light rule, so a change to
  the rule has to be made in both places — key and logic.
- `--viewer-bg` exists separately from `--surface-2` because white pages need a
  darker ground in light mode or they disappear into the pane.

## UI layout and scroll model

Split defaults to **85 / 15** (viewer / search panel) and is user-draggable — see
below. **The browser window never scrolls** — `html, body, #app` are
`overflow: hidden`, `.layout` and both columns carry `overflow: hidden` plus
`min-height/min-width: 0`, and each pane owns its scroller with
`overscroll-behavior: contain`.

- Viewer opens at a **fixed 100 %** (`fitMode = 'custom'`, `zoom = 1`); fit
  width / fit page remain available from the toolbar. The scroll container uses
  block layout with `margin: 0 auto` per page — flex `align-items: center` clips
  the left edge of a page wider than the pane and makes it unreachable.
- **Annotations** (`tool` = `pan` | `pencil` | `check`). Pencil draws red
  freehand, the check stamp drops a red tick where you click, and both take the
  thickness from the toolbar `select`. Marks are stored **in PDF points at scale
  1** — the same contract as search hits — and rendered into a per-page
  `<svg viewBox="0 0 pageW pageH">` sized to the page box, so the browser scales
  them with the zoom and they stay welded to the drawing instead of drifting.
  Storing screen pixels here would be the obvious mistake. The SVG is
  `pointer-events: none`; the scroll container owns all pointer handling.
  Strokes lock to the page they started on (`pdfPointAt(..., lockedIndex)`), and
  points are pushed rather than copied — `ref()` is deeply reactive, and
  rebuilding the array per `pointermove` makes a long stroke quadratic.
  Annotations live in memory only and are cleared when a new document loads —
  until **Save as PDF**, which posts them to `POST /api/pdf/:docId/export`.
- **Shortcuts** (window `keydown` in `PdfViewer`): `Esc` returns to the hand tool
  and discards any half-drawn stroke; `Ctrl/Cmd+Z` undoes, `Ctrl/Cmd+Y` (and
  `Ctrl+Shift+Z`, since Cmd+Y is not redo on macOS) redoes. The handler bails out
  via `isTypingTarget()` when focus is in an input/textarea/select — otherwise
  Ctrl+Z in a search-panel term field would delete a drawn mark instead of
  undoing the typing. Drawing a new mark drops the redo stack; `Clear` pushes the
  marks onto it **reversed**, so repeated redo restores them in draw order.
- **Hand tool.** Hovering the page area shows `cursor: grab`, and holding the
  left button drags the document (`grabbing` while held). Each `pointermove`
  scrolls to `origin.scroll - (client - origin.client)` — computed from the drag
  origin, never accumulated, so hitting a scroll edge and dragging back resumes
  exactly instead of drifting. `pointerType === 'touch'` is skipped: touch
  devices already pan natively and handling both moves the page twice.
- **Ctrl/Cmd + wheel zooms the viewer**, and only the viewer: the listener lives
  on `.viewer-scroll` and is registered with `{ passive: false }` by hand,
  because `preventDefault()` (which suppresses the browser's own page zoom) is
  ignored on a passive listener. A plain wheel is never touched, so normal
  scrolling still works.
- Zoom is **cursor-anchored** via `zoomAt()`: the PDF point under the pointer is
  read *before* the change and the scroll offset is corrected *after*
  `nextTick()`, from the element's fresh rect. Two subtleties keep a fast wheel
  burst from drifting — `pointOn()` derives the current scale from
  `rect.width / page.width` rather than `scale.value` (which is already newer
  than the flushed layout), and a `zoomToken` lets only the newest zoom of a
  burst apply its correction. Toolbar +/−/100 % go through the same path,
  anchored on the viewport centre.
- Pages render lazily in a ±3 page window around the visible set
  (`RENDER_WINDOW`); canvases outside it are zeroed. A zoom change stretches the
  existing bitmaps immediately and debounces the sharp re-render by 110 ms —
  re-rendering per wheel tick would thrash, and clearing first would flash the
  placeholder.
- The divider between the panes is a `role="separator"` element in
  [App.vue](client/src/App.vue) driving `grid-template-columns: 1fr 6px {n}%`
  inline. `clampPanel()` enforces 10–60 % **and** a 180 px floor — the pixel floor
  is why the 15 % default only survives on windows ≥ 1200 px. Width persists to
  localStorage; double click resets, arrow keys nudge when focused. Pointer
  capture on `pointerdown` is what keeps the drag alive over the canvas.
- `PdfViewer`'s `ResizeObserver` is debounced 120 ms for this reason: without it,
  dragging the divider while a fit mode is active re-renders every canvas on
  every `pointermove`.
- Right panel: category radios + actions stay pinned, only the term list scrolls.
  Enter on a row runs that search, scrolls the viewer to the first hit, updates
  the `Found: n` badge and puts a **✓ next to the row number** (green = found,
  grey = searched with zero hits). The tick means "searched", the badge means
  "found".

## Saving an annotated copy

[server/src/services/annotate.js](server/src/services/annotate.js) writes the marks
with **pdf.js itself** — no `pdf-lib`, no second PDF library. Marks go into
`doc.annotationStorage` under keys prefixed `pdfjs_internal_editor_` with
`annotationType: 15` (`AnnotationEditorType.INK`), then `doc.saveDocument()`
appends them as an incremental update, leaving the original bytes and the text
layer intact (the export re-parses and still searches identically).

Two things are easy to get wrong here:

- **Coordinates.** Marks arrive in viewport space (top-left origin); PDF user
  space is bottom-left. `viewport.convertToPdfPoint()` does the conversion *and*
  handles a page /Rotate, which hand-rolled arithmetic would get wrong on rotated
  drawings.
- **The `paths.lines` shape.** pdf.js reads the first point from indices 4/5,
  then one 6-slot group per point; slot 0 must be `NaN` for a lineTo, or the
  numbers are consumed as bezier control points instead.

The cached original is never modified, so searching and re-exporting keep working
off the untouched file.

**The destination is always chosen before anything is written**, by one of two
routes:

1. `showSaveFilePicker` when the page is in a **secure context** (https, or
   localhost). It must be opened straight off the click — it needs that click's
   transient user activation, and building the file first would consume it.
2. Otherwise [SaveDialog.vue](client/src/components/SaveDialog.vue) browses
   folders **on the server machine** via `GET /api/folders` and the server writes
   the file ([exportTargets.js](server/src/services/exportTargets.js)).

Route 2 is an HTTP-driven filesystem write. By default it is **unconfined** —
`listFolders` serves the drive list at the top level plus Desktop/Documents/
Downloads/Home shortcuts, so it behaves like a desktop Save As. `EXPORT_ROOT`
confines it to one tree, `EXPORT_ENABLED=false` disables it. File names are
always reduced to a basename and forced to `.pdf`, and an existing file 409s
unless `overwrite` is set.

In **confined** mode the Windows trap matters: `path.resolve(root, 'C:Windows')`
resolves a drive-relative path against the *process cwd*, not the root, and
`path.relative` then reports an innocent-looking result — so `resolveFolder()`
rejects absolute, UNC and drive-qualified inputs **before** resolving.

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

[server/test/run-tests.mjs](server/test/run-tests.mjs), `node:test`, 37 tests in
four tiers. Everything except tier 3 runs without `node_modules`:

1. Unit — normalisation, regex escaping, every dictionary term compiling.
2. Geometry — `buildPageIndex` fed synthetic pdf.js text items, so placement,
   sub-string offsets, weighting, cross-item matches, line-break isolation and
   rotation are covered **without pdf.js**. This is why `buildPageIndex` and
   `multiplyTransform` (a local copy of pdf.js `Util.transform`) are exported and
   why the cmap paths resolve lazily — the module must import before
   `npm install`.
3. Integration — a hand-built PDF fixture ([test/make-fixture.mjs](server/test/make-fixture.mjs))
   with a CID font (`UniJIS-UCS2-H`), half-width katakana with a separate voiced
   mark, and a rotated label. These self-skip if `pdfjs-dist` is missing. The
   export tests live here too: marks burn in as `/Ink`, land in the right place
   after the top-left → bottom-left flip, and **the exported file is re-parsed
   and searched** to prove the text layer survived.
4. Save targets — path confinement and file-name sanitising for
   [exportTargets.js](server/src/services/exportTargets.js). The confinement test
   walks twelve escape shapes (`..`, UNC, `D:\`, and the drive-relative
   `C:Windows` that slips past a naive resolve-then-check). It sets
   `EXPORT_ROOT` itself, so remember to `delete process.env.EXPORT_ROOT` in any
   test that expects the default unconfined behaviour.

pdf.js needs `cmaps/` and `standard_fonts/` passed explicitly or Japanese
(Adobe-Japan1) drawings decode to garbage — server resolves them from
`node_modules`, client copies them into `public/pdfjs/` via the `predev`/`prebuild`
hook in [client/scripts/copy-pdfjs-assets.mjs](client/scripts/copy-pdfjs-assets.mjs).
