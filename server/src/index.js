import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import pdfRouter from './routes/pdf.js';
import { getAllCategories } from './data/categories.js';
import { startSweeper, shutdown, listDocuments, config } from './services/documentStore.js';
import { listFolders, exportRoot, isExportEnabled } from './services/exportTargets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(cors());
// Annotation payloads (long freehand strokes) are far bigger than the JSON the
// search endpoints take, so the limit is generous.
app.use(express.json({ limit: process.env.MAX_JSON_BYTES || '8mb' }));

app.get('/api/health', (_req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    documents: listDocuments().length,
    cache: config,
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
  });
});

/** Dictionaries live on the server so the client and the API cannot drift. */
app.get('/api/categories', (_req, res) => {
  res.json({ categories: getAllCategories() });
});

/**
 * Folder picker for "Save as PDF". Lists directories **on the machine running
 * the server**, confined to EXPORT_ROOT (default: that user's home directory).
 * Never exposes file names, only folders.
 */
app.get('/api/folders', async (req, res, next) => {
  try {
    res.json(await listFolders(req.query.path));
  } catch (error) {
    next(error);
  }
});

app.get('/api/folders/enabled', (_req, res) => {
  res.json({ enabled: isExportEnabled(), root: isExportEnabled() ? exportRoot() : null });
});

app.use('/api/pdf', pdfRouter);

// Serve the built Vue client when it exists (npm run build).
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`PDF term reader API listening on http://${HOST}:${PORT}`);
});

startSweeper();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      shutdown().finally(() => process.exit(0));
    });
  });
}

export default app;
