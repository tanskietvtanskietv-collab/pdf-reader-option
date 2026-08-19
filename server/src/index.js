import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import pdfRouter from './routes/pdf.js';
import { getAllCategories } from './data/categories.js';
import { startSweeper, shutdown, listDocuments, config } from './services/documentStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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
