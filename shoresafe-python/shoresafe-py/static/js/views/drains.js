import { html, setHTML, $, $$, toast, timeAgo, titleCase } from '../util.js';
import { icons } from '../icons.js';
import { api, ApiError, isOfflineError } from '../api.js';
import { cached } from '../data.js';
import { state } from '../state.js';
import { TileMap, TILE_SOURCES } from '../tilemap.js';

const NJ_CENTER = { lat: 40.0, lng: -74.4 };
const NJ_ZOOM = 8;
const REFRESH_MS = 2 * 60 * 1000;
const NJ_BOUNDS = { south: 38.7, north: 41.5, west: -75.7, east: -73.7 };

const ZONE_CENTERS = {
  'Cape May': [39.05, -74.9], Atlantic: [39.36, -74.43], Ocean: [39.83, -74.13], Monmouth: [40.13, -74.03],
  Cumberland: [39.2, -74.93], Burlington: [39.87, -74.73], Middlesex: [40.49, -74.29],
  'Long Beach Island': [39.6, -74.18], 'Seaside Heights': [39.94, -74.07], 'Sandy Hook': [40.46, -74.02],
  Hudson: [40.73, -74.04], Bergen: [40.85, -74.0], Salem: [39.57, -75.37], Gloucester: [39.83, -75.11],
  Camden: [39.94, -75.12], Manahawkin: [39.695, -74.28], 'Stafford Township': [39.72, -74.26], Barnegat: [39.755, -74.22],
};

const TYPES = {
  backup: { label: 'Backup', letter: 'B' },
  flooding: { label: 'Flooding', letter: 'F' },
  overflow: { label: 'Overflow', letter: 'O' },
  odor: { label: 'Sewer smell', letter: 'S' },
  other: { label: 'Other', letter: '?' },
};

function meters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}

function inZone(report, zone) {
  if (zone === 'all') return true;
  if (report.drain_zone) return report.drain_zone === zone;
  const c = ZONE_CENTERS[zone];
  return c ? meters(c[0], c[1], report.lat, report.lng) < 15000 : false;
}

