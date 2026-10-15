import { html, setHTML, $ } from '../util.js';
import { icons } from '../icons.js';
import { api, ApiError, isOfflineError } from '../api.js';

export function renderAuth(root, onSignedIn) {
  let mode = 'signin';

  function draw() {
    const signin = mode === 'signin';
    setHTML(root, html`
      <div class="splash"><div class="splash-card">
        <div class="brand">
          <div class="brand-mark">${icons.shield}</div>
          <div><h1>ShoreSafe</h1><p>Storm prep for the Jersey Shore</p></div>
        </div>
        <div class="auth-panel">
          <div class="tabs" role="tablist" aria-label="Account">
            <button class="tab" role="tab" type="button" data-mode="signin" aria-selected="${signin ? 'true' : 'false'}">Sign in</button>
            <button class="tab" role="tab" type="button" data-mode="signup" aria-selected="${signin ? 'false' : 'true'}">Create account</button>
          </div>
          <form id="auth-form" class="stack" novalidate>
            <label class="field"><span>Email</span>
              <input class="input" type="email" name="email" autocomplete="email" inputmode="email" required></label>
            <label class="field"><span>Password</span>
              <input class="input" type="password" name="password" required minlength="8"
                autocomplete="${signin ? 'current-password' : 'new-password'}">
              ${!signin && html`<p class="hint">At least 8 characters.</p>`}
            </label>
            <div id="auth-error" role="alert"></div>
            <button class="btn btn-block" type="submit">${signin ? 'Sign in' : 'Create account'}</button>
          </form>
        </div>
        <p class="auth-foot">Your household details are stored on this site's server and visible only to your account.
          You can delete your account at any time from the Household tab.</p>
      </div></div>`);

    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; draw(); }));
    $('#auth-form', root).addEventListener('submit', submit);
    $('input[name=email]', root).focus();
  }

  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = form.email.value.trim();
    const password = form.password.value;
    const err = $('#auth-error', root);
    const show = (msg) => setHTML(err, html`<div class="form-error">${msg}</div>`);
    if (!email || !password) return show('Enter your email and password.');
    if (mode === 'signup' && password.length < 8) return show('Use a password with at least 8 characters.');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('POST', mode === 'signin' ? '/api/auth/signin' : '/api/auth/signup', { email, password });
      onSignedIn(res);
    } catch (ex) {
      show(isOfflineError(ex) ? "You're offline. Connect to the internet to sign in." : ex instanceof ApiError ? ex.message : 'Something went wrong. Try again.');
      btn.disabled = false;
    }
  }

  draw();
}
