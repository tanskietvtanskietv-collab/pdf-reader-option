/**
 * NFKC normalisation helpers.
 *
 * Search has to be robust against the half-width / full-width mess that is
 * typical for Japanese CAD exports:  ｱｰﾁ vs アーチ, ﾊﾟ (ﾊ + ﾟ) vs パ, ＷＦ vs WF …
 *
 * `normalizeWithMap()` normalises a string *and* returns an index map so a match
 * found in the normalised text can be projected back onto the original glyph
 * positions extracted from the PDF.  A plain `str.normalize('NFKC')` cannot do
 * that, because NFKC changes the string length (ﾊ + ﾟ -> パ is 2 chars -> 1).
 */

// Half-width voiced / semi-voiced sound marks.  They only compose correctly when
// normalised together with the preceding kana, so they need look-ahead.
const HALFWIDTH_DAKUTEN = '\uFF9E'; // ﾞ
const HALFWIDTH_HANDAKUTEN = '\uFF9F'; // ﾟ

/** Plain NFKC normalisation (used for queries). */
export function normalize(str) {
  return typeof str === 'string' ? str.normalize('NFKC') : '';
}

/** Trim + collapse surrounding whitespace, then NFKC. Used on incoming queries. */
export function normalizeQuery(str) {
  return normalize(String(str ?? '').trim());
}

/**
 * @param {string} str
 * @returns {{ text: string, srcStart: Int32Array, srcEnd: Int32Array }}
 *   `text` is the NFKC form. For every code unit `i` of `text`,
 *   `srcStart[i]`/`srcEnd[i]` describe the [start, end) slice of `str` it came from.
 */
export function normalizeWithMap(str) {
  const source = String(str ?? '');
  let out = '';
  const starts = [];
  const ends = [];

  for (let i = 0; i < source.length; i++) {
    // Grab the base char plus a trailing half-width (han)dakuten, if present.
    const next = source[i + 1];
    const span = next === HALFWIDTH_DAKUTEN || next === HALFWIDTH_HANDAKUTEN ? 2 : 1;
    const chunk = source.slice(i, i + span);
    const normalized = chunk.normalize('NFKC');

    for (let k = 0; k < normalized.length; k++) {
      starts.push(i);
      ends.push(i + span);
    }
    out += normalized;
    i += span - 1;
  }

  return {
    text: out,
    srcStart: Int32Array.from(starts),
    srcEnd: Int32Array.from(ends),
  };
}
