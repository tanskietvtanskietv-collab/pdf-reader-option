import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Session cache for parsed documents.
 *
 * The spatial index (text + typed arrays + text item geometry) lives in process
 * memory keyed by docId; the original PDF bytes are spilled to a temp directory
 * so the viewer can stream them without keeping every file on the heap.
 *
 * Memory management (see spec): entries expire after TTL, a sweeper runs on an
 * interval, the total number of live documents is capped (oldest evicted first),
 * and a client can drop its previous document when it uploads a new one.
 */

const TTL_MS = Number(process.env.DOC_TTL_MS || 60 * 60 * 1000); // 1 hour
const SWEEP_INTERVAL_MS = Number(process.env.DOC_SWEEP_MS || 5 * 60 * 1000);
const MAX_DOCUMENTS = Number(process.env.DOC_MAX || 12);

const documents = new Map(); // docId -> record
let tempDirPromise = null;

function tempDir() {
  if (!tempDirPromise) {
    tempDirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'pdf-term-reader-'));
  }
  return tempDirPromise;
}

async function writeTempFile(docId, buffer) {
  const dir = await tempDir();
  // Re-create the directory if a shutdown or the OS temp cleaner removed it.
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${docId}.pdf`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * @param {object} input
 * @param {string} input.fileName
 * @param {Buffer} input.buffer
 * @param {{ totalPages:number, pages:Array }} input.index
 * @returns {Promise<object>} the stored record
 */
export async function createDocument({ fileName, buffer, index }) {
  const docId = randomUUID();
  const filePath = await writeTempFile(docId, buffer);

  const record = {
    docId,
    fileName,
    filePath,
    byteSize: buffer.length,
    totalPages: index.totalPages,
    pages: index.pages,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  };

  documents.set(docId, record);
  await enforceCapacity();
  return record;
}

export function getDocument(docId) {
  const record = documents.get(docId);
  if (!record) return null;
  if (Date.now() - record.lastAccess > TTL_MS) {
    void deleteDocument(docId);
    return null;
  }
  record.lastAccess = Date.now();
  return record;
}

export async function deleteDocument(docId) {
  const record = documents.get(docId);
  if (!record) return false;
  documents.delete(docId);
  // Drop references so the typed arrays can be collected immediately.
  record.pages = null;
  await fs.rm(record.filePath, { force: true }).catch(() => {});
  return true;
}

export function listDocuments() {
  return [...documents.values()].map((record) => ({
    docId: record.docId,
    fileName: record.fileName,
    totalPages: record.totalPages,
    byteSize: record.byteSize,
    createdAt: new Date(record.createdAt).toISOString(),
    lastAccess: new Date(record.lastAccess).toISOString(),
  }));
}

async function enforceCapacity() {
  if (documents.size <= MAX_DOCUMENTS) return;
  const byAge = [...documents.values()].sort((a, b) => a.lastAccess - b.lastAccess);
  const excess = documents.size - MAX_DOCUMENTS;
  for (let i = 0; i < excess; i++) {
    await deleteDocument(byAge[i].docId);
  }
}

export async function sweepExpired(now = Date.now()) {
  const expired = [...documents.values()].filter((r) => now - r.lastAccess > TTL_MS);
  for (const record of expired) await deleteDocument(record.docId);
  return expired.length;
}

export function startSweeper() {
  const timer = setInterval(() => {
    sweepExpired().catch(() => {});
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export async function shutdown() {
  for (const docId of [...documents.keys()]) await deleteDocument(docId);
  if (tempDirPromise) {
    const dir = await tempDirPromise;
    tempDirPromise = null; // a later upload must mkdtemp again, not reuse a deleted path
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const config = { TTL_MS, SWEEP_INTERVAL_MS, MAX_DOCUMENTS };
