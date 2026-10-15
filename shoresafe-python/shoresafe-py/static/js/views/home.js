import { html, setHTML, $, timeAgo, fmtDay, qtyUnit } from '../util.js';
import { icons } from '../icons.js';
import { cached, overlayPending, flushQueue, onSynced } from '../data.js';
import { state } from '../state.js';

const REFRESH_MS = 5 * 60 * 1000;

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => (seen.has(i.id) ? false : seen.add(i.id)));
}

function alertBand(d, meta) {
  const a = d.alerts;
  const county = `${a.county} County`;
  if (meta.stale) {
    return html`<div class="banner banner-warn">${icons.wifiOff}<div><strong>You're offline</strong>
      Showing what was saved ${timeAgo(meta.at)}. Alerts may have changed. Check weather.gov or listen to NOAA Weather Radio.</div></div>`;
  }
  if (a.status === 'unavailable') {
    return html`<div class="banner banner-warn">${icons.alert}<div><strong>Couldn't check for weather alerts</strong>
      Don't assume there are none. Check weather.gov or your local emergency management office.</div></div>`;
  }
  if (a.status === 'stale') {
    return html`<div class="banner banner-warn">${icons.alert}<div><strong>Alert information may be out of date</strong>
      The weather service didn't respond. Last update ${timeAgo(a.fetched_at)}. Check weather.gov to be sure.</div></div>`;
  }
  if (!a.items.length) {
    return html`<div class="banner banner-ok">${icons.check}<div><strong>No active weather alerts for ${county}</strong>
      Checked ${timeAgo(a.fetched_at)}.</div></div>`;
  }
  return html`<div class="banner banner-info">${icons.info}<div><strong>${a.items.length} active alert${a.items.length === 1 ? '' : 's'} for ${county}</strong>
    <a href="#/alerts">Read the alerts</a></div></div>`;
}

function actionPanels(d) {
  const shelter = d.actions.filter((a) => a.kind === 'shelter');
  const evac = d.actions.filter((a) => a.kind === 'evacuate');
  const prep = d.actions.filter((a) => a.kind === 'prepare');
  const events = (list) => [...new Set(list.map((a) => a.event))].join(', ');

  return html`
    ${shelter.map((a) => html`<section class="alert-panel" role="alert">
      <h2>Take shelter now: ${a.event}</h2>
      <p class="mt-1">Go to the lowest interior room, away from windows. Don't drive or evacuate unless officials tell you to.
        Follow official instructions.</p></section>`)}
    ${evac.length > 0 && html`<section class="alert-panel" role="alert">
      <h2>Evacuation-level alert: ${events(evac)}</h2>
      <p class="mt-1">If officials order your area to evacuate, this is what's left to do.</p>
      ${(() => { const items = dedupe(evac.flatMap((a) => a.items)); return html`<ul>${items.slice(0, 6).map((i) => html`<li>${i.label}</li>`)}</ul>
        ${items.length > 6 && html`<p class="small">and ${items.length - 6} more on your checklist.</p>`}`; })()}
      ${d.essentials.length > 0 && html`<div class="essentials"><h3>If you only have 10 minutes</h3>
        <ul>${d.essentials.slice(0, 5).map((i) => html`<li>${i.label}</li>`)}</ul></div>`}
      <a class="btn mt-2" href="#/checklist">Open checklist</a></section>`}
    ${prep.length > 0 && html`<section class="alert-panel prepare">
      <h2>Get ready: ${events(prep)}</h2>
      <p class="mt-1">Conditions are developing. Use this time to prepare.</p>
      ${(() => { const items = dedupe(prep.flatMap((a) => a.items)); return html`<ul>${items.slice(0, 5).map((i) => html`<li>${i.label}</li>`)}</ul>
        ${items.length > 5 && html`<p class="small">and ${items.length - 5} more on your checklist.</p>`}`; })()}
      <a class="btn mt-2" href="#/checklist">Open checklist</a></section>`}`;
}

