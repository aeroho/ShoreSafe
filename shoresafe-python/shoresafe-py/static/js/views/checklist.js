import { html, setHTML, $, $$, toast } from '../util.js';
import { icons } from '../icons.js';
import { api, ApiError, isOfflineError } from '../api.js';
import { store } from '../store.js';
import { cached, setChecked, flushQueue, applyPending, pendingCount, onSynced } from '../data.js';

let tab = 'evacuation'; // remembered while the app is open
const TABS = [['evacuation', 'Evacuation'], ['hunker_down', 'Hunker down']];

export function mount(root) {
  let items = [];
  let meta = null;
  let alive = true;

  async function load() {
    await flushQueue();
    try {
      meta = await cached('checklist', '/api/checklist');
      if (!alive) return;
      items = applyPending(meta.data.items);
      draw();
    } catch (e) {
      if (!alive) return;
      setHTML(root, html`<div class="empty"><p>We couldn't load your checklist.</p>
        <p class="mt-1"><button class="btn btn-quiet" data-retry>Try again</button></p></div>`);
      $('[data-retry]', root).addEventListener('click', load);
    }
  }

  const inTab = () => items.filter((i) => i.category === tab);

  function progressHTML() {
    const list = inTab();
    const done = list.filter((i) => i.is_checked).length;
    const pct = list.length ? Math.round((done / list.length) * 100) : 0;
    return html`<div class="row-between"><span><strong data-done>${done} of ${list.length}</strong> done</span><span class="muted" data-pct-text>${pct}%</span></div>
      <div class="bar mt-1"><i data-pct="${pct}" data-bar></i></div>`;
  }

  function pendingBanner() {
    const n = pendingCount();
    if (!n) return '';
    return html`<div class="banner banner-info" data-pending>${icons.info}<div><strong>${n} change${n === 1 ? '' : 's'} saved on this device</strong>
      They'll sync automatically when you're back online.</div></div>`;
  }

  function draw() {
    const online = navigator.onLine;
    setHTML(root, html`<div class="stack">
      <div class="page-head"><h1>Checklists</h1><p>Check things off as you go. This works without internet.</p></div>
      ${meta.stale && html`<div class="banner banner-warn">${icons.wifiOff}<div><strong>You're offline</strong>
        Showing your last saved checklist. Check-offs are kept on this device and sync when you reconnect. Adding or removing items needs a connection.</div></div>`}
      <div data-pending-slot>${pendingBanner()}</div>
      <div class="tabs" role="tablist" aria-label="Checklist">
        ${TABS.map(([id, label]) => html`<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="${tab === id ? 'true' : 'false'}">${label}</button>`)}
      </div>
      <div data-progress>${progressHTML()}</div>
      <ul class="list boxed">${inTab().length === 0
        ? html`<li class="muted">Nothing here yet. Add your own item below.</li>`
        : inTab().map((i) => html`<li class="check">
            <input type="checkbox" id="c${i.id}" data-id="${i.id}" ${i.is_checked ? 'checked' : ''}>
            <label for="c${i.id}">${i.label} ${i.is_custom && html`<span class="pill">Yours</span>`}</label>
            ${i.is_custom && html`<button class="icon-btn" data-del="${i.id}" aria-label="Delete ${i.label}" ${online ? '' : 'disabled'}>${icons.trash}</button>`}
          </li>`)}</ul>
      <form class="add-row" data-add>
        <label class="sr-only" for="new-item">New item</label>
        <input class="input" id="new-item" maxlength="200" placeholder="Add your own item" ${online ? '' : 'disabled'}>
        <button class="btn" type="submit" ${online ? '' : 'disabled'}>Add</button>
      </form>
      <section class="section">
        <h3>Changed your household?</h3>
        <p class="muted small mt-1">Rebuild the checklist from your household settings. Items you've checked and items you added are kept.</p>
        <button class="btn btn-quiet mt-2" data-regen ${online ? '' : 'disabled'}>Update checklist</button>
      </section>
    </div>`);
  }

  function refreshProgress() {
    setHTML($('[data-progress]', root), progressHTML());
    const slot = $('[data-pending-slot]', root);
    setHTML(slot, pendingBanner());
  }

  root.addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox][data-id]');
    if (!box) return;
    const id = Number(box.dataset.id);
    items = items.map((i) => (i.id === id ? { ...i, is_checked: box.checked } : i));
    setChecked(id, box.checked).then(refreshProgress);
    refreshProgress();
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; draw(); return; }
    if (t.dataset.del) {
      try {
        await api('DELETE', `/api/checklist/${t.dataset.del}`);
        items = items.filter((i) => i.id !== Number(t.dataset.del));
        syncCache();
        draw();
      } catch (err) { fail(err); }
    } else if (t.hasAttribute('data-regen')) {
      if (!confirm('Rebuild your checklist from your household settings? Items you checked and items you added stay.')) return;
      t.disabled = true;
      try {
        const out = await api('POST', '/api/checklist/regenerate');
        items = out.items;
        syncCache();
        draw();
        toast('Checklist updated');
      } catch (err) { fail(err); t.disabled = false; }
    }
  });

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-add]')) return;
    e.preventDefault();
    const input = $('#new-item', root);
    const label = input.value.trim();
    if (!label) return;
    try {
      const out = await api('POST', '/api/checklist', { label, category: tab });
      items = [...items, out.item];
      syncCache();
      draw();
      $('#new-item', root).focus();
    } catch (err) { fail(err); }
  });

  function syncCache() {
    store.set('checklist', { data: { items }, at: new Date().toISOString() });
  }
  function fail(err) {
    toast(isOfflineError(err) ? "Couldn't reach the server. Check your connection." : err instanceof ApiError ? err.message : 'Something went wrong.', 'error');
  }

  const offSynced = onSynced(() => { if (alive) { items = applyPending(store.get('checklist')?.data.items || items); refreshProgress(); } });
  const onNet = () => { if (alive && meta) draw(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  setHTML(root, html`<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`);
  load();
  return () => { alive = false; offSynced(); window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); };
}
