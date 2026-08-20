/** Thin wrapper around the Node backend. All coordinates come from the server. */

/**
 * Relative by default, on purpose: in dev the page is served by Vite, so the
 * browser requests `/api/...` from the Vite origin and Vite proxies it to the
 * API — same origin, no CORS preflight. In production `npm start` serves the API
 * and client/dist from one origin, so the identical paths keep working.
 *
 * Set `VITE_API_BASE=http://localhost:3000` in `client/.env` to bypass the proxy
 * and call the API origin directly instead (the server already sends CORS
 * headers). Leave it unset unless you actually need cross-origin calls.
 */
const BASE = `${import.meta.env.VITE_API_BASE ?? ''}/api`;

async function asJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

export function fetchCategories() {
  return fetch(`${BASE}/categories`).then(asJson);
}

/**
 * @param {File} file
 * @param {string|null} previousDocId released server side to free its index
 * @param {(percent:number)=>void} [onProgress]
 */
export function uploadPdf(file, previousDocId, onProgress) {
  const form = new FormData();
  form.append('file', file);
  if (previousDocId) form.append('previousDocId', previousDocId);

  // XHR rather than fetch: upload progress matters for large drawing sets.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/pdf/upload`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

export function searchTerm(docId, query, category, options = {}) {
  return fetch(`${BASE}/pdf/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, query, category, ...options }),
  }).then(asJson);
}

export function searchBatch(docId, category, queries, options = {}) {
  return fetch(`${BASE}/pdf/search/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, category, queries, ...options }),
  }).then(asJson);
}

/**
 * Ask the server for a copy of the PDF with the marks burned in.
 * @returns {Promise<Blob>} the annotated PDF
 */
export async function exportAnnotatedPdf(docId, marks) {
  const response = await fetch(`${BASE}/pdf/${docId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Export failed (${response.status})`);
  }
  return response.blob();
}

/** Sub-folders of `path` on the server machine, for the save dialog. */
export function listFolders(path = '.') {
  return fetch(`${BASE}/folders?path=${encodeURIComponent(path)}`).then(asJson);
}

export function foldersEnabled() {
  return fetch(`${BASE}/folders/enabled`).then(asJson);
}

/**
 * Write the annotated PDF straight into a folder on the server machine.
 * @throws an Error with `.code === 'EEXIST_PDF'` when the file is already there
 */
export async function saveAnnotatedPdfTo(docId, marks, { destination, fileName, overwrite = false }) {
  const response = await fetch(`${BASE}/pdf/${docId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks, destination, fileName, overwrite }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Save failed (${response.status})`);
    if (response.status === 409) error.code = 'EEXIST_PDF';
    throw error;
  }
  return payload;
}

/** True when the browser can offer a real "Save As" folder picker. */
export function canPickSaveLocation() {
  // Needs a secure context: https, or http on localhost. Plain http on a LAN
  // address does not qualify, and the API is simply absent there.
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

/**
 * Open the save dialog. Must be called directly from the click handler, before
 * any awaits — the picker requires the transient user activation of that click,
 * and a network round trip first would consume it.
 * @returns {Promise<FileSystemFileHandle|null>} null when unsupported or cancelled
 */
export async function pickSaveLocation(suggestedName) {
  if (!canPickSaveLocation()) return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error; // the user cancelled: not a failure
    return null; // anything else: fall back to a plain download
  }
}

/** Write to the chosen file, or fall back to a normal browser download. */
export async function writePdf(blob, handle, fileName) {
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle.name;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}

export function releaseDocument(docId) {
  return fetch(`${BASE}/pdf/${docId}`, { method: 'DELETE' }).then(asJson);
}

export function documentFileUrl(docId) {
  return `${BASE}/pdf/${docId}/file`;
}
