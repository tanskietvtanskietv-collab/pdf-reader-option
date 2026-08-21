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
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
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
    return mark?.image ? validateImageMark(mark, page, index) : validateInkMark(mark, page, index);
  });
}

function validateInkMark(mark, page, index) {
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
    kind: 'ink',
    page,
    points: clean,
    width: Number.isFinite(width) ? Math.min(Math.max(width, 0.1), 72) : 2,
  };
}

/** A pasted screenshot: JPEG bytes plus the box it should occupy on the page. */
function validateImageMark(mark, page, index) {
  const box = ['x', 'y', 'w', 'h'].map((key) => {
    const value = Number(mark[key]);
    if (!Number.isFinite(value)) {
      throw badRequest(`marks[${index}].${key} is not a finite number`);
    }
    return value;
  });
  const [x, y, w, h] = box;
  if (w <= 0 || h <= 0) throw badRequest(`marks[${index}] has an empty image box`);

  const data = String(mark.image?.data ?? '');
  if (!data) throw badRequest(`marks[${index}].image.data is required`);

  const jpeg = Buffer.from(data, 'base64');
  // Reject anything that is not actually a JPEG: the PDF stream is declared
  // DCTDecode, so other bytes would produce a file no viewer can open.
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff) {
    throw badRequest(`marks[${index}].image.data is not a JPEG`);
  }
  if (jpeg.length > MAX_IMAGE_BYTES) {
    throw badRequest(`marks[${index}] image is larger than ${MAX_IMAGE_BYTES} bytes`);
  }

  const pixelWidth = Math.round(Number(mark.image?.pixelWidth));
  const pixelHeight = Math.round(Number(mark.image?.pixelHeight));
  if (!(pixelWidth > 0) || !(pixelHeight > 0)) {
    throw badRequest(`marks[${index}].image needs positive pixelWidth/pixelHeight`);
  }

  return { kind: 'image', page, x, y, w, h, jpeg, pixelWidth, pixelHeight };
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
/* --------------------------------------------------------- pasted images --
 * pdf.js can embed a bitmap as a /Stamp annotation, but its writer builds the
 * image through an OffscreenCanvas, which Node does not have. Reading that code
 * shows the canvas is used for exactly two things: encoding the pixels to JPEG,
 * and scanning the alpha channel to decide whether an SMask is needed.
 *
 * The client already encoded a JPEG with a real canvas, and JPEG has no alpha,
 * so both answers are known before we start. This shim carries those bytes
 * through and reports "fully opaque" — no pixel work, no native dependency.
 */
class CarrierCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.source = null;
  }

  getContext() {
    const canvas = this;
    return {
      fillStyle: '',
      drawImage(bitmap) {
        canvas.source = bitmap;
      },
      fillRect() {},
      getImageData(_x, _y, w, h) {
        // All 0xff: `hasAlpha` stays false and pdf.js skips the SMask entirely.
        return { data: new Uint8ClampedArray(w * h * 4).fill(255) };
      },
    };
  }

  convertToBlob() {
    const jpeg = this.source?.jpeg;
    return Promise.resolve({
      arrayBuffer: async () =>
        jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
    });
  }
}

function installCanvasShim() {
  if (typeof globalThis.OffscreenCanvas === 'undefined') {
    globalThis.OffscreenCanvas = CarrierCanvas;
  }
}

/**
 * `AnnotationStorage.serializable` pushes every `value.bitmap` onto a structured
 * clone transfer list, which only accepts real transferables — our carrier object
 * is not one. In Node the worker runs in-process, so nothing needs transferring;
 * shadowing the getter with an empty list is enough.
 */
function clearBitmapTransfers(storage) {
  const inherited = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(storage),
    'serializable',
  )?.get;
  if (!inherited) return;

  Object.defineProperty(storage, 'serializable', {
    configurable: true,
    get() {
      const value = inherited.call(this);
      return value?.map?.size ? { ...value, transfer: [] } : value;
    },
  });
}

function stampAnnotation(pageIndex, mark, rect, bitmapId) {
  return {
    annotationType: 13, // AnnotationEditorType.STAMP
    pageIndex,
    bitmapId,
    bitmap: { width: mark.pixelWidth, height: mark.pixelHeight, jpeg: mark.jpeg },
    rect,
    rotation: 0,
  };
}

export async function burnAnnotations(buffer, marks, { color = DEFAULT_COLOR } = {}) {
  const hasImages = marks.some((mark) => mark.kind === 'image');
  if (hasImages) installCanvasShim();

  const { doc } = await openDocument(buffer, { withImages: hasImages });
  if (hasImages) clearBitmapTransfers(doc.annotationStorage);

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
      const key = `pdfjs_internal_editor_${index++}`;

      if (mark.kind === 'image') {
        // Two opposite corners through the same conversion, then normalised —
        // the flip means the viewport's top-left becomes the PDF bottom-left.
        const [x0, y0] = viewport.convertToPdfPoint(mark.x, mark.y);
        const [x1, y1] = viewport.convertToPdfPoint(mark.x + mark.w, mark.y + mark.h);
        const rect = [
          round2(Math.min(x0, x1)),
          round2(Math.min(y0, y1)),
          round2(Math.max(x0, x1)),
          round2(Math.max(y0, y1)),
        ];
        doc.annotationStorage.setValue(key, stampAnnotation(mark.page - 1, mark, rect, key));
        continue;
      }

      const points = mark.points.map((point) => {
        const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
        return { x: round2(x), y: round2(y) };
      });
      doc.annotationStorage.setValue(key, inkAnnotation(mark.page - 1, points, mark.width, color));
    }

    return await doc.saveDocument();
  } finally {
    await doc.destroy().catch(() => {});
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
