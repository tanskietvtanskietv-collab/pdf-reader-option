/**
 * Builds a small PDF fixture by hand (no extra dependency) containing:
 *   - Latin labels with regex-hostile characters:  (H)  (B)  24-  BS-  CH=  V-15
 *   - Japanese labels in a CID font with the predefined UniJIS-UCS2-H encoding
 *   - Half-width katakana with a separate voiced mark (ﾊ + ﾟ), the exact case
 *     NFKC normalisation has to collapse before a match can be found
 *
 * Usage: node test/make-fixture.mjs [outPath]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** UTF-16BE hex string for a Type0 / UniJIS-UCS2-H show operator. */
function hexUtf16be(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  }
  return out;
}

const LATIN_LINES = [
  'SA DL CT WF PL PM FD VL FY VFM V10 V15 V-15 V-08 V-12',
  'CH=2400 (H) (B) 24- 24( BS- 33B E- E_ NO.7 FL+ SG611H',
  'BALCONY FINE TESURI  koubai yane  FUKIAGE  U-chi doma',
  'SA appears twice: SA',
];

const CJK_LINES = [
  '天井下がり 深基礎 壁下地 手摩 仏間',
  'ｽﾃﾝﾊﾟｲﾌﾟ ｱｰﾁﾀﾚ壁 勾配天井',
  '室内窓 窓 建具 ドア 補強 木目調天井パネル',
];

function buildContent() {
  const parts = [];
  let y = 780;

  for (const line of LATIN_LINES) {
    const escaped = line.replace(/([\\()])/g, '\\$1');
    parts.push(`BT /F1 11 Tf 40 ${y} Td (${escaped}) Tj ET`);
    y -= 26;
  }
  for (const line of CJK_LINES) {
    parts.push(`BT /F2 12 Tf 40 ${y} Td <${hexUtf16be(line)}> Tj ET`);
    y -= 26;
  }
  // A rotated label, the way CAD exports annotate vertical dimensions.
  parts.push(`BT /F2 12 Tf 0 1 -1 0 520 200 Tm <${hexUtf16be('高基礎')}> Tj ET`);

  return parts.join('\n');
}

export function buildFixturePdf() {
  const content = buildContent();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Ryumin-Light /Encoding /UniJIS-UCS2-H ' +
      '/DescendantFonts [7 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Ryumin-Light ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> ' +
      '/FontDescriptor 8 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /Ryumin-Light /Flags 6 /FontBBox [0 -137 1000 859] ' +
      '/ItalicAngle 0 /Ascent 859 /Descent -137 /CapHeight 769 /StemV 78 >>',
  ];

  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || path.join(here, 'fixtures', 'sample.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildFixturePdf());
  console.log(`Wrote ${out}`);
}
