// Thin fetch wrapper for every authenticated API call. Centralizes JSON
// (de)serialization, error surfacing, and 401 handling — a session that's
// expired or been revoked (see auth_sessions) redirects to /login instead
// of leaving each section to fail silently or show stale data.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, opts);

  if (res.status === 401) {
    if (window.location.pathname !== '/login') window.location.href = '/login';
    throw new ApiError('Unauthorized', 401);
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError((data && data.error) || res.statusText || 'Request failed', res.status);
  }
  return data;
}

export const api = {
  get:  (path)       => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put:  (path, body) => request('PUT', path, body ?? {}),
  del:  (path)        => request('DELETE', path)
};
