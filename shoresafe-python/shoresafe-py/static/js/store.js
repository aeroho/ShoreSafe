// On-device copy of the household's data so the app still opens without internet.
// Cached per signed-in user and wiped on sign-out so a shared device never shows someone else's plan.

const PREFIX = 'shoresafe:v2:';
let userId = null;

export const store = {
  setUser(id) { userId = id; },
  key(name) { return `${PREFIX}${userId}:${name}`; },
  get(name) {
    try {
      const raw = localStorage.getItem(this.key(name));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(name, value) {
    try { localStorage.setItem(this.key(name), JSON.stringify(value)); } catch { /* storage full */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) || k.startsWith('shoresafe:last')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
  // The last known account, so the app can open offline.
  saveMe(me) { try { localStorage.setItem('shoresafe:last-me', JSON.stringify(me)); } catch { /* ignore */ } },
  loadMe() {
    try { return JSON.parse(localStorage.getItem('shoresafe:last-me')); } catch { return null; }
  },
  saveConfig(c) { try { localStorage.setItem('shoresafe:config', JSON.stringify(c)); } catch { /* ignore */ } },
  loadConfig() {
    try { return JSON.parse(localStorage.getItem('shoresafe:config')); } catch { return null; }
  },
};
