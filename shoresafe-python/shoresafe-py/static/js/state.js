// Shared app state. main.js fills in the functions.
export const state = {
  user: null,
  profile: null,
  config: null,
  online: navigator.onLine,
  setBadge: () => {},   // show a count on the Alerts tab
  refreshBanner: () => {},
  signedOut: () => {},
  profileSaved: () => {},
};
