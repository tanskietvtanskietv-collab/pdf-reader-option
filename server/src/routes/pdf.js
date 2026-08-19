import { Router } from 'express';
import multer from 'multer';
import { parsePdf, pageSummary } from '../services/pdfParser.js';
import { searchDocument, searchDocumentBatch } from '../services/search.js';
import {
  createDocument,
  getDocument,
  deleteDocument,
  listDocuments,
} from '../services/documentStore.js';
import { getCategory, isCategory, CATEGORY_NAMES } from '../data/categories.js';

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const PDF_MAGIC = Buffer.from('%PDF-');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const mime = (file.mimetype || '').toLowerCase();
    const looksPdf = mime === 'application/pdf' || mime === 'application/x-pdf';
    if (!looksPdf && !/\.pdf$/i.test(file.originalname || '')) {
      cb(badRequest('Only application/pdf uploads are accepted'));
      return;
    }
    cb(null, true);
  },
});

export const router = Router();

function badRequest(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireDocument(req) {
  const record = getDocument(req.params.docId || req.body?.docId);
  if (!record) throw badRequest('Unknown or expired docId. Upload the document again.', 404);
  return record;
}

/* ------------------------------------------------------------------ upload */

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('No file received. Send multipart/form-data with a "file" field.');

    const buffer = req.file.buffer;
    // MIME can be spoofed by the browser; verify the actual file signature.
    if (!buffer.subarray(0, 1024).includes(PDF_MAGIC)) {
      throw badRequest('The uploaded file is not a valid PDF (missing %PDF- header)');
    }

    // Releasing the previous document keeps a single-tab session from stacking
    // spatial indices on the heap.
    if (req.body?.previousDocId) await deleteDocument(req.body.previousDocId);

    const startedAt = Date.now();
    const index = await parsePdf(buffer);
    const record = await createDocument({
      fileName: req.file.originalname || 'document.pdf',
      buffer,
      index,
    });

    res.json({
      docId: record.docId,
      totalPages: record.totalPages,
      fileName: record.fileName,
      byteSize: record.byteSize,
      parseMs: Date.now() - startedAt,
      pages: record.pages.map(pageSummary),
    });
  } catch (error) {
    next(error);
  }
});

/* -------------------------------------------------------------- document io */

router.get('/:docId', (req, res, next) => {
  try {
    const record = requireDocument(req);
    res.json({
      docId: record.docId,
      fileName: record.fileName,
      totalPages: record.totalPages,
      byteSize: record.byteSize,
      pages: record.pages.map(pageSummary),
    });
  } catch (error) {
    next(error);
  }
});

/** Raw PDF bytes for the client side renderer (supports range requests). */
router.get('/:docId/file', (req, res, next) => {
  try {
    const record = requireDocument(req);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(record.fileName)}"`);
    res.sendFile(record.filePath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Page geometry for the viewer. The client sizes its page container from this
 * before the canvas is rendered, so scrolling stays stable while pages stream
 * in lazily. `?include=text` also returns the normalised text layer of the page.
 */
router.get('/:docId/page/:pageNumber', (req, res, next) => {
  try {
    const record = requireDocument(req);
    const pageNumber = Number.parseInt(req.params.pageNumber, 10);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > record.totalPages) {
      throw badRequest(`pageNumber must be between 1 and ${record.totalPages}`);
    }

    const pageIndex = record.pages[pageNumber - 1];
    const payload = pageSummary(pageIndex);
    payload.fileUrl = `/api/pdf/${record.docId}/file`;
    if (req.query.include === 'text') payload.text = pageIndex.text;

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.delete('/:docId', async (req, res, next) => {
  try {
    const deleted = await deleteDocument(req.params.docId);
    res.json({ docId: req.params.docId, deleted });
  } catch (error) {
    next(error);
  }
});

router.get('/', (_req, res) => {
  res.json({ documents: listDocuments() });
});

/* ------------------------------------------------------------------ search */

function readSearchOptions(body) {
  return {
    caseInsensitive: body.caseInsensitive !== false,
    looseSpacing: body.looseSpacing === true,
    padding: Number.isFinite(body.padding) ? body.padding : 0.5,
  };
}

function validateCategory(category) {
  if (category === undefined || category === null || category === '') return null;
  if (!isCategory(category)) {
    throw badRequest(`category must be one of: ${CATEGORY_NAMES.join(', ')}`);
  }
  return category;
}

router.post('/search', (req, res, next) => {
  try {
    const record = requireDocument(req);
    const category = validateCategory(req.body?.category);
    const query = String(req.body?.query ?? '');
    if (!query.trim()) throw badRequest('query is required');

    const result = searchDocument(record, query, readSearchOptions(req.body ?? {}));
    res.json({ docId: record.docId, category, ...result });
  } catch (error) {
    next(error);
  }
});

/**
 * Count every term of a category (or an explicit list) in one round trip so the
 * whole right hand panel can be populated without ~90 requests.
 */
router.post('/search/batch', (req, res, next) => {
  try {
    const record = requireDocument(req);
    const category = validateCategory(req.body?.category);

    let queries = req.body?.queries;
    if (!Array.isArray(queries) || queries.length === 0) {
      if (!category) throw badRequest('Provide either a category or a non-empty queries array');
      queries = getCategory(category);
    }
    queries = queries.map((q) => String(q)).filter((q) => q.trim());

    const results = searchDocumentBatch(record, queries, readSearchOptions(req.body ?? {}));
    res.json({
      docId: record.docId,
      category,
      totalTerms: results.length,
      termsWithMatches: results.filter((r) => r.totalMatches > 0).length,
      results,
    });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------- errors */

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Internal server error' });
});

export default router;
