import path from 'node:path';
import { createRequire } from 'node:module';
import { normalizeWithMap } from '../utils/normalize.js';

const require = createRequire(import.meta.url);

// CMaps are mandatory for Japanese (Adobe-Japan1) encoded PDFs, otherwise the
// extracted text layer comes back garbled or empty.  Resolved lazily so the
// geometry helpers below stay importable before `npm install` has run.
let assetPaths = null;
function pdfjsAssets() {
  if (!assetPaths) {
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    assetPaths = {
      cMapUrl: path.join(root, 'cmaps') + path.sep,
      standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    };
  }
  return assetPaths;
}

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * 2x3 affine matrix product, identical to pdf.js `Util.transform`.  Kept local
 * so page indexing can be unit tested without loading the pdf.js bundle.
 */
export function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Axis aligned bounding box for a run of glyphs inside one text item.
 *
 * pdf.js gives us the text matrix; combined with the page viewport transform it
 * lands in top-left screen space at scale 1. From there:
 *   dir ... unit vector along the baseline (handles rotated CAD labels)
 *   up  ... unit vector towards the ascender
 *   width sliced proportionally for sub-strings
 */
function rectFromRun(item, fromFraction, toFraction) {
  const { tx, width, height } = item;
  const angle = Math.atan2(tx[1], tx[0]);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const upX = Math.sin(angle);
  const upY = -Math.cos(angle);

  const startX = tx[4] + dirX * width * fromFraction;
  const startY = tx[5] + dirY * width * fromFraction;
  const runLength = width * (toFraction - fromFraction);
  const endX = startX + dirX * runLength;
  const endY = startY + dirY * runLength;

  const corners = [
    [startX, startY],
    [endX, endY],
    [startX + upX * height, startY + upY * height],
    [endX + upX * height, endY + upY * height],
  ];

  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...xs) - x),
    height: round(Math.max(...ys) - y),
  };
}

/**
 * Per-glyph advance weights. pdf.js only reports the advance of a whole text
 * item, so sub-string highlights have to be interpolated. Full-width glyphs
 * (CJK, kana, full-width latin) advance roughly twice as far as half-width ones,
 * which makes a weighted split far more accurate than an even split on mixed
 * Japanese/ASCII labels.
 */
function glyphWeights(str) {
  const weights = new Array(str.length);
  for (let i = 0; i < str.length; i++) {
    weights[i] = isFullWidth(str.codePointAt(i)) ? 2 : 1;
  }
  return weights;
}

function isFullWidth(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/**
 * Parse a PDF buffer into a spatial search index.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<{ totalPages:number, pages:Array }>} one entry per page:
 *   { pageNumber, width, height, rotation, text, charItem, charStart, charEnd, items }
 *   `text` is NFKC-normalised; the typed arrays project any index of `text` back
 *   onto (item, character) pairs so bounding boxes can be reconstructed.
 */
/**
 * Open a PDF with the options Japanese drawings need. Shared with the annotation
 * writer so both paths decode Adobe-Japan1 text identically.
 * @returns {Promise<{ pdfjs:object, doc:object }>} caller must `doc.destroy()`.
 */
export async function openDocument(buffer) {
  const pdfjs = await loadPdfjs();
  const { cMapUrl, standardFontDataUrl } = pdfjsAssets();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  return { pdfjs, doc };
}

export async function parsePdf(buffer) {
  const { doc } = await openDocument(buffer);
  const pages = [];
  const totalPages = doc.numPages;

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        pages.push(await indexPage(page, pageNumber));
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  return { totalPages, pages };
}

async function indexPage(page, pageNumber) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({
    includeMarkedContent: false,
    disableNormalization: true,
  });
  return buildPageIndex({ pageNumber, viewport, textItems: content.items });
}

/**
 * Build the searchable index for a single page.
 *
 * @param {object} input
 * @param {number} input.pageNumber
 * @param {{ transform:number[], width:number, height:number, rotation:number }} input.viewport
 * @param {Array<{ str:string, transform:number[], width:number, hasEOL?:boolean }>} input.textItems
 */
