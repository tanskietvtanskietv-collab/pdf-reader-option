# PDF Term Reader — Wakugumi / Jikugumi

Web based PDF reader that parses construction drawings on a Node.js backend, runs
full text search over the extracted text layer, and returns **hit counts plus
bounding box coordinates** that the Vue client paints over the rendered page.
Drawings can then be marked up — freehand, shapes, pasted screenshots — and
saved as a new PDF.

```
client (Vue 3, Vite)                     server (Express, pdf.js)
┌──────────────────────────┬────────┐    ┌──────────────────────────────────┐
│ PDF viewer  85%          │search  │    │ POST /api/pdf/upload  parse+cache│
│  canvas + highlights     │ panel  │ ─► │ POST /api/pdf/search  NFKC+regex │
│  zoom / pan / markup     │ 15%    │ ◄─ │ POST /api/pdf/../export  Ink+img │
└──────────────────────────┴────────┘    └──────────────────────────────────┘
       drag the divider ⇔ both sides resize
```

**What it does**

- Full text search of two fixed dictionaries — **Wakugumi** (73 terms) and
  **Jikugumi** (88 terms) — with per-term hit counts and highlighted boxes.
- Japanese-aware matching: half-width and full-width kana, `ＷＦ`/`WF`, and terms
  full of regex characters like `(H)`, `24-`, `CH=` and `+レ` all just work.
- Viewer: fixed 100 % start, Ctrl+wheel zoom, hand-tool panning, lazy page
  rendering, a resizable split, and a progress panel while a drawing loads.
- Markup: red pencil, check stamp, rectangle and circle, with selectable
  thickness. Shapes can be selected, moved, resized and deleted; undo/redo
  covers every edit.
- **Paste a screenshot** with Ctrl+V — Snipping Tool captures included — then
  move and resize it like any other shape.
- **Save as PDF** writes the marks into a copy as real PDF annotations; the
  original and its search index are never touched.
- Light theme by default, with a dark mode you can switch on.

## Quick start

```bash
npm run install:all     # root + server + client dependencies
npm run dev             # API on :3000, Vite dev server on :5173
```

Open http://localhost:5173. The client requests **relative** `/api/...` paths, so
in dev the browser shows `localhost:5173/api/...` and the Vite proxy forwards it to
the API on :3000 — same origin, no CORS preflight. That is expected. See
[client/.env.example](client/.env.example) to change the proxy target, expose the
dev server on the LAN, or bypass the proxy with an absolute API origin.

For a single-process deployment:

```bash
npm run build           # builds client/dist
npm start               # server serves the API *and* the built client on :3000
```

