/**
 * Checks for the search pipeline.  Run with:  npm --prefix server test
 *
 * The unit tests are dependency free.  The integration tests need `pdfjs-dist`
 * and are skipped (not failed) when node_modules has not been installed yet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildFixturePdf } from './make-fixture.mjs';
import { normalizeWithMap, normalizeQuery } from '../src/utils/normalize.js';
import { escapeRegExp, buildQueryRegex } from '../src/utils/regex.js';
import { getCategory, getAllCategories } from '../src/data/categories.js';
// Loadable without pdfjs-dist: the geometry helpers have no runtime dependency on it.
import { buildPageIndex } from '../src/services/pdfParser.js';
import { searchDocument, searchDocumentBatch } from '../src/services/search.js';

const searchPages = searchDocument;

const require = createRequire(import.meta.url);

/* -------------------------------------------------------------- unit tests */

test('NFKC map keeps indices aligned with the source string', () => {
  const { text, srcStart, srcEnd } = normalizeWithMap('ｽﾃﾝﾊﾟｲﾌﾟ');
  assert.equal(text, 'ステンパイプ');
  assert.equal(srcStart.length, text.length);
  // パ is composed from two source characters (ﾊ + ﾟ).
  assert.equal(srcEnd[3] - srcStart[3], 2);
  assert.equal(srcEnd[srcEnd.length - 1], 8);
});

test('NFKC folds full-width latin and half-width katakana', () => {
  assert.equal(normalizeQuery('  ＷＦ '), 'WF');
  assert.equal(normalizeQuery('ｱｰﾁﾀﾚ壁'), 'アーチタレ壁');
  // The hyphen variant must stay distinct from the prolonged sound mark variant.
  assert.notEqual(normalizeQuery('ｱ-ﾁﾀﾚ壁'), normalizeQuery('ｱｰﾁﾀﾚ壁'));
});

test('every dictionary term compiles to a safe regex', () => {
  for (const { name, items } of getAllCategories()) {
    for (const term of items) {
      const regex = buildQueryRegex(normalizeQuery(term));
      assert.ok(regex, `${name}: ${term} produced no regex`);
      assert.doesNotThrow(() => regex.test('sample'), `${name}: ${term}`);
    }
  }
});

test('regex escaping neutralises operator characters', () => {
  assert.equal(escapeRegExp('(H)'), '\\(H\\)');
  assert.ok(buildQueryRegex('(H)').test('CH=2400 (H) 1200'));
  assert.ok(!buildQueryRegex('(H)').test('H'));
  assert.ok(buildQueryRegex('+レ').test('AB+レC'));
  assert.ok(buildQueryRegex('E-').test('E-180'));
  assert.ok(buildQueryRegex('NO.7').test('NO.7'));
  assert.ok(!buildQueryRegex('NO.7').test('NOX7'));
});

test('whitespace inside a term is tolerated in the document text', () => {
  assert.ok(buildQueryRegex('check hood').test('CHECKHOOD'));
  assert.ok(buildQueryRegex('check hood').test('check   hood'));
});

test('a blank query yields no regex instead of matching everything', () => {
  assert.equal(buildQueryRegex('   '), null);
  assert.equal(buildQueryRegex(''), null);
});

/* ---------------------------------------------------- geometry + matching --
 * These build a page index from synthetic pdf.js text items, so the coordinate
 * maths and the match->bounding-box projection are covered without a real PDF.
 */

const PAGE_HEIGHT = 842;

/** @param items pdf.js style text items */
function fakePage(pageNumber, items) {
  return buildPageIndex({
    pageNumber,
    viewport: { transform: [1, 0, 0, -1, 0, PAGE_HEIGHT], width: 595, height: PAGE_HEIGHT, rotation: 0 },
    textItems: items,
  });
}

/** Horizontal text item: `advance` is the total width pdf.js reports. */
function item(str, { x = 40, y = 780, size = 10, advance = 10 * str.length, eol = true } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width: advance, hasEOL: eol };
}

