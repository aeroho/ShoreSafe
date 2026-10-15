// Talks to the Python backend. Every write carries the X-Requested-With header the server requires.

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export class NetworkError extends Error {}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ShoreSafe' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError('No connection');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status >= 502) throw new NetworkError('Server unreachable'); // proxy errors: treat like being offline
  if (!res.ok) {
    if (res.status === 401) listeners.forEach((fn) => fn());
    throw new ApiError((data && data.error) || 'Request failed', res.status);
  }
  return data;
}

export const isOfflineError = (e) => e instanceof NetworkError;