Tests (`npm --prefix server test`) cover the dictionaries, NFKC normalisation,
regex escaping, and the coordinate maths. The pdf.js integration tests skip
themselves automatically until `npm install` has run in `server/`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/pdf/upload` | `multipart/form-data` with `file` (and optional `previousDocId`). Validates the MIME type *and* the `%PDF-` signature, extracts every text item with its position, caches the spatial index. → `{ docId, totalPages, fileName, byteSize, parseMs, pages[] }` |
| `GET` | `/api/pdf/:docId` | Document metadata and per page geometry. |
| `GET` | `/api/pdf/:docId/file` | Raw PDF stream (range requests supported) — what the client viewer renders. |
| `GET` | `/api/pdf/:docId/page/:pageNumber` | Page geometry for the viewer; `?include=text` also returns the normalised text layer. |
| `POST` | `/api/pdf/search` | `{ docId, query, category }` → `{ query, totalMatches, pages[], results[] }` |
| `POST` | `/api/pdf/search/batch` | `{ docId, category }` → one count row per dictionary term, in a single round trip. |
| `POST` | `/api/pdf/:docId/export` | **Save As.** `{ marks: [...] }` -> a copy of the PDF with the marks burned in: `{ page, points[], width }` becomes an `/Ink` annotation, `{ page, x, y, w, h, image }` an embedded `/Stamp` image. With `destination` + `fileName` the server writes it into that folder instead of streaming it back. The cached original is untouched. |
| `GET` | `/api/folders?path=` | Sub-folders of a directory on the server machine, for the save dialog. An empty `path` returns the drive list plus Desktop/Documents/Downloads shortcuts. Restricted to `EXPORT_ROOT` when that is set. |
| `GET` | `/api/folders/enabled` | Whether server-side saving is available, and the root it is confined to. |
| `DELETE` | `/api/pdf/:docId` | Drops the cached index and the temp file. |
| `GET` | `/api/categories` | The two dictionaries (single source of truth for client and server). |
| `GET` | `/api/health` | Uptime, cached document count, heap usage. |

### Search response

```jsonc
{
  "query": "ｽﾃﾝﾊﾟｲﾌﾟ",
  "normalizedQuery": "ステンパイプ",
  "totalMatches": 4,
  "pages": [1, 3],
  "results": [
    {
      "page": 1,
      "index": 0,
      "text": "ステンパイプ",
      "bounds": { "x": 120.4, "y": 331.8, "width": 61.2, "height": 12.5 },
      "rects": [ /* one box per text item the match spans */ ]
    }
  ],
  "truncated": false
}
```

Coordinates are in **PDF points, top-left origin, scale 1**, matching a pdf.js
viewport at `{ scale: 1 }`. The client multiplies by its current zoom factor —
no further conversion is needed.

Options accepted by both search endpoints: `caseInsensitive` (default `true`),
`looseSpacing` (allow whitespace between every character, default `false`) and
`padding` (bounding box padding in points, default `0.5`).

## How the matching works

1. **Extraction** — pdf.js `getTextContent()` gives text items with a text
   matrix. Combined with the page viewport transform, each item lands in
   top-left screen space; `cmaps/` and `standard_fonts/` are passed explicitly so
   Adobe-Japan1 encoded drawings decode correctly.
2. **Normalisation** — page text and query are both NFKC folded, so `ｽﾃﾝﾊﾟｲﾌﾟ`,
   `ステンパイプ` and `ＷＦ`/`WF` are interchangeable. `normalizeWithMap()` keeps an
   index map, because NFKC changes string length (`ﾊ` + `ﾟ` → `パ`) and the match
   still has to be projected back onto the original glyphs.
3. **Regex** — every term is escaped before compilation, so `(H)`, `(B)`, `+レ`,
   `24(`, `E-`, `CH=` and `NO.7` match literally instead of throwing or matching
   the wrong thing. Whitespace inside a term becomes `\s*`, which keeps
   `BALCONY FINE TESURI` findable when the text layer drops the spaces.
   Line breaks are preserved in the index so a term never matches across lines.
4. **Bounding boxes** — a match is sliced out of its text item by cumulative
   glyph advance, weighting full-width glyphs 2× against half-width ones. Matches
   spanning two text items produce one `bounds` plus the individual `rects`.
   Rotated labels (vertical CAD dimensions) are handled through the item angle,
   so the returned box stays axis aligned and upright.

## Markup and saving

The markup tools — pencil, check stamp, **rectangle** and **circle** — write into
an SVG layer whose `viewBox` is the page box, so every mark is stored in **PDF
points at scale 1**, the same units search hits use. Marks therefore stay welded
to the drawing through zoom, pan and a resize, and stroke widths scale with the
document.

A shape tool stays selected after you finish a shape, so picking **Circle** once
lets you draw as many circles as you want; the same goes for **Rectangle**.

Switch to the **Select** tool to click a rectangle, circle or pasted image. It
gets a dashed outline and eight handles, and the pointer tells you what will
happen: a **move** cursor over the body, and a **double-headed arrow** over each
handle pointing along the axis it resizes. Drag inside to move it, drag a handle
to resize it, press **Delete** to remove it. The handles keep a constant size on
screen at any zoom. Undo and redo
(`Ctrl+Z` / `Ctrl+Y`) cover drawing, moving, resizing, deleting and Clear alike,
because the history stores snapshots rather than a list of additions.

Pressing **Ctrl+V** drops whatever image is on the clipboard onto the page you
are looking at, sized to about half the page width. It behaves like a shape from
then on, and ends up in the saved PDF as a real embedded image. Captures are
re-encoded to JPEG (max 1600px on the long edge) to keep the upload reasonable.

**Save as PDF** posts the marks to `POST /api/pdf/:docId/export`, where
[annotate.js](server/src/services/annotate.js) writes them into a copy of the
document as standard `/Ink` annotations — using pdf.js itself, so there is no
second PDF library in the tree. Shapes are flattened to polylines first — a
rectangle is a closed 5-point line, a circle a 64-segment polygon — so the server
never needs to know about shape types. `viewport.convertToPdfPoint()` performs the
top-left → bottom-left flip and handles pages with a `/Rotate` entry. The cached
original is never modified, and the exported file remains fully searchable.

The destination is always chosen **before** anything is written:

- In a **secure context** (https, or `http://localhost`) the browser's own Save As
  dialog is used — the real OS one.
- Otherwise an in-app dialog browses folders on the machine running the server,
  which then writes the file. It opens on "This PC" with the drive list plus
  Desktop / Documents / Downloads shortcuts.

> **Security.** The second route is a filesystem write driven by an HTTP request,
> and it is unrestricted by default so it behaves like a normal Save As. If the
> API is reachable from your network, set `EXPORT_ROOT` to confine it to one
> folder tree, or `EXPORT_ENABLED=false` to switch it off. File names are always
> reduced to a basename and forced to `.pdf`, and an existing file is never
> overwritten without confirmation.

Overwriting a file that is **currently open in a PDF viewer** cannot work on
Windows — the file is locked. The app says so plainly and leaves the existing
file untouched; close the file, or save under a different name.

## Theme

A switch in the header toggles dark and light. **The app always starts in the
light theme** — the operating system setting is not consulted, so a machine in
dark mode still opens this app light. Switching to dark is remembered in
`localStorage` and applies from then on. Both palettes are token sets in
[client/src/styles.css](client/src/styles.css), and an inline script in
`index.html` applies the theme before first paint so there is no flash of the
wrong colours. Components reference tokens only — a raw colour in a component is
a bug in one of the two themes.

## Memory management

The parsed spatial index lives in process memory keyed by `docId`; the PDF bytes
are spilled to a temp directory. Entries expire after `DOC_TTL_MS` (default 1 h),
a sweeper runs every `DOC_SWEEP_MS`, at most `DOC_MAX` documents are kept (oldest
evicted first), uploading a new file releases the client's previous `docId`, and
`SIGINT`/`SIGTERM` wipe the temp directory. Swapping the store for Redis means
replacing `server/src/services/documentStore.js` — nothing else touches it.

## Environment variables

Server values live in `server/.env` (loaded by `--env-file-if-exists` in the npm
scripts, so `npm start`/`npm run dev` pick them up but a bare `node src/index.js`
does not); client values in `client/.env`. Both mirror a checked-in `.env.example`.
A real environment variable always wins over the file, which is how Render's
injected `PORT` works.

Deploying the client **statically** (as [render.yaml](render.yaml) does) needs
`VITE_API_BASE` — `VITE_API_TARGET` only configures the dev proxy and has no
effect on a production build.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | API listener |
| `MAX_UPLOAD_BYTES` | `104857600` | Upload size limit (100 MB) |
| `DOC_TTL_MS` | `3600000` | Idle lifetime of a cached document |
| `DOC_SWEEP_MS` | `300000` | Expiry sweep interval |
| `DOC_MAX` | `12` | Max cached documents |
| `SEARCH_MAX_RESULTS` | `5000` | Coordinate cap per search (counts stay exact) |
| `EXPORT_ROOT` | unset (anywhere) | Confines the save dialog to one folder tree |
| `EXPORT_ENABLED` | `true` | `false` disables saving to a server folder entirely |
| `VITE_API_TARGET` | `http://127.0.0.1:3000` | **Dev only.** Backend the Vite dev proxy forwards to (keep it on loopback) |
| `VITE_DEV_HOST` | unset | Set to `0.0.0.0` to expose the dev client on the LAN |
| `VITE_API_BASE` | unset | **Build time.** Absolute API origin baked into the bundle; required when the client is hosted statically, apart from the backend |

## Layout

The browser window itself never scrolls: `html`/`body` are locked and each pane
owns its own scroll area. The split defaults to **85 % / 15 %** and is draggable:
grab the divider and move it left or right and both sides resize together. It
clamps to 10–60 %, never lets the panel fall under 180 px, resets on double
click, takes arrow keys when focused, and remembers the width in localStorage.

- **Loading** — uploading a drawing shows a progress panel over the viewer:
  a real percentage while the file uploads and while the browser fetches it back,
  and a moving bar while the server reads the text layer.
- **Header** — upload button, file name, live processing status, and a **dark /
  light theme switch**. Starts light every time until you switch it, then
  remembers your choice.
- **Left, 85 % by default** — canvas viewer, opening at a **fixed 100 % zoom** and scrolling
  in both directions inside its own pane. The pointer turns into a **hand over
  the page — press and hold the left button to drag the drawing around**.
  **Ctrl (or Cmd) + mouse scroll zooms**
  while the pointer is over the page — cursor-anchored, so the point under the
  cursor stays put, and the browser's own page zoom is suppressed there only; a
  plain scroll still scrolls. Toolbar zoom in/out, zoom percentage, 100 %, fit
  width/page, page counter, lazy rendering with a ±3 page window, highlight
  overlay. Pages wider than the pane overflow to the right and stay reachable.
  **Markup tools**: red pencil, check stamp, rectangle and circle, with a
  thickness selector (thin / medium / thick / extra), a select tool for moving,
  resizing and deleting, plus undo, redo and clear. **Ctrl+V** pastes a
  screenshot from the clipboard onto the page.
  **Esc** drops back to the hand tool, **Ctrl+Z** undoes and **Ctrl+Y** redoes
  (ignored while a search field has focus, so text editing keeps its own undo).
  Marks are held in PDF points, so they stay locked to the drawing at any zoom.
  **Save as PDF…** in the header always asks for the destination first, then
  writes the marks into a copy of the document as real PDF ink annotations —
  through the browser's own save dialog where the page is in a secure context,
  otherwise through an in-app folder browser that saves on the server machine. The original stays untouched and the saved copy
  is still fully searchable.
- **Right, 15 % by default** — `Wakugumi` / `Jikugumi` radios, one editable input per term
  with a `Found: n` badge, page list, and prev/next match navigation. `Enter` in
  a term field runs that search and puts a **✓ next to the row number** to mark
  it as already searched (grey when the term was not found, green when it was);
  `Search all terms` fills every badge — and every tick — at once. The category
  selector and buttons stay pinned while the term list scrolls.

## Project layout

```
server/src/
  index.js                   express app, /api/categories, /api/folders, static client
  routes/pdf.js              upload / page / search / export endpoints
  services/pdfParser.js      pdf.js extraction, page index, bounding box maths
  services/search.js         regex execution, counts, match -> coordinates
  services/documentStore.js  session cache, TTL, eviction, temp files
  services/annotate.js       burns marks into a PDF copy as /Ink annotations
  services/exportTargets.js  folder browsing + writing, path confinement
  utils/normalize.js         NFKC with an index map
  utils/regex.js             escaping + query compilation
  data/categories.js         the two dictionaries
client/src/
  main.js                    mounts the app
  App.vue                    layout, upload, per-term search state, save flow
  api.js                     every call to the backend, save-dialog helpers
  styles.css                 the light / dark token palettes
  components/PdfViewer.vue   canvas rendering, zoom, pan, markup tools, highlights
  components/SearchPanel.vue category radios, term rows, count badges, ticks
  components/SaveDialog.vue  folder picker used when the browser has no native one
  components/ThemeToggle.vue dark / light switch
scripts/dev.mjs              runs both dev servers, no dependencies
```