/** 90 degrees counter-clockwise, the way CAD tools label vertical dimensions. */
function rotatedItem(str, { x = 500, y = 200, size = 10, advance = 10 * str.length } = {}) {
  return { str, transform: [0, size, -size, 0, x, y], width: advance, hasEOL: true };
}

function fakeRecord(...pages) {
  return { docId: 'fake', totalPages: pages.length, pages };
}

function near(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected}, got ${actual}`,
  );
}

test('a match is placed at the glyph position in top-left page space', () => {
  const record = fakeRecord(fakePage(1, [item('CH=2400', { x: 40, y: 780, size: 10, advance: 70 })]));
  const [hit] = searchPages(record, 'CH=').results;

  near(hit.bounds.x, 39.5, 0.01, 'x');
  // Baseline 780 from the bottom -> 842-780-10 for the ascender, minus padding.
  near(hit.bounds.y, 51.5, 0.01, 'y');
  near(hit.bounds.height, 11, 0.01, 'height');
  // 3 of 7 half-width glyphs.
  near(hit.bounds.width, 30 + 1, 0.01, 'width');
});

test('a sub-string is offset inside its text item', () => {
  const record = fakeRecord(fakePage(1, [item('CH=2400', { advance: 70 })]));
  const [hit] = searchPages(record, '2400').results;
  near(hit.bounds.x, 40 + 30 - 0.5, 0.01, 'x offset');
  near(hit.bounds.width, 40 + 1, 0.01, 'width');
});

test('full-width glyphs advance twice as far as half-width ones', () => {
  // "CH=" (3 half) + "天井" (2 full) => weights 1,1,1,2,2 = 7 units over 70pt.
  const record = fakeRecord(fakePage(1, [item('CH=天井', { advance: 70 })]));
  const [hit] = searchPages(record, '天井').results;
  near(hit.bounds.x, 40 + 30 - 0.5, 0.01, 'x offset');
  near(hit.bounds.width, 40 + 1, 0.01, 'width');
});

test('a match spanning two text items yields one hit with two rects', () => {
  const record = fakeRecord(
    fakePage(1, [
      item('ｽﾃﾝ', { x: 40, advance: 30, eol: false }),
      item('ﾊﾟｲﾌﾟ', { x: 70, advance: 50 }),
    ]),
  );
  const result = searchPages(record, 'ステンパイプ');
  assert.equal(result.totalMatches, 1);
  assert.equal(result.results[0].rects.length, 2);
  // The merged box has to span both items.
  near(result.results[0].bounds.x, 39.5, 0.01, 'merged x');
  near(result.results[0].bounds.width, 80 + 1, 0.01, 'merged width');
});

test('a term never matches across a line break', () => {
  const record = fakeRecord(fakePage(1, [item('SA'), item('DL', { y: 760 })]));
  assert.equal(searchPages(record, 'SADL').totalMatches, 0);
  assert.equal(searchPages(record, 'SA').totalMatches, 1);
});

test('rotated labels get an upright bounding box', () => {
  const record = fakeRecord(fakePage(1, [rotatedItem('高基礎', { advance: 60 })]));
  const [hit] = searchPages(record, '高基礎').results;
  assert.ok(hit.bounds.height > hit.bounds.width, 'vertical label should be taller than wide');
  near(hit.bounds.height, 60 + 1, 0.01, 'height follows the advance');
  near(hit.bounds.width, 10 + 1, 0.01, 'width follows the font size');
});

test('half-width katakana with a separate voiced mark is matched and located', () => {
  const record = fakeRecord(fakePage(1, [item('ｽﾃﾝﾊﾟｲﾌﾟ', { advance: 40 })]));
  const half = searchPages(record, 'ｽﾃﾝﾊﾟｲﾌﾟ');
  const full = searchPages(record, 'ステンパイプ');
  assert.equal(half.totalMatches, 1);
  assert.equal(full.totalMatches, 1);
  assert.deepEqual(half.results[0].bounds, full.results[0].bounds);
  near(full.results[0].bounds.width, 40 + 1, 0.01, 'covers the whole label');
});

test('counts and page numbers aggregate across pages', () => {
  const record = fakeRecord(
    fakePage(1, [item('SA'), item('SA DL', { y: 700 })]),
    fakePage(2, [item('DL')]),
    fakePage(3, [item('SA')]),
  );
  const result = searchPages(record, 'SA');
  assert.equal(result.totalMatches, 3);
  assert.deepEqual(result.pages, [1, 3]);
  assert.deepEqual(
    result.results.map((r) => r.page),
    [1, 1, 3],
  );
  assert.equal(searchPages(record, 'DL').totalMatches, 2);
});

test('operator-heavy dictionary terms match literally', () => {
  const record = fakeRecord(fakePage(1, [item('CH=2400 (H) 24- E-180 +レ _遮 NO.7 V-15')]));
  for (const term of ['(H)', '24-', 'E-', '+レ', '_遮', 'NO.7', 'V-15', '-180']) {
    assert.equal(searchPages(record, term).totalMatches, 1, `${term} should match once`);
  }
  assert.equal(searchPages(record, '(B)').totalMatches, 0);
});

test('a search never returns a degenerate or off-page box', () => {
  const record = fakeRecord(fakePage(1, [item('木目調天井パネル', { advance: 80 })]));
  for (const hit of searchPages(record, '天井').results) {
    assert.ok(hit.bounds.width > 0 && hit.bounds.height > 0);
    assert.ok(hit.bounds.x >= 0 && hit.bounds.y >= 0);
    assert.ok(hit.bounds.x + hit.bounds.width <= 595);
    assert.ok(hit.bounds.y + hit.bounds.height <= PAGE_HEIGHT);
  }
});

/* ------------------------------------------------------------- integration */

let skip = false;
let parsePdf;

try {
  require.resolve('pdfjs-dist/package.json');
  ({ parsePdf } = await import('../src/services/pdfParser.js'));
} catch {
  skip = 'pdfjs-dist is not installed — run `npm install` in server/ first';
}

const parsed = skip ? null : await parsePdf(buildFixturePdf());
const record = skip ? null : { docId: 'test', pages: parsed.pages, totalPages: parsed.totalPages };

const integration = (name, fn) => test(name, { skip }, fn);

integration('the fixture parses into one indexed page', () => {
  assert.equal(parsed.totalPages, 1);
  assert.equal(parsed.pages[0].pageNumber, 1);
  assert.ok(parsed.pages[0].items.length > 0, 'no text items were extracted');
  assert.equal(parsed.pages[0].width, 595);
  assert.equal(parsed.pages[0].height, 842);
});

integration('the text layer is stored NFKC normalised', () => {
  const pageText = parsed.pages[0].text;
  assert.ok(pageText.includes('ステンパイプ'), `half-width katakana was not folded: ${pageText}`);
  assert.ok(pageText.includes('天井下がり'));
});

integration('latin terms with regex characters are counted and located', () => {
  for (const [term, expected] of [
    ['(H)', 1],
    ['(B)', 1],
    ['24-', 1],
    ['BS-', 1],
    ['CH=', 1],
    ['V-15', 1],
    ['SA', 3],
  ]) {
    const result = searchDocument(record, term);
    assert.equal(result.totalMatches, expected, `${term}: expected ${expected}`);
    assert.equal(result.results.length, expected);
    for (const hit of result.results) {
      assert.equal(hit.page, 1);
      assert.ok(hit.bounds.width > 0 && hit.bounds.height > 0, `${term}: empty bounds`);
      assert.ok(hit.bounds.x >= -1 && hit.bounds.y >= -1, `${term}: origin off page`);
      assert.ok(hit.bounds.x + hit.bounds.width <= 596, `${term}: box escapes the page`);
    }
  }
});

integration('search is case insensitive by default', () => {
  assert.equal(searchDocument(record, 'koubai yane').totalMatches, 1);
  assert.equal(searchDocument(record, 'KOUBAI YANE').totalMatches, 1);
  assert.equal(searchDocument(record, 'balcony fine tesuri').totalMatches, 1);
  assert.equal(searchDocument(record, 'KOUBAI YANE', { caseInsensitive: false }).totalMatches, 0);
});

integration('half-width and full-width queries hit the same glyphs', () => {
  const halfWidth = searchDocument(record, 'ｽﾃﾝﾊﾟｲﾌﾟ');
  const fullWidth = searchDocument(record, 'ステンパイプ');
  assert.equal(halfWidth.totalMatches, 1);
  assert.equal(fullWidth.totalMatches, 1);
  assert.deepEqual(halfWidth.results[0].bounds, fullWidth.results[0].bounds);
});

integration('a sub-string highlight is narrower than the whole label', () => {
  const short = searchDocument(record, '深基礎').results[0];
  const line = searchDocument(record, '天井下がり 深基礎').results[0];
  assert.ok(short.bounds.width < line.bounds.width);
  assert.ok(short.bounds.x > line.bounds.x, 'sub-string was not offset into the label');
});

integration('rotated labels still produce a sane bounding box', () => {
  const result = searchDocument(record, '高基礎');
  assert.equal(result.totalMatches, 1);
  const { bounds } = result.results[0];
  assert.ok(bounds.height > bounds.width, 'vertical label should be taller than wide');
});

integration('a term that is absent reports zero without throwing', () => {
  const result = searchDocument(record, 'ｿﾘｯﾄﾞｳｯﾄﾞﾊﾟﾈﾙ');
  assert.equal(result.totalMatches, 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.pages, []);
});

integration('batch search returns one row per dictionary term', () => {
  const terms = getCategory('Wakugumi');
  const rows = searchDocumentBatch(record, terms);
  assert.equal(rows.length, terms.length);
  assert.equal(rows.find((r) => r.query === 'SA').totalMatches, 3);
  assert.equal(rows.find((r) => r.query === '深基礎').firstPage, 1);
  assert.equal(rows.find((r) => r.query === 'ｽﾘｯﾄﾙｰﾊ').totalMatches, 0);
});

integration('every Jikugumi term runs against a real document without error', () => {
  for (const term of getCategory('Jikugumi')) {
    assert.doesNotThrow(() => searchDocument(record, term), term);
  }
});

/* ------------------------------------------------------------ session cache */

process.env.DOC_TTL_MS = '120';
process.env.DOC_MAX = '2';
const store = await import('../src/services/documentStore.js');
const fsp = await import('node:fs/promises');

function fakeIndex() {
  return { totalPages: 1, pages: [fakePage(1, [item('SA')])] };
}

test('a stored document is retrievable and its bytes hit the disk', async () => {
  const record = await store.createDocument({
    fileName: 'a.pdf',
    buffer: Buffer.from('%PDF-1.7 test'),
    index: fakeIndex(),
  });
  assert.equal(store.getDocument(record.docId).fileName, 'a.pdf');
  assert.equal((await fsp.readFile(record.filePath)).toString(), '%PDF-1.7 test');

  await store.deleteDocument(record.docId);
  assert.equal(store.getDocument(record.docId), null);
  await assert.rejects(fsp.access(record.filePath), 'temp file should be gone');
});

test('the cache evicts the oldest document past DOC_MAX', async () => {
  const made = [];
  for (const name of ['1.pdf', '2.pdf', '3.pdf']) {
    made.push(
      await store.createDocument({
        fileName: name,
        buffer: Buffer.from('%PDF-1.7'),
        index: fakeIndex(),
      }),
    );
  }
  assert.equal(store.listDocuments().length, 2);
  assert.equal(store.getDocument(made[0].docId), null, 'oldest should be evicted');
  assert.ok(store.getDocument(made[2].docId), 'newest should survive');
  await store.shutdown();
});

test('expired documents are swept', async () => {
  const record = await store.createDocument({
    fileName: 'old.pdf',
    buffer: Buffer.from('%PDF-1.7'),
    index: fakeIndex(),
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await store.sweepExpired(), 1);
  assert.equal(store.listDocuments().length, 0);
  assert.equal(store.getDocument(record.docId), null);
  await store.shutdown();
});

/* --------------------------------------------------------- annotation export */

const { validateMarks } = await import('../src/services/annotate.js');

test('mark validation rejects payloads that would corrupt the export', () => {
  assert.throws(() => validateMarks([], 3), /non-empty/);
  assert.throws(() => validateMarks(null, 3), /non-empty/);
  assert.throws(() => validateMarks([{ page: 4, points: [{ x: 1, y: 1 }] }], 3), /between 1 and 3/);
  assert.throws(() => validateMarks([{ page: 1, points: [] }], 3), /points/);
  assert.throws(
    () => validateMarks([{ page: 1, points: [{ x: 1, y: Number.NaN }] }], 3),
    /finite/,
  );
});

test('mark validation clamps the stroke width and defaults it', () => {
  const [wide, missing] = validateMarks(
    [
      { page: 1, width: 5000, points: [{ x: 1, y: 2 }] },
      { page: 1, points: [{ x: 1, y: 2 }] },
    ],
    1,
  );
  assert.equal(wide.width, 72);
  assert.equal(missing.width, 2);
});

integration('export burns marks in as real PDF ink annotations', async () => {
  const { burnAnnotations } = await import('../src/services/annotate.js');
  const original = buildFixturePdf();

  // Viewport space: y grows downward, so y=60 is near the TOP of the page.
  const marks = validateMarks(
    [
      { page: 1, width: 3, points: [{ x: 100, y: 60 }, { x: 160, y: 120 }, { x: 220, y: 60 }] },
      { page: 1, width: 5, points: [{ x: 400, y: 800 }] },
    ],
    1,
  );

  const annotated = await burnAnnotations(original, marks);
  assert.ok(annotated.length > original.length, 'the export should add bytes');
  assert.equal(Buffer.from(annotated.subarray(0, 5)).toString(), '%PDF-');

  const { openDocument } = await import('../src/services/pdfParser.js');
  const { doc } = await openDocument(annotated);
  try {
    const page = await doc.getPage(1);
    const annots = await page.getAnnotations();
    assert.equal(annots.length, 2);
    for (const annot of annots) {
      assert.equal(annot.subtype, 'Ink');
      assert.deepEqual(Array.from(annot.color), [232, 38, 43]);
    }
    assert.equal(annots[0].borderStyle.width, 3);
    assert.equal(annots[1].borderStyle.width, 5);

    // Top-left viewport y must become bottom-left user space y: the first mark
    // spans y 60..120 on an 842pt page, so it lands at ~722..782 plus padding.
    const [x0, y0, x1, y1] = annots[0].rect;
    assert.ok(y0 > 700 && y1 < 800, `mark drifted vertically: ${y0}..${y1}`);
    assert.ok(x0 > 90 && x1 < 230, `mark drifted horizontally: ${x0}..${x1}`);
    // The single-point mark keeps a non-degenerate box.
    assert.ok(annots[1].rect[2] - annots[1].rect[0] >= 10);
  } finally {
    await doc.destroy();
  }
});

integration('the exported file is still searchable', async () => {
  const { burnAnnotations } = await import('../src/services/annotate.js');
  const marks = validateMarks([{ page: 1, width: 2, points: [{ x: 50, y: 50 }] }], 1);
  const annotated = await burnAnnotations(buildFixturePdf(), marks);

  const reparsed = await parsePdf(annotated);
  const record2 = { docId: 'x', pages: reparsed.pages, totalPages: reparsed.totalPages };
  assert.equal(searchDocument(record2, 'SA').totalMatches, 3);
  assert.equal(searchDocument(record2, 'ｽﾃﾝﾊﾟｲﾌﾟ').totalMatches, 1);
});

/* --------------------------------------------------- save-to-folder targets */

const targets = await import('../src/services/exportTargets.js');
const path = (await import('node:path')).default;
const os = (await import('node:os')).default;

test('browsing is unrestricted unless EXPORT_ROOT is set', () => {
  delete process.env.EXPORT_ROOT;
  assert.equal(targets.exportRoot(), null);
  // No root: the top level is the drive list, and absolute paths are allowed.
  assert.equal(targets.resolveFolder(''), null);
  assert.equal(targets.resolveFolder('C:\u005CUsers'), path.resolve('C:\u005CUsers'));
});

test('EXPORT_ENABLED=false blocks the server-side save', () => {
  delete process.env.EXPORT_ROOT;
  process.env.EXPORT_ENABLED = 'false';
  assert.throws(() => targets.resolveFolder(''), /disabled/);
  delete process.env.EXPORT_ENABLED;
  assert.doesNotThrow(() => targets.resolveFolder(''));
});

test('destination folders cannot escape EXPORT_ROOT when it is set', () => {
  process.env.EXPORT_ROOT = path.join(os.tmpdir(), 'pdf-export-root');
  const root = targets.exportRoot();
  assert.equal(targets.resolveFolder('.'), root);
  assert.equal(targets.resolveFolder(''), root);
  assert.ok(targets.resolveFolder('Documents').startsWith(root));
  assert.ok(targets.resolveFolder('Documents/Plans/2024').startsWith(root));

  // \u005C is a backslash: written this way so the escapes survive editing.
  const BS = '\u005C';
  for (const escape of [
    '..',
    '../..',
    '../../Windows/System32',
    `..${BS}..${BS}Windows`,
    'Documents/../../..',
    '/etc/passwd',
    `${BS}etc`,
    `C:${BS}Windows`,
    'C:Windows', // drive-relative: resolves against the cwd, not the root
    'c:/Windows',
    `D:${BS}elsewhere`,
    `${BS}${BS}server${BS}share`, // UNC
  ]) {
    assert.throws(
      () => targets.resolveFolder(escape),
      /stay inside/,
      `${escape} should have been refused`,
    );
  }
});

test('export file names are stripped of paths and forced to .pdf', () => {
  delete process.env.EXPORT_ROOT;
  assert.equal(targets.safeFileName('plan 2024.pdf'), 'plan 2024.pdf');
  assert.equal(targets.safeFileName('plan2024'), 'plan2024.pdf');
  assert.equal(targets.safeFileName('../../etc/passwd'), 'passwd.pdf');
  assert.equal(targets.safeFileName('a<b>c:d"e|f?g*h.pdf'), 'abcdefgh.pdf');
  // Digits, spaces and Japanese must survive — an over-eager character range
  // here silently mangles every file name.
  assert.equal(targets.safeFileName('図面-01.pdf'), '図面-01.pdf');
  assert.equal(targets.safeFileName('報告書'), '報告書.pdf');
  assert.equal(targets.safeFileName('   '), 'document-marked.pdf');
  assert.equal(targets.safeFileName('...'), 'document-marked.pdf');
  assert.equal(targets.safeFileName(null), 'document-marked.pdf');
});

test('saving overwrites atomically and leaves no temp files', async () => {
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-write-'));
  process.env.EXPORT_ROOT = dir;

  try {
    const first = await targets.writeToFolder('.', 'plan.pdf', Buffer.from('%PDF one'));
    assert.equal((await fsp.readFile(first.path)).toString(), '%PDF one');

    await assert.rejects(
      targets.writeToFolder('.', 'plan.pdf', Buffer.from('%PDF two')),
      (error) => error.status === 409,
      'an existing file must not be replaced silently',
    );

    await targets.writeToFolder('.', 'plan.pdf', Buffer.from('%PDF two'), { overwrite: true });
    assert.equal((await fsp.readFile(first.path)).toString(), '%PDF two');

    const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the temp file must be renamed or removed');
  } finally {
    delete process.env.EXPORT_ROOT;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a locked target reports 423 and leaves the previous file intact', async (t) => {
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-lock-'));
  process.env.EXPORT_ROOT = dir;

  try {
    const saved = await targets.writeToFolder('.', 'plan.pdf', Buffer.from('%PDF original'));
    // Read-only stands in for the EBUSY a PDF viewer holding the file produces.
    await fsp.chmod(saved.path, 0o444);

    let error = null;
    try {
      await targets.writeToFolder('.', 'plan.pdf', Buffer.from('%PDF replacement'), {
        overwrite: true,
      });
    } catch (thrown) {
      error = thrown;
    }

    if (!error) {
      t.skip('the filesystem ignored the read-only bit (running as root?)');
      return;
    }

    assert.equal(error.status, 423);
    assert.equal(error.code, 'ELOCKED_PDF');
    assert.match(error.message, /open in another program/);
    // The whole point of writing via a temp file: the old export survives.
    assert.equal((await fsp.readFile(saved.path)).toString(), '%PDF original');
    assert.deepEqual(
      (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
    );
    await fsp.chmod(saved.path, 0o666);
  } finally {
    delete process.env.EXPORT_ROOT;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------ pasted images */

// Smallest valid JPEG that round-trips: an 8x8 block.
const SAMPLE_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEB' +
  'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
  'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
  'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiiiiiiiiiiiiiii' +
  'iiiiiiiv/9k=';

const imageMark = (over = {}) => ({
  page: 1,
  x: 150,
  y: 300,
  w: 240,
  h: 240,
  image: { data: SAMPLE_JPEG, pixelWidth: 8, pixelHeight: 8 },
  ...over,
});

test('image marks are validated before anything is embedded', () => {
  const [ok] = validateMarks([imageMark()], 1);
  assert.equal(ok.kind, 'image');
  assert.equal(ok.pixelWidth, 8);
  assert.ok(Buffer.isBuffer(ok.jpeg));

  // The PDF stream is declared DCTDecode, so non-JPEG bytes would produce a
  // file no viewer can open — they must be refused here, not written.
  assert.throws(
    () => validateMarks([imageMark({ image: { data: 'aGVsbG8=', pixelWidth: 4, pixelHeight: 4 } })], 1),
    /not a JPEG/,
  );
  assert.throws(
    () => validateMarks([imageMark({ image: { data: SAMPLE_JPEG } })], 1),
    /pixelWidth/,
  );
  assert.throws(() => validateMarks([imageMark({ w: 0 })], 1), /empty image box/);
  assert.throws(() => validateMarks([imageMark({ x: 'nope' })], 1), /finite/);
});

integration('a pasted image is embedded as a /Stamp with the original bytes', async () => {
  const zlib = await import('node:zlib');
  const { burnAnnotations } = await import('../src/services/annotate.js');

  const marks = validateMarks(
    [
      { page: 1, width: 2, points: [{ x: 60, y: 60 }, { x: 200, y: 120 }] },
      imageMark(),
    ],
    1,
  );
  const annotated = await burnAnnotations(buildFixturePdf(), marks);

  const { openDocument } = await import('../src/services/pdfParser.js');
  const { doc } = await openDocument(annotated);
  try {
    const page = await doc.getPage(1);
    const annots = await page.getAnnotations();
    // Ink and image marks have to coexist in one export.
    assert.deepEqual(annots.map((a) => a.subtype).sort(), ['Ink', 'Stamp']);

    const stamp = annots.find((a) => a.subtype === 'Stamp');
    // Viewport y 300..540 on an 842pt page flips to user space 302..542.
    const [x0, y0, x1, y1] = stamp.rect.map(Math.round);
    assert.deepEqual([x0, y0, x1, y1], [150, 302, 390, 542]);
  } finally {
    await doc.destroy();
  }

  // The embedded stream must be exactly the JPEG that was pasted.
  const latin = Buffer.from(annotated).toString('latin1');
  const start = latin.indexOf('stream', latin.indexOf('/Subtype /Image')) + 'stream'.length + 1;
  const end = latin.indexOf('endstream', start);
  const stored = zlib.inflateSync(Buffer.from(annotated).subarray(start, end));
  assert.ok(stored.equals(Buffer.from(SAMPLE_JPEG, 'base64')), 'image bytes were altered');
});

integration('an export with images leaves later parsing unaffected', async () => {
  // The image path installs an OffscreenCanvas shim; text extraction must not
  // start behaving differently because of it.
  const { burnAnnotations } = await import('../src/services/annotate.js');
  await burnAnnotations(buildFixturePdf(), validateMarks([imageMark()], 1));

  const reparsed = await parsePdf(buildFixturePdf());
  const record2 = { pages: reparsed.pages, totalPages: reparsed.totalPages };
  assert.equal(searchDocument(record2, 'SA').totalMatches, 3);
  assert.equal(searchDocument(record2, 'ｽﾃﾝﾊﾟｲﾌﾟ').totalMatches, 1);
});
