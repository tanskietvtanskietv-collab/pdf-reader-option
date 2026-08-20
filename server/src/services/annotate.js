import { openDocument } from './pdfParser.js';

/**
 * Burn client-drawn marks into a copy of the PDF as real `/Ink` annotations.
 *
 * No extra dependency: pdf.js's own annotation writer produces the objects and
 * `saveDocument()` appends them as an incremental update, so the original bytes
 * — and the text layer searches depend on — are left untouched.
 *
 * Marks arrive in the app's usual coordinate space (**viewport points, top-left
 * origin, scale 1**). `viewport.convertToPdfPoint()` maps them into PDF user
 * space, which also handles pages carrying a /Rotate entry; doing that maths by
 * hand is the easy way to put every mark on a rotated drawing in the wrong spot.
 */

const MAX_MARKS = 2000;
const MAX_POINTS_PER_MARK = 5000;
const DEFAULT_COLOR = [232, 38, 43]; // the client's annotation red

export function validateMarks(marks, totalPages) {
  if (!Array.isArray(marks) || marks.length === 0) {
    throw badRequest('marks must be a non-empty array');
  }
  if (marks.length > MAX_MARKS) {
    throw badRequest(`Too many marks (${marks.length}); the limit is ${MAX_MARKS}`);
  }

  return marks.map((mark, index) => {
    const page = Number(mark?.page);
    if (!Number.isInteger(page) || page < 1 || page > totalPages) {
      throw badRequest(`marks[${index}].page must be between 1 and ${totalPages}`);
    }

    const points = Array.isArray(mark?.points) ? mark.points : [];
    if (points.length === 0 || points.length > MAX_POINTS_PER_MARK) {
      throw badRequest(`marks[${index}].points must hold 1..${MAX_POINTS_PER_MARK} points`);
    }
    const clean = points.map((point, p) => {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw badRequest(`marks[${index}].points[${p}] is not a finite coordinate`);
      }
      return { x, y };
    });

    const width = Number(mark?.width);
    return {
      page,
      points: clean,
      width: Number.isFinite(width) ? Math.min(Math.max(width, 0.1), 72) : 2,
    };
  });
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * pdf.js expects each ink stroke as `{ points, lines }`:
 *   points — a flat [x, y, x, y, …] list, written straight into /InkList
 *   lines  — the appearance stream path: the first point sits at index 4/5, then
 *            one 6-slot group per point whose first slot is NaN for a lineTo
 *            (a non-NaN slot would be read as a bezier control point instead).
 */
function inkAnnotation(pageIndex, points, width, color) {
  const flat = [];
  const line = [NaN, NaN, NaN, NaN, points[0].x, points[0].y];
  for (const point of points) flat.push(point.x, point.y);
  for (const point of points.slice(1)) line.push(NaN, NaN, NaN, NaN, point.x, point.y);

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = width; // the stroke is centred on the path, so the box needs slack

  return {
    annotationType: 15, // AnnotationEditorType.INK
    pageIndex,
    color,
    opacity: 1,
    thickness: width,
    paths: { points: [flat], lines: [line] },
    rect: [
      Math.min(...xs) - pad,
      Math.min(...ys) - pad,
      Math.max(...xs) + pad,
      Math.max(...ys) + pad,
    ],
    rotation: 0,
  };
}

/**
 * @param {Buffer|Uint8Array} buffer original PDF bytes
 * @param {Array<{page:number, points:Array<{x:number,y:number}>, width:number}>} marks
 * @returns {Promise<Uint8Array>} the annotated PDF
 */
export async function burnAnnotations(buffer, marks, { color = DEFAULT_COLOR } = {}) {
  const { doc } = await openDocument(buffer);

  try {
    // One viewport per page, not per mark: getPage/getViewport is not free.
    const viewports = new Map();
    const viewportFor = async (pageNumber) => {
      if (!viewports.has(pageNumber)) {
        const page = await doc.getPage(pageNumber);
        viewports.set(pageNumber, page.getViewport({ scale: 1 }));
      }
      return viewports.get(pageNumber);
    };

    let index = 0;
    for (const mark of marks) {
      const viewport = await viewportFor(mark.page);
      const points = mark.points.map((point) => {
        const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
        return { x: round2(x), y: round2(y) };
      });

      doc.annotationStorage.setValue(
        `pdfjs_internal_editor_${index++}`,
        inkAnnotation(mark.page - 1, points, mark.width, color),
      );
    }

    return await doc.saveDocument();
  } finally {
    await doc.destroy().catch(() => {});
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
