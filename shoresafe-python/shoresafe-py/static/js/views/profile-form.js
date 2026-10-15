// The household form. Used as a step-by-step wizard the first time, and as one page when editing.
import { html, setHTML, $, $$, titleCase } from '../util.js';
import { api, ApiError, isOfflineError } from '../api.js';
import { state } from '../state.js';

const FLOOD_HELP = {
  low: 'Rarely or never floods where I live',
  moderate: 'Streets or yards flood in heavy storms',
  high: 'Floods in most big storms or at high tide',
  extreme: 'Floods often, including regular high tides',
};
const STEPS = ['Household', 'Needs', 'Risk', 'Review'];

export function renderProfileForm(root, { initial, mode, onSaved }) {
  const editing = mode === 'edit';
  const form = {
    household_name: 'My Household', zone: 'Ocean', evacuation_zone: '', household_size: 2,
    has_pets: false, pet_count: 0, has_medical_needs: false, has_elderly: false, has_children: false,
    home_type: 'house', flood_risk: 'moderate',
    ...(initial || {}),
  };
  let step = 0;
  let saving = false;
  let message = null; // { kind: 'error' | 'ok', text }
  const cfg = state.config;

  const householdSection = () => html`
    <div class="form-grid two">
      <label class="field"><span>Household name</span>
        <input class="input" name="household_name" maxlength="60" value="${form.household_name}" placeholder="The Smith family"></label>
      <label class="field"><span>County</span>
        <select class="select" name="zone">
          <optgroup label="Shore counties">${cfg.shore_counties.map((c) => html`<option ${c === form.zone ? 'selected' : ''}>${c}</option>`)}</optgroup>
          <optgroup label="Other New Jersey counties">${cfg.other_counties.map((c) => html`<option ${c === form.zone ? 'selected' : ''}>${c}</option>`)}</optgroup>
        </select>
        <p class="hint">Weather alerts are matched to this county.</p></label>
      <label class="field"><span>Home type</span>
        <select class="select" name="home_type">${cfg.home_types.map((t) => html`<option value="${t}" ${t === form.home_type ? 'selected' : ''}>${titleCase(t)}</option>`)}</select></label>
      <div class="field"><span class="field-label">People in your household</span>
        ${stepper('household_size', form.household_size)}</div>
    </div>`;

  const needsSection = () => html`
    <p class="muted">Pick what applies. Each choice adds items to your checklist.</p>
    <div class="choice-list mt-2">
      <label class="choice"><input type="checkbox" name="has_pets" ${form.has_pets ? 'checked' : ''}>
        <span class="grow"><strong>Pets</strong><span class="muted small">Food, carriers, and records</span>
          ${form.has_pets && html`<span class="row mt-1"><span class="small">How many?</span>${stepper('pet_count', form.pet_count)}</span>`}</span></label>
      <label class="choice"><input type="checkbox" name="has_medical_needs" ${form.has_medical_needs ? 'checked' : ''}>
        <span><strong>Medical needs</strong><span class="muted small">Extra medication, equipment, and documents</span></span></label>
      <label class="choice"><input type="checkbox" name="has_children" ${form.has_children ? 'checked' : ''}>
        <span><strong>Children or infants</strong><span class="muted small">Formula, diapers, comfort items, records</span></span></label>
      <label class="choice"><input type="checkbox" name="has_elderly" ${form.has_elderly ? 'checked' : ''}>
        <span><strong>Older adults</strong><span class="muted small">Eyewear, hearing aids, mobility aids, caregiver contacts</span></span></label>
    </div>`;

  const riskSection = () => html`
    <div class="field"><span class="field-label">How likely is your home to flood?</span>
      <div class="choice-list">${cfg.flood_risk_levels.map((l) => html`
        <label class="choice"><input type="radio" name="flood_risk" value="${l}" ${l === form.flood_risk ? 'checked' : ''}>
          <span><strong>${titleCase(l)}</strong><span class="muted small">${FLOOD_HELP[l]}</span></span></label>`)}</div></div>
    <label class="field mt-3"><span>Evacuation zone (optional)</span>
      <input class="input" name="evacuation_zone" maxlength="30" value="${form.evacuation_zone}" placeholder="Example: Zone A">
      <p class="hint">Check with your county or town emergency management office. Leave blank if you're not sure.</p></label>`;

  const reviewSection = () => html`
    <div class="review"><dl>
      <div><dt>Household</dt><dd>${form.household_name}</dd></div>
      <div><dt>County</dt><dd>${form.zone}</dd></div>
      <div><dt>Home</dt><dd>${titleCase(form.home_type)}, ${form.household_size} ${form.household_size === 1 ? 'person' : 'people'}</dd></div>
      <div><dt>Flood risk</dt><dd>${titleCase(form.flood_risk)}</dd></div>
      <div><dt>Also planning for</dt><dd>${[form.has_pets && `${form.pet_count} pet${form.pet_count === 1 ? '' : 's'}`, form.has_medical_needs && 'medical needs', form.has_children && 'children', form.has_elderly && 'older adults'].filter(Boolean).join(', ') || 'Nobody extra'}</dd></div>
    </dl></div>`;

  function stepper(name, value) {
    const min = name === 'household_size' ? 1 : 1;
    return html`<div class="stepper" role="group" aria-label="${titleCase(name)}">
      <button type="button" data-step="${name}" data-delta="-1" aria-label="Decrease" ${value <= min ? 'disabled' : ''}>−</button>
      <output>${value}</output>
      <button type="button" data-step="${name}" data-delta="1" aria-label="Increase" ${value >= 20 ? 'disabled' : ''}>+</button></div>`;
  }

  function draw() {
    const msg = message && html`<div class="${message.kind === 'ok' ? 'form-ok' : 'form-error'}" role="alert">${message.text}</div>`;
    if (editing) {
      setHTML(root, html`<div class="stack-lg">
        <section class="section"><h3 class="mb-2">Household</h3>${householdSection()}</section>
        <section class="section"><h3 class="mb-2">Who you're planning for</h3>${needsSection()}</section>
        <section class="section"><h3 class="mb-2">Flood risk and evacuation</h3>${riskSection()}</section>
        ${msg}
        <div class="row"><button type="button" class="btn" data-save ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save changes'}</button></div>
      </div>`);
    } else {
      const body = [householdSection, needsSection, riskSection, reviewSection][step]();
      setHTML(root, html`<div class="wizard">
        <h1>Set up your household</h1>
        <p class="muted mt-1">Four quick steps so your checklist fits your home. Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}.</p>
        <ol class="progress-steps" aria-hidden="true">${STEPS.map((_, i) => html`<li class="${i <= step ? 'done' : ''}"></li>`)}</ol>
        <div class="stack">${body}${msg}</div>
        <div class="wizard-nav">
          <button type="button" class="btn btn-quiet" data-back ${step === 0 ? 'disabled' : ''}>Back</button>
          ${step < STEPS.length - 1
            ? html`<button type="button" class="btn" data-next>Continue</button>`
            : html`<button type="button" class="btn" data-save ${saving ? 'disabled' : ''}>${saving ? 'Building your plan…' : 'Create my plan'}</button>`}
        </div></div>`);
    }
  }

  async function save() {
    saving = true; message = null; draw();
    try {
      const res = await api('PUT', '/api/profile', form);
      saving = false;
      if (editing) { message = { kind: 'ok', text: 'Saved. Use "Update checklist" on the Checklist tab to apply any changes to your items.' }; draw(); }
      onSaved(res);
    } catch (e) {
      saving = false;
      message = { kind: 'error', text: isOfflineError(e) ? "You're offline. Connect to the internet to save." : e instanceof ApiError ? e.message : 'Could not save. Try again.' };
      draw();
    }
  }

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.name) return;
    if (t.type === 'checkbox') { form[t.name] = t.checked; if (t.name === 'has_pets') { form.pet_count = t.checked ? Math.max(1, form.pet_count) : 0; draw(); } }
    else if (t.type === 'radio') { if (t.checked) form[t.name] = t.value; }
    else form[t.name] = t.value;
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.step) {
      const next = form[b.dataset.step] + Number(b.dataset.delta);
      form[b.dataset.step] = Math.min(20, Math.max(1, next));
      draw();
    } else if (b.hasAttribute('data-next')) { step += 1; message = null; draw(); window.scrollTo(0, 0); }
    else if (b.hasAttribute('data-back')) { step -= 1; message = null; draw(); window.scrollTo(0, 0); }
    else if (b.hasAttribute('data-save')) save();
  });

  draw();
}
