import { html, setHTML, $, $$ } from './util.js';
import { icons } from './icons.js';
import { api, ApiError, isOfflineError, onUnauthorized } from './api.js';
import { store } from './store.js';
import { state } from './state.js';
import { flushQueue } from './data.js';
import { renderAuth } from './views/auth.js';
import { renderProfileForm } from './views/profile-form.js';
import * as home from './views/home.js';
import * as alerts from './views/alerts.js';
import * as checklist from './views/checklist.js';
import * as supplies from './views/supplies.js';
import * as drains from './views/drains.js';
import * as account from './views/account.js';

const root = document.getElementById('app');

const TABS = [
  { id: 'home', label: 'Home', icon: 'home', view: home },
  { id: 'alerts', label: 'Alerts', icon: 'alert', view: alerts },
  { id: 'checklist', label: 'Checklist', icon: 'list', view: checklist },
  { id: 'supplies', label: 'Supplies', icon: 'box', view: supplies },
  { id: 'map', label: 'Drain map', icon: 'map', view: drains },
];
const ROUTES = [...TABS, { id: 'household', label: 'Household', view: account }];

let cleanup = null;
let badge = 0;

// ---------- theme ----------

function isDark() {
  const set = document.documentElement.dataset.theme;
  return set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('shoresafe-theme', next); } catch { /* ignore */ }
  const btn = $('[data-theme-btn]');
  if (btn) setHTML(btn, isDark() ? icons.sun : icons.moon);
}

// ---------- screens ----------

function showMessage(title, body, retry) {
  setHTML(root, html`<div class="splash"><div class="splash-card"><div class="auth-panel stack">
    <h1>${title}</h1><p class="muted">${body}</p>
    ${retry && html`<button class="btn" data-retry>Try again</button>`}</div></div></div>`);
  if (retry) $('[data-retry]', root).addEventListener('click', boot);
}

function setSession(me) {
  state.user = me.user;
  state.profile = me.profile;
  store.setUser(me.user.id);
  store.saveMe(me);
}

function showAuth() {
  cleanup?.();
  cleanup = null;
  renderAuth(root, (me) => { setSession(me); render(); });
}

function currentRoute() {
  const id = location.hash.replace(/^#\/?/, '') || 'home';
  return ROUTES.find((r) => r.id === id) || ROUTES[0];
}

function render() {
  cleanup?.();
  cleanup = null;
  if (!state.user) return showAuth();
  if (!state.profile) {
    const host = document.createElement('div');
    root.replaceChildren(host);
    return renderProfileForm(host, {
      mode: 'setup',
      onSaved: (res) => { state.profile = res.profile; store.saveMe({ user: state.user, profile: state.profile }); location.hash = '#/home'; render(); },
    });
  }
  return renderShell();
}

function renderShell() {
  const p = state.profile;
  setHTML(root, html`
    <header class="topbar"><div class="topbar-inner">
      <div class="brand"><div class="brand-mark">${icons.shield}</div>
        <div><h1>ShoreSafe</h1><p data-brand-sub>${p.household_name}, ${p.zone} County</p></div></div>
      <div class="topbar-actions">
        <button class="icon-btn" data-theme-btn aria-label="Switch between light and dark">${isDark() ? icons.sun : icons.moon}</button>
        <a class="icon-btn" href="#/household" aria-label="Household settings">${icons.user}</a>
      </div>
    </div></header>
    <div class="layout">
      <nav class="nav" aria-label="Main">
        ${TABS.map((t) => html`<a href="#/${t.id}" data-route="${t.id}">${icons[t.icon]}<span>${t.label}</span>${t.id === 'alerts' && html`<span class="nav-badge hidden" data-badge></span>`}</a>`)}
      </nav>
      <main id="main" tabindex="-1"><div id="view"></div></main>
    </div>`);
  $('[data-theme-btn]').addEventListener('click', toggleTheme);
  applyBadge();
  route(true);
}

function route(first = false) {
  if (!state.user || !state.profile) return;
  const r = currentRoute();
  $$('[data-route]').forEach((a) => {
    if (a.dataset.route === r.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  cleanup?.();
  const host = document.createElement('div');
  $('#view').replaceChildren(host);
  cleanup = r.view.mount(host) || null;
  document.title = `${r.label} - ShoreSafe`;
  if (!first) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
}

function applyBadge() {
  const el = $('[data-badge]');
  if (!el) return;
  el.textContent = badge;
  el.classList.toggle('hidden', badge === 0);
}

// ---------- state hooks used by the views ----------

state.setBadge = (n) => { badge = n; applyBadge(); };
state.profileSaved = (profile) => {
  state.profile = profile;
  store.saveMe({ user: state.user, profile });
  const sub = $('[data-brand-sub]');
  if (sub) sub.textContent = `${profile.household_name}, ${profile.zone} County`;
};
state.signedOut = () => {
  store.clearAll();
  state.user = null;
  state.profile = null;
  badge = 0;
  location.hash = '';
  render();
};
onUnauthorized(() => { if (state.user) state.signedOut(); });

// ---------- start ----------

async function boot() {
  setHTML(root, html`<div class="splash"><p>Loading ShoreSafe…</p></div>`);
  try {
    state.config = await api('GET', '/api/config');
    store.saveConfig(state.config);
  } catch (e) {
    state.config = store.loadConfig();
    if (!state.config) {
      return showMessage("Can't reach ShoreSafe", "Check your internet connection. After your first visit, ShoreSafe also opens without a connection.", true);
    }
  }

  try {
    setSession(await api('GET', '/api/me'));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { store.clearAll(); state.user = null; return render(); }
    if (isOfflineError(e)) {
      const saved = store.loadMe();
      if (saved) setSession(saved);
      else return showMessage("You're offline", 'Open ShoreSafe once with an internet connection and sign in. After that it works without one.', true);
    } else {
      return showMessage('Something went wrong', 'We could not load your account. Try again in a moment.', true);
    }
  }
  render();
  flushQueue();
}

window.addEventListener('hashchange', () => route());
window.addEventListener('online', () => { state.online = true; flushQueue(); });
window.addEventListener('offline', () => { state.online = false; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* offline install unavailable */ }));
}

boot();
