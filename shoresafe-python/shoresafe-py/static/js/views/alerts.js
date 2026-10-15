import { html, setHTML, $, timeAgo, fmtDateTime } from '../util.js';
import { icons } from '../icons.js';
import { cached } from '../data.js';

const REFRESH_MS = 5 * 60 * 1000;

function statusBanner(a, meta) {
  if (meta.stale) {
    return html`<div class="banner banner-warn">${icons.wifiOff}<div><strong>You're offline</strong>
      These alerts were saved ${timeAgo(meta.at)} and may have changed. Check weather.gov when you can.</div></div>`;
  }
  if (a.status === 'unavailable') {
    return html`<div class="banner banner-warn">${icons.alert}<div><strong>Couldn't check for weather alerts</strong>
      Don't assume there are none. Check weather.gov or your local emergency management office.</div></div>`;
  }
  if (a.status === 'stale') {
    return html`<div class="banner banner-warn">${icons.alert}<div><strong>Alert information may be out of date</strong>
      The weather service didn't respond. Last update ${timeAgo(a.fetched_at)}.</div></div>`;
  }
  return '';
}

function alertCard(a) {
  const until = a.ends || a.expires;
  return html`<details class="alert-card ${String(a.severity).toLowerCase()}">
    <summary>
      <div class="row-between"><strong>${a.event}</strong><span class="pill ${a.severity === 'Extreme' || a.severity === 'Severe' ? 'alarm' : ''}">${a.severity}</span></div>
      ${a.headline && html`<p class="small mt-1">${a.headline}</p>`}
      <p class="small muted mt-1">${until ? `In effect until ${fmtDateTime(until)}. ` : ''}Issued by ${a.sender}.</p>
    </summary>
    <div class="alert-body">
      ${a.description && html`<p>${a.description}</p>`}
      ${a.instruction && html`<h4>What to do</h4><p>${a.instruction}</p>`}
      ${a.area && html`<h4>Areas</h4><p>${a.area}</p>`}
    </div></details>`;
}

export function mount(root) {
  let alive = true;
  let timer = null;

  async function load(manual = false) {
    try {
      const res = await cached('alerts', '/api/alerts');
      if (!alive) return;
      const a = res.data;
      setHTML(root, html`<div class="stack">
        <div class="page-head row-between">
          <div><h1>Weather alerts</h1><p>${a.county} County. ${a.fetched_at ? `Updated ${timeAgo(res.stale ? res.at : a.fetched_at)}.` : ''}</p></div>
          <button class="icon-btn" data-refresh aria-label="Refresh alerts">${icons.refresh}</button>
        </div>
        ${statusBanner(a, res)}
        ${a.items.length === 0 && a.status === 'live' && !res.stale
          ? html`<div class="empty"><p><strong>No active alerts for ${a.county} County.</strong></p>
              <p class="mt-1">Alerts come from the National Weather Service and refresh every few minutes while this tab is open.</p></div>`
          : a.items.map(alertCard)}
        <p class="disclaimer">Alert data is from the National Weather Service. Always follow instructions from local officials.</p>
      </div>`);
      $('[data-refresh]', root).addEventListener('click', () => load(true));
    } catch (e) {
      if (!alive) return;
      setHTML(root, html`<div class="empty"><p>We couldn't load alerts.</p>
        <p class="mt-1"><button class="btn btn-quiet" data-retry>Try again</button></p></div>`);
      $('[data-retry]', root).addEventListener('click', () => load(true));
    }
  }

  setHTML(root, html`<div class="skeleton"></div><div class="skeleton"></div>`);
  load();
  timer = setInterval(load, REFRESH_MS);
  const onOnline = () => load();
  window.addEventListener('online', onOnline);
  return () => { alive = false; clearInterval(timer); window.removeEventListener('online', onOnline); };
}
