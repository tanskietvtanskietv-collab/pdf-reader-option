/**
 * Copies the pdf.js CMap and standard font tables into `public/pdfjs/` so the
 * browser viewer can render Japanese (Adobe-Japan1) documents offline.
 * Runs automatically from the `predev` / `prebuild` npm scripts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '../public/pdfjs');

let pdfjsRoot;
try {
  pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
} catch {
  console.warn('[copy-pdfjs-assets] pdfjs-dist is not installed yet, skipping.');
  process.exit(0);
}

for (const dir of ['cmaps', 'standard_fonts']) {
  const from = path.join(pdfjsRoot, dir);
  const to = path.join(target, dir);
  try {
    await fs.rm(to, { recursive: true, force: true });
    await fs.cp(from, to, { recursive: true });
    const files = await fs.readdir(to);
    console.log(`[copy-pdfjs-assets] ${dir}: ${files.length} files -> public/pdfjs/${dir}`);
  } catch (error) {
    console.warn(`[copy-pdfjs-assets] could not copy ${dir}:`, error.message);
  }
}