export function buildPageIndex({ pageNumber, viewport, textItems }) {
  const items = [];
  let raw = '';
  // For every code unit of `raw`: which item it belongs to and its offset in it.
  const rawItem = [];
  const rawOffset = [];

  for (const item of textItems) {
    if (typeof item.str !== 'string') continue;

    if (item.str.length > 0) {
      const tx = multiplyTransform(viewport.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]) || item.height || 0;
      const index = items.length;

      items.push({
        str: item.str,
        tx,
        width: item.width || 0,
        height,
        weights: glyphWeights(item.str),
      });

      for (let k = 0; k < item.str.length; k++) {
        rawItem.push(index);
        rawOffset.push(k);
      }
      raw += item.str;
    }

    // Keep line breaks so a term can never match across two unrelated lines.
    if (item.hasEOL) {
      rawItem.push(-1);
      rawOffset.push(0);
      raw += '\n';
    }
  }

  const { text, srcStart, srcEnd } = normalizeWithMap(raw);

  // Project the NFKC index map onto (item, offset) spans.  The span matters:
  // one normalised character can come from two source glyphs (ﾊ + ﾟ -> パ), and
  // the highlight has to cover both of them.
  const charItem = new Int32Array(text.length);
  const charStart = new Int32Array(text.length);
  const charEnd = new Int32Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const firstRaw = srcStart[i];
    const lastRaw = srcEnd[i] - 1;
    const itemIndex = rawItem[firstRaw] ?? -1;
    charItem[i] = itemIndex;
    charStart[i] = rawOffset[firstRaw] ?? 0;
    charEnd[i] =
      rawItem[lastRaw] === itemIndex ? (rawOffset[lastRaw] ?? 0) + 1 : charStart[i] + 1;
  }

  // Pre-compute cumulative advance weights per item for fast rect slicing.
  for (const item of items) {
    const prefix = new Float64Array(item.weights.length + 1);
    for (let i = 0; i < item.weights.length; i++) prefix[i + 1] = prefix[i] + item.weights[i];
    item.prefix = prefix;
    item.totalWeight = prefix[prefix.length - 1] || 1;
    delete item.weights;
  }

  return {
    pageNumber,
    width: round(viewport.width),
    height: round(viewport.height),
    rotation: viewport.rotation,
    text,
    charItem,
    charStart,
    charEnd,
    items,
  };
}

/**
 * Turn a [start, end) match range in a page's normalised text into one bounding
 * box per text item the match spans (a label split across two items yields two).
 */
export function rectsForRange(pageIndex, start, end) {
  const { charItem, charStart, charEnd, items } = pageIndex;
  const runs = [];
  let current = null;

  for (let i = start; i < end; i++) {
    const itemIndex = charItem[i];
    if (itemIndex < 0) continue; // synthetic newline
    const from = charStart[i];
    const to = charEnd[i];

    if (current && current.itemIndex === itemIndex) {
      current.from = Math.min(current.from, from);
      current.to = Math.max(current.to, to);
    } else {
      if (current) runs.push(current);
      current = { itemIndex, from, to };
    }
  }
  if (current) runs.push(current);

  return runs.map(({ itemIndex, from, to }) => {
    const item = items[itemIndex];
    const last = item.prefix.length - 1;
    const fromFraction = item.prefix[Math.min(from, last)] / item.totalWeight;
    const toFraction = item.prefix[Math.min(to, last)] / item.totalWeight;
    return rectFromRun(item, fromFraction, toFraction);
  });
}

/** Compact page metadata handed to the client viewer. */
export function pageSummary(pageIndex) {
  return {
    page: pageIndex.pageNumber,
    width: pageIndex.width,
    height: pageIndex.height,
    rotation: pageIndex.rotation,
    textItems: pageIndex.items.length,
    characters: pageIndex.text.length,
  };
}
