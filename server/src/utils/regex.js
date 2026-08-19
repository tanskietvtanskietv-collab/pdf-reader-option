/**
 * Regex helpers for user supplied search terms.
 *
 * The dictionaries contain terms such as `(H)`, `(B)`, `+レ`, `24(`, `E-`, `CH=`
 * and `NO.7` — every one of which would either throw or silently mean something
 * else if it were compiled as a raw pattern.  Everything is escaped first.
 */

// Only the ECMAScript syntax characters. `-` is deliberately left alone: it is a
// literal outside a character class, and `\-` is an invalid escape under the `u`
// flag, which would break terms such as `E-`, `24-` and `ｱ-ﾁﾀﾚ壁`.
const SPECIALS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(str) {
  return String(str).replace(SPECIALS, '\\$&');
}

/**
 * Build a global RegExp for an (already NFKC-normalised) query.
 *
 * - Whitespace runs inside the query become `\s*`, so `BALCONY FINE TESURI`
 *   still matches when the PDF text layer emits the words without spaces.
 * - `looseSpacing` additionally allows whitespace between *every* character,
 *   which helps with letter-spaced CAD labels at the cost of false positives.
 *
 * @returns {RegExp|null} null when the query has no searchable characters.
 */
export function buildQueryRegex(query, { caseInsensitive = true, looseSpacing = false } = {}) {
  const chars = Array.from(String(query ?? ''));
  let body = '';
  let pendingWhitespace = false;
  let first = true;

  for (const ch of chars) {
    if (/\s/.test(ch)) {
      pendingWhitespace = true;
      continue;
    }
    if (!first && (pendingWhitespace || looseSpacing)) body += '\\s*';
    body += escapeRegExp(ch);
    pendingWhitespace = false;
    first = false;
  }

  if (!body) return null;

  return new RegExp(body, caseInsensitive ? 'giu' : 'gu');
}
