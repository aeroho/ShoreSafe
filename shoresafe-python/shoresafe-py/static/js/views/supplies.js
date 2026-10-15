import { html, setHTML, $, $$, toast, titleCase, daysUntil, fmtDay, qtyUnit } from '../util.js';
import { icons } from '../icons.js';
import { api, ApiError, isOfflineError } from '../api.js';
import { cached } from '../data.js';
import { state } from '../state.js';

let filter = 'all';
const STATUS = { met: ['ok', 'Ready'], short: ['warn', 'Short'], missing: ['alarm', 'Missing'] };

function expiryPill(item) {
  if (!item.expires_at) return '';
  const d = daysUntil(item.expires_at);
  if (d < 0) return html`<span class="pill alarm">Expired ${fmtDay(item.expires_at)}</span>`;
  if (d <= 30) return html`<span class="pill warn">${d === 0 ? 'Expires today' : `Expires in ${d} day${d === 1 ? '' : 's'}`}</span>`;
  return html`<span>Expires ${fmtDay(item.expires_at)}</span>`;
}

export function mount(root) {
  let items = [];
  let gaps = null;
  let meta = null;
  let alive = true;
  const timers = new Map();

  async function load(redraw = true) {
    try {
      meta = await cached('inventory', '/api/inventory');
      if (!alive) return;
      items = meta.data.items;
      gaps = meta.data.gaps;
      if (redraw) draw();
    } catch (e) {
      if (!alive) return;
      setHTML(root, html`<div class="empty"><p>We couldn't load your supplies.</p>
        <p class="mt-1"><button class="btn btn-quiet" data-retry>Try again</button></p></div>`);
      $('[data-retry]', root).addEventListener('click', () => load());
    }
  }

  function draw() {
    const online = navigator.onLine;
    const cfg = state.config;
    const present = [...new Set(items.map((i) => i.category))];
    if (filter !== 'all' && !present.includes(filter)) filter = 'all';
    const shown = items.filter((i) => filter === 'all' || i.category === filter);

    setHTML(root, html`<div class="stack-lg">
      <div class="page-head"><h1>Supplies</h1><p>Log what you have so ShoreSafe can show what's missing.</p></div>
      ${!online && html`<div class="banner banner-warn">${icons.wifiOff}<div><strong>You're offline</strong>
        Your supplies are shown read-only. Connect to the internet to make changes.</div></div>`}

      ${gaps && html`<section class="section"><h2 class="mb-2">What your household needs</h2>
        <ul class="list boxed">${gaps.needs.map((n) => html`<li class="need">
          <strong>${n.label}</strong><span class="pill ${STATUS[n.status][0]}">${STATUS[n.status][1]}</span>
          <span class="muted small">Have ${n.have} of ${qtyUnit(n.required, n.unit)}${n.gap > 0 ? `. Need ${n.gap} more.` : ''}</span></li>`)}</ul></section>`}

      <details class="fold" ${items.length === 0 ? 'open' : ''}>
        <summary>Add a supply</summary>
        <div class="fold-body"><form data-add class="stack" novalidate>
          <div class="form-grid two">
            <label class="field"><span>Name</span><input class="input" name="name" maxlength="120" required placeholder="Bottled water" ${online ? '' : 'disabled'}></label>
            <label class="field"><span>Category</span><select class="select" name="category" ${online ? '' : 'disabled'}>
              ${cfg.inventory_categories.map((c) => html`<option value="${c}">${titleCase(c)}</option>`)}</select></label>
            <label class="field"><span>Quantity</span><input class="input" name="quantity" type="number" min="0" max="100000" value="1" inputmode="numeric" ${online ? '' : 'disabled'}></label>
            <label class="field"><span>Priority</span><select class="select" name="priority" ${online ? '' : 'disabled'}>
              <option value="essential">Essential: grab first</option><option value="important" selected>Important: grab if time</option><option value="optional">Optional: nice to have</option></select></label>
            <label class="field"><span>Where it's kept</span><input class="input" name="location" maxlength="120" placeholder="Garage shelf" ${online ? '' : 'disabled'}></label>
            <label class="field"><span>Expires</span><input class="input" name="expires_at" type="date" ${online ? '' : 'disabled'}></label>
          </div>
          <label class="field"><span>Notes</span><input class="input" name="notes" maxlength="500" ${online ? '' : 'disabled'}></label>
          <div data-form-error></div>
          <button class="btn" type="submit" ${online ? '' : 'disabled'}>Add supply</button>
        </form></div>
      </details>

      <section class="section">
        <div class="section-head"><h2>Your supplies</h2><span class="muted">${items.length} item${items.length === 1 ? '' : 's'}</span></div>
        ${present.length > 1 && html`<div class="chips mb-2" role="group" aria-label="Filter by category">
          ${['all', ...present].map((c) => html`<button class="chip" type="button" data-filter="${c}" aria-pressed="${filter === c ? 'true' : 'false'}">${c === 'all' ? 'All' : titleCase(c)}</button>`)}</div>`}
        ${shown.length === 0
          ? html`<div class="empty">Nothing logged yet. Add water, food, batteries, and documents to start.</div>`
          : html`<ul class="list boxed">${shown.map((i) => html`<li class="supply" data-item="${i.id}">
              <span class="supply-name">${i.name}</span>
              <span class="row">
                <span class="qty"><button class="icon-btn" data-qty="${i.id}" data-delta="-1" aria-label="One fewer ${i.name}" ${online ? '' : 'disabled'}>−</button>
                  <output data-qty-out="${i.id}">${i.quantity}</output>
                  <button class="icon-btn" data-qty="${i.id}" data-delta="1" aria-label="One more ${i.name}" ${online ? '' : 'disabled'}>+</button></span>
                <button class="icon-btn" data-del="${i.id}" aria-label="Delete ${i.name}" ${online ? '' : 'disabled'}>${icons.trash}</button>
              </span>
              <span class="supply-meta">
                <span class="pill">${titleCase(i.category)}</span>
                <select class="select btn-small" data-priority="${i.id}" aria-label="Priority for ${i.name}" ${online ? '' : 'disabled'}>
                  ${['essential', 'important', 'optional'].map((p) => html`<option value="${p}" ${i.priority === p ? 'selected' : ''}>${titleCase(p)}</option>`)}</select>
                ${i.location && html`<span>${i.location}</span>`}
                ${expiryPill(i)}
              </span>
              ${i.notes && html`<span class="supply-meta">${i.notes}</span>`}
            </li>`)}</ul>`}
      </section>
    </div>`);
  }

  function fail(err) {
    toast(isOfflineError(err) ? "Couldn't reach the server. Check your connection." : err instanceof ApiError ? err.message : 'Something went wrong.', 'error');
  }

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-add]')) return;
    e.preventDefault();
    const f = e.target;
    const body = {
      name: f.name.value.trim(), category: f.category.value, quantity: Number(f.quantity.value),
      priority: f.priority.value, location: f.location.value.trim(), notes: f.notes.value.trim(),
      expires_at: f.expires_at.value || null,
    };
    if (!body.name) { setHTML($('[data-form-error]', root), html`<div class="form-error">Enter a name for the supply.</div>`); return; }
    if (!Number.isInteger(body.quantity)) { setHTML($('[data-form-error]', root), html`<div class="form-error">Quantity must be a whole number.</div>`); return; }
    try {
      await api('POST', '/api/inventory', body);
      toast(`Added ${body.name}`);
      await load();
    } catch (err) {
      setHTML($('[data-form-error]', root), html`<div class="form-error">${err instanceof ApiError ? err.message : "Couldn't reach the server."}</div>`);
    }
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.filter) { filter = b.dataset.filter; draw(); return; }
    if (b.dataset.del) {
      const item = items.find((i) => i.id === Number(b.dataset.del));
      if (!confirm(`Delete ${item ? item.name : 'this item'}?`)) return;
      try { await api('DELETE', `/api/inventory/${b.dataset.del}`); await load(); } catch (err) { fail(err); }
    } else if (b.dataset.qty) {
      const id = Number(b.dataset.qty);
      const item = items.find((i) => i.id === id);
      if (!item) return;
      item.quantity = Math.max(0, item.quantity + Number(b.dataset.delta));
      $(`[data-qty-out="${id}"]`, root).textContent = item.quantity;
      clearTimeout(timers.get(id));
      // Wait for a pause in tapping, then save once and refresh the gap numbers.
      timers.set(id, setTimeout(async () => {
        try { await api('PATCH', `/api/inventory/${id}`, { quantity: item.quantity }); await load(); } catch (err) { fail(err); }
      }, 600));
    }
  });

  root.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-priority]');
    if (!sel) return;
    try { await api('PATCH', `/api/inventory/${sel.dataset.priority}`, { priority: sel.value }); await load(false); } catch (err) { fail(err); load(); }
  });

  const onNet = () => { if (alive && meta) draw(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  setHTML(root, html`<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`);
  load();
  return () => { alive = false; timers.forEach(clearTimeout); window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); };
}