export function mount(root) {
  let alive = true;
  let drains = [];
  let reports = [];
  let zone = 'all';
  let pending = null;       // { lat, lng } where the person tapped
  let selected = null;      // { kind: 'report' | 'drain', id }
  let form = { report_type: 'backup', severity: 'moderate', description: '' };
  let stale = false;
  let sending = false;
  let map = null;
  let timer = null;

  setHTML(root, html`<div class="stack">
    <div class="page-head row-between">
      <div><h1>Drain map</h1><p>See backups and flooding reported near you, or report one.</p></div>
      <button class="icon-btn" data-refresh aria-label="Refresh map">${icons.refresh}</button>
    </div>
    <div data-offline></div>
    <div class="banner banner-info">${icons.info}<div><strong>Community reports, not official records</strong>
      Drain dots are approximate sample locations and may be off. For life-threatening flooding call 911.
      Report sewer problems to your town's public works office too.</div></div>
    <div data-stats></div>
    <div data-chips></div>
    <div class="map-wrap">
      <div data-map></div>
      <div class="map-layers" role="group" aria-label="Map style">
        ${Object.entries(TILE_SOURCES).map(([id, s]) => html`<button type="button" class="chip" data-layer="${id}" aria-pressed="${id === 'street' ? 'true' : 'false'}">${s.label}</button>`)}
      </div>
    </div>
    <div data-panel></div>
    <section class="section" data-list></section>
  </div>`);

  // ----- rendering -----

  const visibleDrains = () => drains.filter((d) => zone === 'all' || d.zone === zone);
  const visibleReports = () => reports.filter((r) => inZone(r, zone));
  const reportById = (id) => reports.find((r) => r.id === id);
  const drainById = (id) => drains.find((d) => d.id === id);

  function renderOffline() {
    setHTML($('[data-offline]', root), !navigator.onLine || stale
      ? html`<div class="banner banner-warn">${icons.wifiOff}<div><strong>You're offline</strong>
          Showing the last map data saved on this device. Reports and confirmations need a connection.</div></div>` : '');
  }

  function renderStats() {
    const rs = visibleReports();
    setHTML($('[data-stats]', root), html`<div class="counts">
      <div><b>${visibleDrains().length}</b><span>Drain points</span></div>
      <div class="short"><b>${rs.length}</b><span>Active reports</span></div>
      <div class="missing"><b>${rs.filter((r) => r.severity === 'high').length}</b><span>High severity</span></div></div>`);
  }

  function renderChips() {
    const zones = Object.keys(ZONE_CENTERS).filter((z) => drains.some((d) => d.zone === z));
    setHTML($('[data-chips]', root), html`<div class="chips" role="group" aria-label="Area">
      ${['all', ...zones].map((z) => html`<button class="chip" type="button" data-zone="${z}" aria-pressed="${zone === z ? 'true' : 'false'}">${z === 'all' ? 'All of NJ' : z}</button>`)}</div>`);
  }

  function updateMarkers() {
    if (!map) return;
    const reported = new Set(reports.map((r) => r.drain_id).filter(Boolean));
    map.setMarkers('drains', visibleDrains().map((d) => ({
      lat: d.lat, lng: d.lng, className: `pin-drain ${reported.has(d.id) ? 'has-report' : ''}`,
      label: `${d.label} (approximate location)`, onClick: () => select('drain', d.id),
    })));
    map.setMarkers('reports', visibleReports().map((r) => ({
      lat: r.lat, lng: r.lng, className: `pin-report ${r.report_type} ${r.severity}`, text: TYPES[r.report_type].letter,
      data: { n: r.confirm_count || '' },
      label: `${TYPES[r.report_type].label}, ${r.severity} severity, ${r.confirm_count} confirmations`,
      onClick: () => select('report', r.id),
    })));
    map.setMarkers('pending', pending ? [{ lat: pending.lat, lng: pending.lng, className: 'pin-pending', label: 'New report location' }] : []);
  }

  function renderPanel() {
    const el = $('[data-panel]', root);
    const online = navigator.onLine;
    if (pending) {
      setHTML(el, html`<form class="panel stack" data-report-form novalidate>
        <div class="row-between"><h2>Report a problem</h2><button type="button" class="icon-btn" data-cancel aria-label="Cancel report">✕</button></div>
        <p class="muted small">Location: ${pending.lat.toFixed(4)}, ${pending.lng.toFixed(4)}. Tap the map again to move it.</p>
        <div class="field"><span class="field-label">What's happening?</span>
          <div class="chips" role="radiogroup" aria-label="Problem type">
            ${Object.entries(TYPES).map(([k, t]) => html`<button type="button" class="chip" role="radio" data-type="${k}" aria-checked="${form.report_type === k ? 'true' : 'false'}" aria-pressed="${form.report_type === k ? 'true' : 'false'}">${t.label}</button>`)}</div></div>
        <div class="field"><span class="field-label">How bad is it?</span>
          <div class="chips" role="radiogroup" aria-label="Severity">
            ${['low', 'moderate', 'high'].map((s) => html`<button type="button" class="chip" role="radio" data-severity="${s}" aria-checked="${form.severity === s ? 'true' : 'false'}" aria-pressed="${form.severity === s ? 'true' : 'false'}">${titleCase(s)}</button>`)}</div></div>
        <label class="field"><span>Details (optional)</span>
          <textarea class="textarea" name="description" maxlength="300" rows="2" placeholder="Water backing up onto the street">${form.description}</textarea></label>
        <div data-form-error></div>
        <p class="hint">Reports stay on the map for ${state.config.report_ttl_hours} hours unless someone clears them.</p>
        <button class="btn" type="submit" ${online && !sending ? '' : 'disabled'}>${sending ? 'Sending…' : online ? 'Send report' : 'Offline'}</button>
      </form>`);
      return;
    }
    if (selected && selected.kind === 'report' && reportById(selected.id)) {
      const r = reportById(selected.id);
      setHTML(el, html`<section class="panel stack" aria-live="polite">
        <div class="row-between"><div><h2>${TYPES[r.report_type].label}</h2>
          <p class="muted small">${titleCase(r.severity)} severity. Reported ${timeAgo(r.created_at)}.${r.drain_label ? ` Near ${r.drain_label}.` : ''}</p></div>
          <button type="button" class="icon-btn" data-close aria-label="Close details">✕</button></div>
        ${r.description && html`<p>${r.description}</p>`}
        <p class="small"><strong>${r.confirm_count}</strong> ${r.confirm_count === 1 ? 'person has' : 'people have'} confirmed this.</p>
        <div class="row">
          <button class="btn" data-confirm="${r.id}" ${online && !r.mine && !r.confirmed_by_me ? '' : 'disabled'}>${r.confirmed_by_me ? 'You confirmed this' : r.mine ? 'Your report' : 'I see this too'}</button>
          ${r.can_manage && html`<button class="btn btn-quiet" data-resolve="${r.id}" ${online ? '' : 'disabled'}>Mark as cleared</button>
            <button class="icon-btn" data-delete="${r.id}" aria-label="Delete report" ${online ? '' : 'disabled'}>${icons.trash}</button>`}
        </div>
        ${r.can_manage && !r.mine && html`<p class="hint">You can manage this because you're an admin.</p>`}
      </section>`);
      return;
    }
    if (selected && selected.kind === 'drain' && drainById(selected.id)) {
      const d = drainById(selected.id);
      setHTML(el, html`<section class="panel stack">
        <div class="row-between"><div><h2>${d.label}</h2><p class="muted small">${d.zone}. Approximate location, not verified.</p></div>
          <button type="button" class="icon-btn" data-close aria-label="Close details">✕</button></div>
        <button class="btn" data-report-here="${d.id}" ${online ? '' : 'disabled'}>Report a problem here</button>
      </section>`);
      return;
    }
    setHTML(el, html`<div class="panel"><p><strong>Tap the map to report a problem.</strong> Tap a dot to see details.</p>
      <ul class="legend mt-2">
        <li><span class="swatch drain"></span>Drain point (approximate)</li>
        <li><span class="swatch drain has-report"></span>Drain with a report</li>
        ${Object.entries(TYPES).map(([k, t]) => html`<li><span class="swatch ${k}">${t.letter}</span>${t.label}</li>`)}
      </ul></div>`);
  }

  function renderList() {
    const rs = visibleReports();
    setHTML($('[data-list]', root), html`<div class="section-head"><h2>Active reports</h2><span class="muted">${rs.length}</span></div>
      ${rs.length === 0
        ? html`<div class="empty">No active reports${zone === 'all' ? '' : ` in ${zone}`}. Reports show here for ${state.config.report_ttl_hours} hours.</div>`
        : html`<ul class="list boxed">${rs.map((r) => html`<li class="stack">
            <div class="row-between"><strong>${TYPES[r.report_type].label}</strong>
              <span class="pill ${r.severity === 'high' ? 'alarm' : r.severity === 'moderate' ? 'warn' : ''}">${titleCase(r.severity)}</span></div>
            <p class="small muted">${timeAgo(r.created_at)}${r.drain_label ? `. Near ${r.drain_label}` : ''}. ${r.confirm_count} confirmed.</p>
            ${r.description && html`<p class="small">${r.description}</p>`}
            <button class="link-btn small" data-show="${r.id}">Show on map</button></li>`)}</ul>`}`);
  }

  function renderAll() {
    renderOffline(); renderStats(); renderChips(); renderPanel(); renderList(); updateMarkers();
  }

  // ----- actions -----

  function select(kind, id) {
    pending = null;
    selected = { kind, id };
    renderPanel();
  }

  function startReport(lat, lng) {
    if (!navigator.onLine) { toast('Connect to the internet to send a report.', 'error'); return; }
    if (lat < NJ_BOUNDS.south || lat > NJ_BOUNDS.north || lng < NJ_BOUNDS.west || lng > NJ_BOUNDS.east) {
      toast('Reports can only be placed in New Jersey.', 'error'); return;
    }
    selected = null;
    pending = { lat, lng };
    renderPanel();
    updateMarkers();
    $('[data-panel]', root).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function fail(err) {
    toast(isOfflineError(err) ? "Couldn't reach the server. Check your connection." : err instanceof ApiError ? err.message : 'Something went wrong.', 'error');
  }

  async function load() {
    try {
      const [d, r] = await Promise.all([cached('drains', '/api/drains'), cached('reports', '/api/reports')]);
      if (!alive) return;
      drains = d.data.drains;
      reports = r.data.reports;
      stale = d.stale || r.stale;
      renderAll();
    } catch (e) {
      if (!alive) return;
      toast("Couldn't load the map data.", 'error');
    }
  }

  // ----- events -----

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-refresh')) { load(); return; }
    if (b.dataset.layer) {
      map.setSource(b.dataset.layer);
      $$('[data-layer]', root).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      return;
    }
    if (b.dataset.zone) {
      zone = b.dataset.zone;
      const c = ZONE_CENTERS[zone];
      if (zone === 'all') map.setView(NJ_CENTER.lat, NJ_CENTER.lng, NJ_ZOOM); else if (c) map.setView(c[0], c[1], 13);
      renderStats(); renderChips(); renderList(); updateMarkers();
      return;
    }
    if (b.dataset.type) { form.report_type = b.dataset.type; renderPanel(); return; }
    if (b.dataset.severity) { form.severity = b.dataset.severity; renderPanel(); return; }
    if (b.hasAttribute('data-cancel')) { pending = null; renderPanel(); updateMarkers(); return; }
    if (b.hasAttribute('data-close')) { selected = null; renderPanel(); return; }
    if (b.dataset.reportHere) { const d = drainById(Number(b.dataset.reportHere)); if (d) startReport(d.lat, d.lng); return; }
    if (b.dataset.show) {
      const r = reportById(Number(b.dataset.show));
      if (r) { map.setView(r.lat, r.lng, Math.max(map.zoom, 15)); select('report', r.id); $('[data-map]', root).scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      return;
    }
    const id = Number(b.dataset.confirm || b.dataset.resolve || b.dataset.delete);
    if (!id) return;
    try {
      if (b.dataset.confirm) {
        const out = await api('POST', `/api/reports/${id}/confirm`);
        reports = reports.map((r) => (r.id === id ? out.report : r));
        toast('Thanks for confirming.');
      } else if (b.dataset.resolve) {
        if (!confirm('Mark this report as cleared? It will come off the map for everyone.')) return;
        await api('POST', `/api/reports/${id}/resolve`);
        reports = reports.filter((r) => r.id !== id);
        selected = null;
        toast('Report cleared.');
      } else {
        if (!confirm('Delete this report?')) return;
        await api('DELETE', `/api/reports/${id}`);
        reports = reports.filter((r) => r.id !== id);
        selected = null;
        toast('Report deleted.');
      }
      renderAll();
    } catch (err) { fail(err); if (err instanceof ApiError && err.status === 409) load(); }
  });

  root.addEventListener('input', (e) => {
    if (e.target.name === 'description') form.description = e.target.value;
  });

  root.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-report-form]')) return;
    e.preventDefault();
    if (sending || !pending) return;
    sending = true;
    renderPanel();
    try {
      const out = await api('POST', '/api/reports', { ...pending, ...form, description: form.description.trim() });
      reports = [out.report, ...reports];
      form = { report_type: 'backup', severity: 'moderate', description: '' };
      pending = null;
      selected = { kind: 'report', id: out.report.id };
      toast(`Report added. It stays up for ${state.config.report_ttl_hours} hours or until cleared.`);
      sending = false;
      renderAll();
    } catch (err) {
      sending = false;
      renderPanel();
      const msg = isOfflineError(err) ? "You're offline. Connect to send the report." : err instanceof ApiError ? err.message : 'Could not send the report.';
      setHTML($('[data-form-error]', root), html`<div class="form-error" role="alert">${msg}</div>`);
    }
  });

  const onNet = () => { renderOffline(); renderPanel(); if (navigator.onLine) load(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  // ----- start -----

  map = new TileMap($('[data-map]', root), { center: NJ_CENTER, zoom: NJ_ZOOM, onTap: startReport });
  renderAll();
  load();
  timer = setInterval(load, REFRESH_MS);

  return () => {
    alive = false;
    clearInterval(timer);
    map.destroy();
    window.removeEventListener('online', onNet);
    window.removeEventListener('offline', onNet);
  };
}
