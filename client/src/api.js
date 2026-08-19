/** Thin wrapper around the Node backend. All coordinates come from the server. */

const BASE = '/api';

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

export function releaseDocument(docId) {
  return fetch(`${BASE}/pdf/${docId}`, { method: 'DELETE' }).then(asJson);
}

export function documentFileUrl(docId) {
  return `${BASE}/pdf/${docId}/file`;
}
