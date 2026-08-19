import { normalizeQuery } from '../utils/normalize.js';
import { buildQueryRegex } from '../utils/regex.js';
import { rectsForRange } from './pdfParser.js';

const MAX_RESULTS = Number(process.env.SEARCH_MAX_RESULTS || 5000);

/**
 * Run one term against a cached document.
 *
 * @param {object} record document store record
 * @param {string} query raw term as typed by the user
 * @param {object} [options]
 * @param {boolean} [options.caseInsensitive=true]
 * @param {boolean} [options.looseSpacing=false] allow whitespace between every character
 * @param {number}  [options.padding=0.5] bounding box padding in PDF points
 * @returns {{ query:string, normalizedQuery:string, totalMatches:number,
 *             pages:number[], results:Array, truncated:boolean }}
 */
export function searchDocument(record, query, options = {}) {
  const { caseInsensitive = true, looseSpacing = false, padding = 0.5 } = options;

  const normalizedQuery = normalizeQuery(query);
  const regex = buildQueryRegex(normalizedQuery, { caseInsensitive, looseSpacing });

  if (!regex) {
    return {
      query,
      normalizedQuery,
      totalMatches: 0,
      pages: [],
      results: [],
      truncated: false,
    };
  }

  const results = [];
  const pagesHit = new Set();
  let totalMatches = 0;
  let truncated = false;

  for (const pageIndex of record.pages) {
    if (!pageIndex.text) continue;
    regex.lastIndex = 0;

    let match;
    while ((match = regex.exec(pageIndex.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Guard against zero-length matches spinning forever.
      if (end === start) {
        regex.lastIndex = start + 1;
        continue;
      }

      totalMatches += 1;
      pagesHit.add(pageIndex.pageNumber);

      if (results.length < MAX_RESULTS) {
        const rects = rectsForRange(pageIndex, start, end).map((r) => pad(r, padding));
        if (rects.length > 0) {
          results.push({
            page: pageIndex.pageNumber,
            index: totalMatches - 1,
            text: match[0],
            bounds: mergeBounds(rects),
            rects,
          });
        }
      } else {
        truncated = true;
      }
    }
  }

  results.sort((a, b) => a.page - b.page || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);

  return {
    query,
    normalizedQuery,
    totalMatches,
    pages: [...pagesHit].sort((a, b) => a - b),
    results,
    truncated,
  };
}

/** Run a whole dictionary in one round trip; used to fill every count badge. */
export function searchDocumentBatch(record, queries, options = {}) {
  return queries.map((query) => {
    const result = searchDocument(record, query, options);
    return {
      query,
      totalMatches: result.totalMatches,
      pages: result.pages,
      firstPage: result.pages[0] ?? null,
    };
  });
}

function pad(rect, amount) {
  if (!amount) return rect;
  return {
    x: round(rect.x - amount),
    y: round(rect.y - amount),
    width: round(rect.width + amount * 2),
    height: round(rect.height + amount * 2),
  };
}

/** Single axis aligned box covering every rect of a match (spec response shape). */
function mergeBounds(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