function readiness(d) {
  const g = d.gaps;
  const cls = g.readiness_score >= 75 ? '' : g.readiness_score >= 40 ? 'warn' : 'low';
  return html`<section class="section">
    <div class="section-head"><h2>Supply readiness</h2><a href="#/supplies">Supplies</a></div>
    <div class="readiness">
      <div class="gauge ${cls}" data-pct="${g.readiness_score}" role="img" aria-label="Readiness ${g.readiness_score} percent">
        <div class="gauge-water"></div><div class="gauge-ticks"></div></div>
      <div class="readiness-body">
        <div class="score">${g.readiness_score}<small>%</small></div>
        <div class="counts">
          <div class="ok"><b>${g.met_count}</b><span>Ready</span></div>
          <div class="short"><b>${g.short_count}</b><span>Short</span></div>
          <div class="missing"><b>${g.missing_count}</b><span>Missing</span></div>
        </div>
        <p class="small muted">Based on the supplies you've logged for ${d.profile.household_size} ${d.profile.household_size === 1 ? 'person' : 'people'}.
          ${d.inventory_count === 0 ? 'Add what you have to see your gaps.' : ''}</p>
      </div>
    </div>
    ${g.shopping_list.length > 0 && html`<div class="mt-3"><h3 class="mb-2">Still needed</h3>
      <ul class="list">${g.shopping_list.slice(0, 5).map((s) => html`<li class="row-between">
        <span>${s.label}</span><span class="pill warn">${qtyUnit(s.quantity, s.unit)}</span></li>`)}</ul>
      ${g.shopping_list.length > 5 && html`<p class="small mt-1"><a href="#/supplies">${g.shopping_list.length - 5} more on the Supplies tab</a></p>`}</div>`}
  </section>`;
}

function checklistProgress(d) {
  const row = (label, p) => html`<a class="link-row" href="#/checklist">
    <span class="grow"><strong>${label}</strong><span class="bar mt-1" role="img" aria-label="${p.done} of ${p.total} done"><i data-pct="${p.total ? Math.round((p.done / p.total) * 100) : 0}"></i></span></span>
    <span class="muted">${p.done} of ${p.total}</span></a>`;
  return html`<section class="section"><div class="section-head"><h2>Checklists</h2></div>
    ${row('Evacuation', d.progress.evacuation)}${row('Hunker down', d.progress.hunker_down)}</section>`;
}

function expiringSection(d) {
  if (!d.expiring.length) return '';
  return html`<section class="section"><div class="section-head"><h2>Expired or expiring</h2></div>
    <ul class="list">${d.expiring.slice(0, 5).map((i) => html`<li class="row-between"><span>${i.name}</span>
      <span class="pill ${i.days_left < 0 ? 'alarm' : 'warn'}">${i.days_left < 0 ? `Expired ${fmtDay(i.expires_at)}` : i.days_left === 0 ? 'Expires today' : `${i.days_left} day${i.days_left === 1 ? '' : 's'} left`}</span></li>`)}</ul>
    ${d.expiring.length > 5 && html`<p class="small mt-1"><a href="#/supplies">See all</a></p>`}</section>`;
}

export function mount(root) {
  let alive = true;
  let timer = null;

  setHTML(root, html`<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`);

  async function load() {
    await flushQueue();
    try {
      const res = await cached('dashboard', '/api/dashboard');
      if (!alive) return;
      const d = overlayPending(res.data);
      state.setBadge(d.actions.length);
      setHTML(root, html`<div class="stack-lg">
        <div class="stack">${alertBand(d, res)}${actionPanels(d)}</div>
        ${readiness(d)}${checklistProgress(d)}${expiringSection(d)}
        <p class="disclaimer">ShoreSafe is a planning aid, not an official warning system. For warnings, rely on Wireless Emergency
          Alerts, NOAA Weather Radio, weather.gov, and your local officials.</p>
      </div>`);
    } catch (e) {
      if (!alive) return;
      setHTML(root, html`<div class="empty"><p>We couldn't load your dashboard.</p>
        <p class="mt-1"><button class="btn btn-quiet" data-retry>Try again</button></p></div>`);
      $('[data-retry]', root).addEventListener('click', load);
    }
  }

  const onOnline = () => load();
  window.addEventListener('online', onOnline);
  const offSynced = onSynced(load);
  timer = setInterval(load, REFRESH_MS);
  load();

  return () => { alive = false; clearInterval(timer); offSynced(); window.removeEventListener('online', onOnline); };
}
