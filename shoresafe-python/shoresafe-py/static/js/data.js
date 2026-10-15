// Loads data from the server, keeps an on-device copy, and queues check-offs made offline.
import { api, isOfflineError, ApiError } from './api.js';
import { store } from './store.js';

/** GET a path; if we're offline fall back to the saved copy. Returns { data, stale, at }. */
export async function cached(name, path) {
  try {
    const data = await api('GET', path);
    const at = new Date().toISOString();
    store.set(name, { data, at });
    return { data, stale: false, at };
  } catch (e) {
    if (isOfflineError(e)) {
      const saved = store.get(name);
      if (saved) return { data: saved.data, stale: true, at: saved.at };
    }
    throw e;
  }
}

// ---------- offline check-off queue ----------

let seq = Date.now();
let flushing = false;
const listeners = new Set();
export const onSynced = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const pendingCount = () => (store.get('queue') || []).length;

function applyQueue(items, queue) {
  const byId = new Map(queue.map((q) => [q.id, q.is_checked]));
  return items.map((i) => (byId.has(i.id) ? { ...i, is_checked: byId.get(i.id) } : i));
}

/** Re-apply check-offs that haven't reached the server yet to a list loaded from it. */
export const applyPending = (items) => applyQueue(items, store.get('queue') || []);

/** Record a check-off immediately (works offline) and try to send it. */
export function setChecked(id, isChecked) {
  const local = store.get('checklist');
  if (local) {
    local.data.items = local.data.items.map((i) => (i.id === id ? { ...i, is_checked: isChecked } : i));
    store.set('checklist', local);
  }
  const queue = (store.get('queue') || []).filter((q) => q.id !== id);
  queue.push({ id, is_checked: isChecked, seq: ++seq });
  store.set('queue', queue);
  return flushQueue();
}

/** Send queued check-offs. Safe to call any time; does nothing if empty or already running. */
export async function flushQueue() {
  if (flushing) return false;
  let queue = store.get('queue') || [];
  if (!queue.length) return false;
  flushing = true;
  try {
    for (let guard = 0; queue.length && guard < 5; guard += 1) {
      const sent = queue;
      const maxSeq = Math.max(...sent.map((q) => q.seq));
      let out;
      try {
        out = await api('POST', '/api/checklist/sync', {
          changes: sent.map(({ id, is_checked }) => ({ id, is_checked })),
        });
      } catch (e) {
        if (e instanceof ApiError && e.status !== 401) store.set('queue', []); // server rejected it; don't retry forever
        return false;
      }
      // Keep anything the person checked while this request was in flight.
      const remaining = (store.get('queue') || []).filter((q) => q.seq > maxSeq);
      store.set('queue', remaining);
      store.set('checklist', { data: { items: applyQueue(out.items, remaining) }, at: new Date().toISOString() });
      queue = remaining;
    }
    listeners.forEach((fn) => fn());
    return true;
  } finally {
    flushing = false;
  }
}

/** Make the Home screen agree with check-offs that haven't reached the server yet. */
export function overlayPending(dashboard) {
  const queue = store.get('queue') || [];
  const local = store.get('checklist');
  if (!queue.length || !local) return dashboard;
  const done = new Set(queue.filter((q) => q.is_checked).map((q) => q.id));
  const items = local.data.items;
  const progress = {};
  for (const cat of ['evacuation', 'hunker_down']) {
    const inCat = items.filter((i) => i.category === cat);
    progress[cat] = { done: inCat.filter((i) => i.is_checked).length, total: inCat.length };
  }
  return {
    ...dashboard,
    progress,
    essentials: dashboard.essentials.filter((i) => !done.has(i.id)),
    actions: dashboard.actions
      .map((a) => ({ ...a, items: a.items.filter((i) => !done.has(i.id)) }))
      .filter((a) => a.kind === 'shelter' || a.items.length > 0),
  };
}
