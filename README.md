# PDF Term Reader — Wakugumi / Jikugumi

Web based PDF reader that parses construction drawings on a Node.js backend, runs
full text search over the extracted text layer, and returns **hit counts plus
bounding box coordinates** that the Vue client paints over the rendered page.

```
client (Vue 3, Vite)                     server (Express, pdf.js)
┌────────────────────────┬──────────┐    ┌──────────────────────────────────┐
│ PDF viewer 65%         │ search   │    │ POST /api/pdf/upload   parse+cache│
│  canvas + highlights   │ panel 35%│ ─► │ POST /api/pdf/search   NFKC+regex │
│  zoom / page counter   │ radios   │ ◄─ │  → { totalMatches, results[] }    │
└────────────────────────┴──────────┘    └──────────────────────────────────┘
```

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
| `VITE_API_TARGET` | `http://127.0.0.1:3000` | **Dev only.** Backend the Vite dev proxy forwards to (keep it on loopback) |
| `VITE_DEV_HOST` | unset | Set to `0.0.0.0` to expose the dev client on the LAN |
| `VITE_API_BASE` | unset | **Build time.** Absolute API origin baked into the bundle; required when the client is hosted statically, apart from the backend |

## Layout

The browser window itself never scrolls: `html`/`body` are locked and each pane
owns its own scroll area.

- **Header** — upload button, file name, live processing status.
- **Left 65 %** — canvas viewer, opening at a **fixed 100 % zoom** and scrolling
  in both directions inside its own pane. Zoom in/out, zoom percentage, 100 %,
  fit width/page, page counter, lazy rendering with a ±3 page window, highlight
  overlay. Pages wider than the pane overflow to the right and stay reachable.
- **Right 35 %** — `Wakugumi` / `Jikugumi` radios, one editable input per term
  with a `Found: n` badge, page list, and prev/next match navigation. `Enter` in
  a term field runs that search and puts a **✓ next to the row number** to mark
  it as already searched (grey when the term was not found, green when it was);
  `Search all terms` fills every badge — and every tick — at once. The category
  selector and buttons stay pinned while the term list scrolls.

## Project layout

```
server/src/
  routes/pdf.js             upload / page / search endpoints
  services/pdfParser.js     pdf.js extraction, page index, bounding box maths
  services/search.js        regex execution, counts, match -> coordinates
  services/documentStore.js session cache, TTL, eviction, temp files
  utils/normalize.js        NFKC with an index map
  utils/regex.js            escaping + query compilation
  data/categories.js        the two dictionaries
client/src/
  App.vue                   layout, upload, per-term search state
  components/PdfViewer.vue  canvas rendering, zoom, highlight overlay
  components/SearchPanel.vue category radios, term rows, count badges
```
