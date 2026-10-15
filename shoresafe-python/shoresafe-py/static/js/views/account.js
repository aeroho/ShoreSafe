import { html, setHTML, $, toast } from '../util.js';
import { api, ApiError, isOfflineError } from '../api.js';
import { state } from '../state.js';
import { renderProfileForm } from './profile-form.js';

export function mount(root) {
  setHTML(root, html`<div class="stack-lg">
    <div class="page-head"><h1>Household</h1><p>Change who you're planning for, then update your checklist.</p></div>
    <div data-form></div>
    <section class="section">
      <h2 class="mb-2">Account</h2>
      <p>${state.user.email} ${state.user.is_admin && html`<span class="admin-tag">Admin</span>`}</p>
      <div class="row mt-2">
        <button class="btn btn-quiet" data-signout>Sign out</button>
        <button class="btn btn-quiet" data-delete>Delete account</button>
      </div>
      <p class="hint mt-2">Deleting your account permanently removes your household, checklist, supplies, and map reports.</p>
    </section>
    <dialog data-dialog>
      <form method="dialog" class="stack" data-delete-form>
        <h2>Delete your account?</h2>
        <p class="muted">This can't be undone. Enter your password to confirm.</p>
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <div data-delete-error></div>
        <div class="row"><button type="button" class="btn btn-quiet" data-cancel>Cancel</button>
          <button type="submit" class="btn btn-danger">Delete everything</button></div>
      </form>
    </dialog>
  </div>`);

  renderProfileForm($('[data-form]', root), {
    initial: state.profile,
    mode: 'edit',
    onSaved: (res) => state.profileSaved(res.profile),
  });

  const dialog = $('[data-dialog]', root);
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-signout')) {
      try { await api('POST', '/api/auth/signout'); }
      catch (err) { if (isOfflineError(err)) toast('Signed out on this device. Connect to the internet to fully end your session.'); }
      state.signedOut();
    } else if (b.hasAttribute('data-delete')) {
      dialog.showModal();
    } else if (b.hasAttribute('data-cancel')) {
      dialog.close();
    }
  });

  $('[data-delete-form]', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.currentTarget.password.value;
    const err = $('[data-delete-error]', root);
    try {
      await api('DELETE', '/api/account', { password });
      dialog.close();
      state.signedOut();
    } catch (ex) {
      setHTML(err, html`<div class="form-error" role="alert">${isOfflineError(ex) ? "You're offline. Connect to delete your account." : ex instanceof ApiError ? ex.message : 'Something went wrong.'}</div>`);
    }
  });
}
