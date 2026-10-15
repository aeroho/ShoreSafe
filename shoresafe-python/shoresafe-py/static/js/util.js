// Tiny helpers. All user-supplied text goes through html`...` which escapes it,
// so a checklist item named "<script>..." is shown as text and never runs.

class Safe {
  constructor(s) { this.s = s; }
}

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Safe(out);
}

export function raw(s) { return new Safe(s); }

export function setHTML(el, template) {
  el.innerHTML = template instanceof Safe ? template.s : esc(template);
  // CSP forbids inline style attributes, so bar and gauge widths travel as data-pct.
  el.querySelectorAll('[data-pct]').forEach((n) => n.style.setProperty('--pct', n.dataset.pct));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function titleCase(s) {
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
  return `${Math.round(secs / 86400)} days ago`;
}

// "2027-03-15" -> local Date (avoids the off-by-one you get from new Date("2027-03-15")).
export function parseDay(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysUntil(str) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDay(str) - today) / 86400000);
}

export function fmtDay(str) {
  return parseDay(str).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

let toastHost;
export function toast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind === 'error' ? 'error' : ''}`;
  t.textContent = message;
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
}

const SINGULAR = { gallons: 'gallon', items: 'item', doses: 'dose', kits: 'kit', days: 'day' };
/** "1 kit", "2 kits": unit names come from the server in plural form. */
export function qtyUnit(n, unit) {
  return `${n} ${n === 1 ? (SINGULAR[unit] || unit) : unit}`;
}
