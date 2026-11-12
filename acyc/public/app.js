'use strict';
/* Club Activity System front end. No frameworks. All user text is escaped before rendering. */
const $app = document.getElementById('app');
const state = { user: null, csrf: null, config: null };

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// One date style everywhere: "Tue 10 Nov 2026" and 24-hour time "14:00".
function fmtD(iso) {
  if (!iso) return '';
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const fmtDT = (iso) => (iso ? `${fmtD(iso)}, ${iso.slice(11, 16)}` : '');
function fmtStamp(utcIso) { // audit timestamps (UTC ISO) -> club time
  if (!utcIso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: state.config?.timezone || 'Africa/Kampala', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utcIso)).map((x) => [x.type, x.value]));
  return fmtDT(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`);
}
const ROLE_LABEL = { admin: 'Administrator', leader: 'Club leader', secretary: 'Secretary' };
const can = (perm) => !!state.config?.permissions.includes(perm);
const todayStr = () => state.config.now.slice(0, 10);
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let r;
  try { r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { const e = new Error('Cannot reach the server. Check your internet connection. Your last change was NOT saved.'); e.offline = true; throw e; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && state.user) { state.user = null; renderLogin('Your session ended. Please sign in again.'); }
    const e = new Error(data.error || 'Something went wrong.'); e.status = r.status; e.fields = data.fields || {}; throw e;
  }
  return data;
}

const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const demoBadge = (x) => (x.is_demo ? ' ' + badge('Example', 'b-demo') : '');
const phaseBadge = (p) => ({ upcoming: badge('Upcoming', 'b-info'), held: badge('Held', 'b-grey'), cancelled: badge('Cancelled', 'b-bad') }[p]);
const taskBadge = (s) => ({ open: badge('Open', 'b-info'), done: badge('Completed', 'b-ok'), overdue: badge('Overdue', 'b-bad') }[s]);
const attBadge = (s) => ({ present: badge('Present', 'b-ok'), late: badge('Late', 'b-warn'), absent: badge('Absent', 'b-bad'), excused: badge('Excused', 'b-info') }[s] || badge('Not recorded', 'b-grey'));

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, reasonLabel }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-labelledby', 'dlg-t');
    d.innerHTML = `<h2 class="mt0" id="dlg-t">${esc(title)}</h2><p>${esc(message)}</p>
      ${reasonLabel ? `<label for="dlg-reason">${esc(reasonLabel)}</label><input id="dlg-reason" maxlength="300">` : ''}
      <div class="row end mt1"><button type="button" data-r="no">Cancel</button><button type="button" data-r="yes" class="${danger ? 'danger' : 'primary'}">${esc(confirmText)}</button></div>`;
    document.body.appendChild(d);
    const done = (v) => { const reason = d.querySelector('#dlg-reason')?.value || ''; d.close(); d.remove(); resolve(v ? { reason } : null); };
    d.addEventListener('click', (e) => { const r = e.target.dataset?.r; if (r) done(r === 'yes'); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    d.showModal(); d.querySelector('[data-r=no]').focus();
  });
}

function field(name, label, value = '', opts = {}) {
  const { type = 'text', required, hint, maxlength, options, rows } = opts;
  const id = 'f-' + name;
  let input;
  if (options) input = `<select id="${id}" name="${name}" ${required ? 'required' : ''}>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  else if (type === 'textarea') input = `<textarea id="${id}" name="${name}" maxlength="${maxlength || 4000}">${esc(value)}</textarea>`;
  else input = `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${maxlength ? `maxlength="${maxlength}"` : ''} ${type === 'password' ? 'autocomplete="off"' : ''}>`;
  return `<div><label for="${id}">${esc(label)}${required ? ' <span aria-hidden="true">*</span>' : ''}${hint ? ` <span class="hint">${esc(hint)}</span>` : ''}</label>${input}<div class="field-error" id="e-${name}" aria-live="polite"></div></div>`;
}
function showErrors(form, err) {
  form.querySelectorAll('.field-error').forEach((e) => { e.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  let box = form.querySelector('.form-error'); if (box) box.remove();
  if (!err) return;
  let first;
  for (const [k, m] of Object.entries(err.fields || {})) {
    const el = form.querySelector(`#e-${k}`), inp = form.querySelector(`[name=${k}]`);
    if (el) el.textContent = m;
    if (inp) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'e-' + k); first = first || inp; }
  }
  box = document.createElement('div'); box.className = 'form-error'; box.setAttribute('role', 'alert'); box.textContent = err.message;
  form.prepend(box);
  (first || box).focus?.();
  if (!first) box.scrollIntoView({ block: 'nearest' });
}
// Flags every empty required field at once (the server still re-checks everything).
function missingRequired(form) {
  const fields = {};
  form.querySelectorAll('[required]').forEach((el) => { if (!String(el.value).trim()) { const label = form.querySelector(`label[for="${el.id}"]`)?.firstChild?.textContent.trim() || 'This'; fields[el.name] = `${label} is required.`; } });
  const keys = Object.keys(fields);
  return keys.length ? { message: keys.length === 1 ? 'Please fill in the field marked below.' : `Please fill in the ${keys.length} fields marked below.`, fields } : null;
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());

/* ---------- install as an app (PWA) ---------- */
let installEvt = null;
const syncInstall = () => { const b = document.getElementById('install'); if (b) b.hidden = !installEvt; };
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; syncInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; syncInstall(); toast('App installed.'); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });

/* ---------- layout ---------- */
const NAV = [['#/', 'Dashboard'], ['#/activities', 'Activities'], ['#/members', 'Members'], ['#/tasks', 'Tasks'], ['#/reports', 'Reports'], ['#/users', 'Users', 'users.manage'], ['#/audit', 'Audit history', 'audit.read'], ['#/account', 'My account']];
function shell(active, inner) {
  const nav = NAV.filter((n) => !n[2] || can(n[2])).map(([h, t]) => `<a href="${h}" ${active === h ? 'aria-current="page"' : ''}>${t}</a>`).join('');
  $app.innerHTML = `<header class="top"><div class="top-in"><a class="brand" href="#/">The Aids Challenge Youth Club<small>Club activity system</small></a>
    <span class="small muted">${esc(state.user.display_name)} · ${ROLE_LABEL[state.user.role]}</span>
    <button id="install" type="button" hidden>Install app</button><button id="logout" type="button">Sign out</button></div><nav class="main" aria-label="Main">${nav}</nav></header><main id="main" tabindex="-1">${inner}</main>`;
  syncInstall();
  document.getElementById('install').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; syncInstall(); };
  document.getElementById('logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch {} state.user = null; state.csrf = null; location.hash = '#/'; renderLogin(); };
}
const loading = () => { const m = document.getElementById('main'); if (m) m.innerHTML = '<p class="empty">Loading…</p>'; };
const setMain = (html) => { document.getElementById('main').innerHTML = html; };

/* ---------- login / password ---------- */
function renderLogin(msg) {
  document.title = 'Sign in · Club Activity System';
  $app.innerHTML = `<div class="login"><div class="card"><h1 class="ctr">The Aids Challenge Youth Club</h1><p class="ctr muted">Club activity system. Sign in to continue.</p>
    ${msg ? `<div class="form-error" role="alert">${esc(msg)}</div>` : ''}
    <form id="login" novalidate><div id="login-err"></div>${field('username', 'Username', '', { required: true })}${field('password', 'Password', '', { type: 'password', required: true })}
    <div class="mt1"><button class="primary w100" type="submit">Sign in</button></div></form>
    <p class="small muted">Forgot your password? Ask a club administrator to reset it.</p></div></div>`;
  const f = document.getElementById('login');
  f.querySelector('[name=username]').focus();
  f.onsubmit = async (e) => {
    e.preventDefault(); showErrors(f, null);
    const d = formData(f);
    if (!d.username.trim() || !d.password) return showErrors(f, { message: 'Enter your username and password.', fields: { [d.username.trim() ? 'password' : 'username']: 'Required.' } });
    try { const r = await api('POST', '/api/login', d); state.csrf = r.csrf; await boot(); } catch (err) { showErrors(f, err); }
  };
}
function renderChangePassword(forced) {
  const inner = `<h1>${forced ? 'Choose a new password' : 'My account'}</h1>
    ${forced ? '<p>Your password was set by an administrator. Please choose your own before continuing.</p>' : `<p><strong>${esc(state.user.display_name)}</strong> (${esc(state.user.username)}) · ${ROLE_LABEL[state.user.role]}</p>`}
    <div class="card"><h2 class="mt0">Change password</h2><form id="pw" novalidate>
    ${field('current_password', forced ? 'Temporary password' : 'Current password', '', { type: 'password', required: true })}
    ${field('new_password', 'New password', '', { type: 'password', required: true, hint: `At least ${state.config?.min_password || 10} characters` })}
    <div class="mt1"><button class="primary" type="submit">Save new password</button></div></form></div>`;
  if (forced) $app.innerHTML = `<main class="narrow" id="main">${inner}</main>`; else shell('#/account', inner);
  const f = document.getElementById('pw');
  f.onsubmit = async (e) => {
    e.preventDefault(); showErrors(f, null);
    const miss = missingRequired(f); if (miss) return showErrors(f, miss);
    try { await api('POST', '/api/password', formData(f)); toast('Password changed.'); if (forced) { await boot(); } else f.reset(); } catch (err) { showErrors(f, err); }
  };
}

/* ---------- dashboard ---------- */
async function viewDashboard() {
  shell('#/', '<p class="empty">Loading…</p>');
  const d = await api('GET', '/api/dashboard');
  const actItem = (a, extra = '') => `<li><div class="row between"><a href="#/activity/${a.id}"><strong>${esc(a.title)}</strong></a>${phaseBadge(a.phase)}</div>
    <div class="small muted">${fmtDT(a.starts_at)} · ${esc(a.location)}${demoBadge(a)}</div>${extra}</li>`;
  setMain(`<h1>Dashboard</h1>
    <div class="grid g4 mb1">
      <div class="stat"><b>${d.active_members}</b><span>Active members</span></div>
      <div class="stat"><b>${d.recent_attendance_rate === null ? '–' : d.recent_attendance_rate + '%'}</b><span>Attendance, last 5 held</span></div>
      <div class="stat"><b>${d.open_tasks.length}</b><span>Open follow-up tasks</span></div>
      <div class="stat ${d.overdue_count ? 'alert' : ''}"><b>${d.overdue_count}</b><span>Overdue tasks</span></div></div>
    ${can('activities.write') ? '<p><a class="btn primary" href="#/activity/new">+ New activity</a></p>' : ''}
    ${d.needs_attendance.length ? `<div class="card bd-warn"><strong>Attendance not recorded yet</strong><ul class="plain">${d.needs_attendance.map((a) => `<li><a href="#/activity/${a.id}/attendance">${esc(a.title)}</a> <span class="muted small">${fmtDT(a.starts_at)}</span></li>`).join('')}</ul></div>` : ''}
    <div class="grid g2">
    <section class="card"><h2 class="mt0">Upcoming activities</h2>${d.upcoming.length ? `<ul class="plain">${d.upcoming.map((a) => actItem(a)).join('')}</ul>` : '<p class="empty">Nothing planned yet.</p>'}</section>
    <section class="card"><h2 class="mt0">Recent meetings and activities</h2>${d.recent.length ? `<ul class="plain">${d.recent.map((a) => actItem(a, `<div class="small">${a.attendance_recorded ? `${a.attended} of ${a.attendance_recorded} attended` : '<span class="muted">Attendance not recorded</span>'}</div>`)).join('')}</ul>` : '<p class="empty">No past activities yet.</p>'}</section></div>
    <section class="card"><h2 class="mt0">Open follow-up tasks</h2>${taskTable(d.open_tasks.slice(0, 10), true)}${d.open_tasks.length > 10 ? '<p><a href="#/tasks">See all tasks</a></p>' : ''}</section>`);
}
function taskTable(tasks, showActivity) {
  if (!tasks.length) return '<p class="empty">No tasks.</p>';
  return `<div class="tablewrap"><table><thead><tr><th>Task</th>${showActivity ? '<th>Activity</th>' : ''}<th>Responsible</th><th>Due</th><th>Status</th></tr></thead><tbody>${tasks.map((t) => `<tr><td>${esc(t.title)}</td>${showActivity ? `<td><a href="#/activity/${t.activity_id}">${esc(t.activity_title)}</a></td>` : ''}<td>${esc(t.responsible_name || '—')}</td><td>${fmtD(t.due_date)}</td><td>${taskBadge(t.status)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------- activities ---------- */
async function viewActivities() {
  shell('#/activities', '<p class="empty">Loading…</p>');
  const phase = new URLSearchParams(location.hash.split('?')[1] || '').get('phase') || '';
  const { activities } = await api('GET', '/api/activities' + (phase ? `?phase=${phase}` : ''));
  setMain(`<div class="row between"><h1>Activities</h1>${can('activities.write') ? '<a class="btn primary" href="#/activity/new">+ New activity</a>' : ''}</div>
    <div class="row noprint" role="group" aria-label="Filter">${[['', 'All'], ['upcoming', 'Upcoming'], ['held', 'Held'], ['cancelled', 'Cancelled']].map(([v, t]) => `<a class="btn sel" ${phase === v ? 'aria-current="true"' : ''} href="#/activities${v ? '?phase=' + v : ''}">${t}</a>`).join('')}</div>
    <div class="card mt1">${activities.length ? `<div class="tablewrap"><table><thead><tr><th>Date and time</th><th>Activity</th><th>Type</th><th>Organizer</th><th>Attendance</th><th>Status</th></tr></thead><tbody>
    ${activities.map((a) => `<tr><td>${fmtDT(a.starts_at)}</td><td><a href="#/activity/${a.id}"><strong>${esc(a.title)}</strong></a>${demoBadge(a)}<div class="small muted">${esc(a.location)}</div></td><td>${esc(a.type)}</td><td>${esc(a.organizer_name || '—')}</td>
    <td>${a.phase === 'cancelled' ? '—' : a.attendance_recorded ? `${a.attended} of ${a.attendance_recorded}` : '<span class="muted">Not recorded</span>'}</td><td>${phaseBadge(a.phase)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No activities found.</p>'}</div>`);
}

async function activityForm(existing) {
  shell('#/activities', '<p class="empty">Loading…</p>');
  const { members } = await api('GET', '/api/members?status=active');
  const a = existing || { title: '', type: 'Meeting', starts_at: `${todayStr()}T15:00`, location: '', description: '', organizer_member_id: '' };
  const orgOpts = [['', 'Choose a person…'], ...members.map((m) => [m.id, m.full_name])];
  setMain(`<h1>${existing ? 'Edit activity' : 'New activity'}</h1><div class="card"><form id="af" novalidate>
    ${field('title', 'Title', a.title, { required: true, maxlength: 150 })}
    <div class="two">${field('type', 'Activity type', a.type, { required: true, options: state.config.activity_types.map((t) => [t, t]) })}
    ${field('organizer_member_id', 'Responsible organizer', a.organizer_member_id ?? '', { required: true, options: orgOpts })}
    ${field('date', 'Date', a.starts_at.slice(0, 10), { type: 'date', required: true })}${field('time', 'Time', a.starts_at.slice(11, 16), { type: 'time', required: true })}</div>
    ${field('location', 'Location', a.location, { required: true, maxlength: 150 })}
    ${field('description', 'Agenda or description', a.description, { type: 'textarea', hint: '(optional)' })}
    <div class="row mt1"><button class="primary" type="submit">${existing ? 'Save changes' : 'Create activity'}</button><a class="btn" href="${existing ? '#/activity/' + existing.id : '#/activities'}">Cancel</a></div></form></div>`);
  const f = document.getElementById('af');
  f.onsubmit = async (e) => {
    e.preventDefault(); showErrors(f, null);
    const miss = missingRequired(f); if (miss) { return showErrors(f, miss); }
    const d = formData(f);
    const body = { title: d.title, type: d.type, organizer_member_id: d.organizer_member_id, location: d.location, description: d.description,
      starts_at: d.date && d.time ? `${d.date}T${d.time}` : '' };
    try {
      const r = existing ? await api('PATCH', `/api/activities/${existing.id}`, body) : await api('POST', '/api/activities', body);
      toast(existing ? 'Activity updated.' : 'Activity created.'); location.hash = existing ? `#/activity/${existing.id}` : `#/activity/${r.activity.id}/attendance`;
    } catch (err) { if (err.fields?.starts_at) { err.fields.date = err.fields.starts_at; } showErrors(f, err); }
  };
}

async function viewActivity(id, tab) {
  shell('#/activities', '<p class="empty">Loading…</p>');
  const { activity: a, notes, tasks } = await api('GET', `/api/activities/${id}`);
  document.title = `${a.title} · Club Activity System`;
  const tabs = [['', 'Details'], ['attendance', 'Attendance'], ['notes', 'Notes and tasks']];
  const head = `<div class="row between"><h1 class="mb03">${esc(a.title)}${demoBadge(a)}</h1><div>${phaseBadge(a.phase)}</div></div>
    <p class="muted mt0">${fmtDT(a.starts_at)} · ${esc(a.location)}</p>
    <div class="tabs noprint" role="tablist">${tabs.map(([k, t]) => `<button role="tab" type="button" aria-selected="${tab === k}" data-tab="${k}">${t}</button>`).join('')}</div>`;
  const body = tab === 'attendance' ? '<div id="tabbody"><p class="empty">Loading…</p></div>' : tab === 'notes' ? '<div id="tabbody"></div>' : '<div id="tabbody"></div>';
  setMain(head + body);
  document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/activity/${id}${b.dataset.tab ? '/' + b.dataset.tab : ''}`; }; });
  const tb = document.getElementById('tabbody');
  if (tab === 'attendance') return attendanceTab(a, tb);
  if (tab === 'notes') return notesTab(a, notes, tasks, tb);
  tb.innerHTML = `<div class="card"><dl class="kv"><dt>Type</dt><dd>${esc(a.type)}</dd><dt>Organizer</dt><dd>${esc(a.organizer_name || '—')}</dd><dt>Date and time</dt><dd>${fmtDT(a.starts_at)}</dd><dt>Location</dt><dd>${esc(a.location)}</dd>
    ${a.status === 'cancelled' ? `<dt>Cancelled</dt><dd>${esc(a.cancel_reason || 'No reason given')}</dd>` : ''}</dl>
    <h3>Agenda / description</h3><div class="notes-view">${esc(a.description) || '<span class="muted">None</span>'}</div>
    <div class="row noprint mt1">${a.status !== 'cancelled' && can('activities.write') ? `<a class="btn" href="#/activity/${a.id}/edit">Edit</a><button type="button" id="cancel-act" class="danger">Cancel this activity</button>` : ''}
    ${can('activities.delete') ? '<button type="button" id="del-act" class="danger">Delete permanently</button>' : ''}</div></div>`;
  const c = document.getElementById('cancel-act');
  if (c) c.onclick = async () => {
    const r = await confirmDialog({ title: 'Cancel this activity?', message: 'It will stay in the records as cancelled. Attendance cannot be recorded for it.', confirmText: 'Cancel activity', danger: true, reasonLabel: 'Reason (optional)' });
    if (!r) return;
    try { await api('POST', `/api/activities/${a.id}/cancel`, { reason: r.reason }); toast('Activity cancelled.'); viewActivity(id, ''); } catch (e) { toast(e.message); }
  };
  const del = document.getElementById('del-act');
  if (del) del.onclick = async () => {
    if (!await confirmDialog({ title: 'Delete this activity permanently?', message: 'This also deletes its attendance, notes and tasks and cannot be undone. If it simply will not happen, cancel it instead.', confirmText: 'Delete permanently', danger: true })) return;
    try { await api('DELETE', `/api/activities/${a.id}`); toast('Activity deleted.'); location.hash = '#/activities'; } catch (e) { toast(e.message); }
  };
}

async function attendanceTab(a, tb) {
  const { records, counts } = await api('GET', `/api/activities/${a.id}/attendance`);
  if (a.status === 'cancelled') { tb.innerHTML = '<div class="card"><p>This activity was cancelled, so attendance cannot be recorded.</p></div>'; return; }
  const writable = can('attendance.write');
  const roNote = writable ? '' : '<p class="small muted">Attendance is recorded by the club leader. You can view it here.</p>';
  const summary = (c) => `<span class="badge b-ok">Present ${c.present}</span> <span class="badge b-warn">Late ${c.late}</span> <span class="badge b-bad">Absent ${c.absent}</span> <span class="badge b-info">Excused ${c.excused}</span>`;
  const rows = records.map((r) => `<div class="att-row" data-member="${r.member_id}"><div><strong>${esc(r.full_name)}</strong>${r.member_status !== 'active' ? ' ' + badge('Inactive', 'b-grey') : ''}</div>
    ${writable ? `<div class="seg" role="radiogroup" aria-label="Attendance for ${esc(r.full_name)}">${state.config.attendance_statuses.map((s) => `<label><input type="radio" name="att-${r.member_id}" value="${s}" ${r.status === s ? 'checked' : ''}><span class="s-${s}">${s[0].toUpperCase() + s.slice(1)}</span></label>`).join('')}</div>` : `<div>${attBadge(r.status)}</div>`}</div>`).join('');
  tb.innerHTML = `<div class="card"><div class="row between"><div id="att-sum" aria-live="polite">${summary(counts)}</div>
    ${writable ? '<div class="row noprint"><button type="button" id="all-present">Mark everyone present</button></div>' : ''}</div>
    ${roNote}${writable ? '<p class="small muted">Choose a status for each person, then press Save. You can come back and correct it later; corrections are logged.</p>' : ''}
    <div id="att-list">${rows || '<p class="empty">There are no active members yet. Add members first.</p>'}</div>
    ${writable && records.length ? `<div class="savebar noprint"><button class="primary" id="save-att" type="button">Save attendance</button><span id="att-left" class="small muted"></span></div>` : ''}
    <p class="print-only small">Printed ${fmtD(todayStr())}</p><div class="row noprint"><button type="button" data-print>Print attendance list</button></div></div>`;
  if (!writable) return;
  const left = () => {
    const rowsEl = [...tb.querySelectorAll('.att-row')]; const unmarked = rowsEl.filter((r) => !r.querySelector('input:checked')).length;
    const c = { present: 0, late: 0, absent: 0, excused: 0 }; rowsEl.forEach((r) => { const v = r.querySelector('input:checked'); if (v) c[v.value]++; });
    document.getElementById('att-sum').innerHTML = summary(c);
    const l = document.getElementById('att-left'); if (l) l.textContent = unmarked ? `${unmarked} not marked yet` : 'Everyone marked';
  };
  left(); tb.addEventListener('change', left);
  document.getElementById('all-present')?.addEventListener('click', () => { tb.querySelectorAll('.att-row').forEach((r) => { if (!r.querySelector('input:checked')) r.querySelector('input[value=present]').checked = true; }); left(); });
  document.getElementById('save-att')?.addEventListener('click', async (ev) => {
    const recs = [...tb.querySelectorAll('.att-row')].map((r) => ({ member_id: +r.dataset.member, v: r.querySelector('input:checked') })).filter((r) => r.v).map((r) => ({ member_id: r.member_id, status: r.v.value }));
    if (!recs.length) return toast('Mark at least one person first.');
    ev.target.disabled = true;
    try { const r = await api('PUT', `/api/activities/${a.id}/attendance`, { records: recs }); toast(r.changed ? `Attendance saved (${r.changed} updated).` : 'Nothing changed.'); }
    catch (e) { toast(e.message); } finally { ev.target.disabled = false; }
  });
}

function notesTab(a, notes, tasks, tb) {
  const w = can('notes.write'), tw = can('tasks.write');
  tb.innerHTML = `<div class="card"><h2 class="mt0">Meeting notes</h2>${w ? `<form id="nf">${field('notes', 'Notes', notes.notes, { type: 'textarea', maxlength: 10000 })}${field('decisions', 'Decisions', notes.decisions, { type: 'textarea', maxlength: 10000 })}${field('outcomes', 'Outcomes', notes.outcomes, { type: 'textarea', maxlength: 10000 })}
    <div class="row mt1"><button class="primary" type="submit">Save notes</button>${notes.updated_at ? '<span class="small muted">Saved before</span>' : ''}</div></form>`
    : ['notes', 'decisions', 'outcomes'].map((k) => `<h3>${k[0].toUpperCase() + k.slice(1)}</h3><div class="notes-view">${esc(notes[k]) || '<span class="muted">None</span>'}</div>`).join('')}</div>
    <div class="card"><h2 class="mt0">Follow-up tasks</h2>
    ${tasks.length ? `<div class="tablewrap"><table><thead><tr><th>Task</th><th>Responsible</th><th>Due</th><th>Status</th>${tw ? '<th class="noprint">Actions</th>' : ''}</tr></thead><tbody>${tasks.map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.responsible_name || '—')}</td><td>${fmtD(t.due_date)}</td><td>${taskBadge(t.status)}</td>
    ${tw ? `<td class="noprint"><button class="link" data-toggle="${t.id}" data-to="${t.status === 'done' ? 'open' : 'done'}">${t.status === 'done' ? 'Reopen' : 'Mark done'}</button> <button class="link t-bad" data-deltask="${t.id}">Delete</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">No tasks yet.</p>'}
    ${tw ? '<h3>Add a task</h3><form id="tf" novalidate></form>' : ''}</div>`;
  if (w) {
    const nf = document.getElementById('nf');
    nf.onsubmit = async (e) => { e.preventDefault(); showErrors(nf, null); try { await api('PUT', `/api/activities/${a.id}/notes`, formData(nf)); toast('Notes saved.'); } catch (err) { showErrors(nf, err); } };
  }
  tb.querySelectorAll('[data-toggle]').forEach((b) => { b.onclick = async () => { try { await api('PATCH', `/api/tasks/${b.dataset.toggle}`, { status: b.dataset.to }); viewActivity(a.id, 'notes'); } catch (e) { toast(e.message); } }; });
  tb.querySelectorAll('[data-deltask]').forEach((b) => { b.onclick = async () => {
    if (!await confirmDialog({ title: 'Delete this task?', message: 'This cannot be undone.', confirmText: 'Delete task', danger: true })) return;
    try { await api('DELETE', `/api/tasks/${b.dataset.deltask}`); viewActivity(a.id, 'notes'); } catch (e) { toast(e.message); } }; });
  if (tw) api('GET', '/api/members?status=active').then(({ members }) => {
    const tf = document.getElementById('tf');
    tf.innerHTML = `<div class="two">${field('title', 'Task', '', { required: true, maxlength: 200 })}${field('responsible_member_id', 'Person responsible', '', { required: true, options: [['', 'Choose a person…'], ...members.map((m) => [m.id, m.full_name])] })}${field('due_date', 'Due date', '', { type: 'date', required: true })}</div><div class="mt1"><button class="primary" type="submit">Add task</button></div>`;
    tf.onsubmit = async (e) => { e.preventDefault(); showErrors(tf, null); const miss = missingRequired(tf); if (miss) return showErrors(tf, miss); try { await api('POST', `/api/activities/${a.id}/tasks`, formData(tf)); toast('Task added.'); viewActivity(a.id, 'notes'); } catch (err) { showErrors(tf, err); } };
  });
}

/* ---------- tasks ---------- */
async function viewTasks() {
  shell('#/tasks', '<p class="empty">Loading…</p>');
  const { tasks } = await api('GET', '/api/tasks');
  const by = (s) => tasks.filter((t) => t.status === s);
  setMain(`<h1>Follow-up tasks</h1><div class="card"><h2 class="mt0">Overdue (${by('overdue').length})</h2>${taskTable(by('overdue'), true)}</div>
    <div class="card"><h2 class="mt0">Open (${by('open').length})</h2>${taskTable(by('open'), true)}</div>
    <div class="card"><h2 class="mt0">Completed (${by('done').length})</h2>${taskTable(by('done'), true)}</div>`);
}

/* ---------- members ---------- */
async function viewMembers() {
  shell('#/members', '<p class="empty">Loading…</p>');
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const qs = sp.toString();
  const { members } = await api('GET', '/api/members' + (qs ? '?' + qs : ''));
  setMain(`<div class="row between"><h1>Members</h1>${can('members.write') ? '<a class="btn primary" href="#/member/new">+ Add member</a>' : ''}</div>
    <p class="small muted">Only the details needed to run the club are kept: name, contact details (optional), status and date joined. Do not record health information.</p>
    <form id="ms" class="row noprint" role="search"><div class="grow"><label for="q" class="hint m0">Search by name</label><input id="q" name="q" value="${esc(sp.get('q') || '')}"></div>
    <div><label for="st" class="hint m0">Status</label><select id="st" name="status"><option value="">All</option><option value="active" ${sp.get('status') === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${sp.get('status') === 'inactive' ? 'selected' : ''}>Inactive</option></select></div>
    <button class="self-end" type="submit">Search</button></form>
    <div class="card mt1">${members.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Joined</th><th>Status</th></tr></thead><tbody>${members.map((m) => `<tr><td><a href="#/member/${m.id}"><strong>${esc(m.full_name)}</strong></a>${demoBadge(m)}</td><td>${esc(m.phone) || '—'}</td><td>${esc(m.email) || '—'}</td><td>${fmtD(m.date_joined)}</td><td>${m.status === 'active' ? badge('Active', 'b-ok') : badge('Inactive', 'b-grey')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No members found.</p>'}</div>`);
  document.getElementById('ms').onsubmit = (e) => { e.preventDefault(); const p = new URLSearchParams(formData(e.target)); [...p.keys()].forEach((k) => { if (!p.get(k)) p.delete(k); }); location.hash = '#/members' + (p.toString() ? '?' + p : ''); };
}
async function memberForm(m) {
  shell('#/members', '');
  const x = m || { full_name: '', phone: '', email: '', date_joined: todayStr() };
  setMain(`<h1>${m ? 'Edit member' : 'Add member'}</h1><div class="card"><form id="mf" novalidate>
    ${field('full_name', 'Full name', x.full_name, { required: true, maxlength: 120 })}<div class="two">${field('phone', 'Phone', x.phone, { hint: '(optional)', maxlength: 30 })}${field('email', 'Email', x.email, { hint: '(optional)', maxlength: 120, type: 'email' })}${field('date_joined', 'Date joined', x.date_joined, { type: 'date', required: true })}</div>
    <p class="small muted">Only collect what the club needs to run activities. Do not enter health or HIV information.</p>
    <div class="row"><button class="primary" type="submit">${m ? 'Save changes' : 'Add member'}</button><a class="btn" href="${m ? '#/member/' + m.id : '#/members'}">Cancel</a></div></form></div>`);
  const f = document.getElementById('mf');
  f.onsubmit = async (e) => { e.preventDefault(); showErrors(f, null);
    const miss = missingRequired(f); if (miss) return showErrors(f, miss);
    try { const r = m ? await api('PATCH', `/api/members/${m.id}`, formData(f)) : await api('POST', '/api/members', formData(f)); toast(m ? 'Member updated.' : 'Member added.'); location.hash = `#/member/${r.member.id}`; } catch (err) { showErrors(f, err); } };
}
async function viewMember(id) {
  shell('#/members', '<p class="empty">Loading…</p>');
  const { member: m, stats: s, history } = await api('GET', `/api/members/${id}`);
  setMain(`<div class="row between"><h1>${esc(m.full_name)}${demoBadge(m)}</h1>${m.status === 'active' ? badge('Active', 'b-ok') : badge('Inactive', 'b-grey')}</div>
    <div class="card"><dl class="kv"><dt>Phone</dt><dd>${esc(m.phone) || '—'}</dd><dt>Email</dt><dd>${esc(m.email) || '—'}</dd><dt>Date joined</dt><dd>${fmtD(m.date_joined)}</dd></dl>
    <div class="row noprint mt1">${can('members.write') ? `<a class="btn" href="#/member/${m.id}/edit">Edit details</a>` : ''}
    ${can('members.deactivate') ? `<button type="button" id="toggle" class="${m.status === 'active' ? 'danger' : ''}">${m.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>` : ''}
    ${can('members.remove') ? '<button type="button" id="remove" class="danger">Remove personal data…</button>' : ''}</div></div>
    <div class="card"><h2 class="mt0">Attendance summary</h2><div class="grid g4"><div class="stat"><b>${s.present}</b><span>Present</span></div><div class="stat"><b>${s.late}</b><span>Late</span></div><div class="stat"><b>${s.absent}</b><span>Absent</span></div><div class="stat"><b>${s.excused}</b><span>Excused</span></div></div>
    <p>${s.attendance_rate === null ? 'No attendance recorded yet.' : `Attended ${s.attendance_rate}% of sessions (present or late, not counting excused).`}</p>
    ${history.length ? `<div class="tablewrap"><table><thead><tr><th>Activity</th><th>Date</th><th>Status</th></tr></thead><tbody>${history.map((h) => `<tr><td><a href="#/activity/${h.activity_id}/attendance">${esc(h.title)}</a></td><td>${fmtDT(h.starts_at)}</td><td>${attBadge(h.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`);
  document.getElementById('toggle')?.addEventListener('click', async () => {
    const to = m.status === 'active' ? 'inactive' : 'active';
    if (to === 'inactive' && !await confirmDialog({ title: `Deactivate ${m.full_name}?`, message: 'They will no longer appear on new attendance lists. Their history is kept. You can reactivate them later.', confirmText: 'Deactivate', danger: true })) return;
    try { await api('PATCH', `/api/members/${m.id}`, { status: to }); toast(to === 'inactive' ? 'Member deactivated.' : 'Member reactivated.'); viewMember(id); } catch (e) { toast(e.message); }
  });
  document.getElementById('remove')?.addEventListener('click', async () => {
    const r = await confirmDialog({ title: `Remove personal data for ${m.full_name}?`, message: 'Name, phone and email are permanently erased. Anonymous attendance counts stay so reports remain accurate. This cannot be undone. Follow the club\'s approved retention rules.', confirmText: 'Remove personal data', danger: true, reasonLabel: 'Reason (e.g. member request)' });
    if (!r) return;
    try { await api('POST', `/api/members/${m.id}/remove`, { confirm: true, reason: r.reason }); toast('Personal data removed.'); location.hash = '#/members'; } catch (e) { toast(e.message); }
  });
}

/* ---------- reports ---------- */
async function viewReports() {
  shell('#/reports', '<p class="empty">Loading…</p>');
  const sp = new URLSearchParams(location.hash.split('?')[1] || '');
  const t = todayStr();
  const from = sp.get('from') || addDays(t, -30), to = sp.get('to') || t;
  setMain(`<h1>Reports</h1><form id="rf" class="card row noprint ai-end" novalidate><div><label class="m0" for="from">From</label><input id="from" name="from" type="date" value="${from}"></div>
    <div><label class="m0" for="to">To</label><input id="to" name="to" type="date" value="${to}"></div><button class="primary" type="submit">Create report</button></form><div id="rep"></div>`);
  document.getElementById('rf').onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); location.hash = `#/reports?from=${d.from}&to=${d.to}`; };
  const rep = document.getElementById('rep');
  let r;
  try { r = await api('GET', `/api/reports?from=${from}&to=${to}`); } catch (e) { rep.innerHTML = `<div class="form-error" role="alert">${esc(e.message)}</div>`; return; }
  const att = r.attendance_totals;
  rep.innerHTML = `<div class="row between noprint"><span></span><div class="row"><button type="button" data-print>Print</button><a class="btn" href="/api/reports?from=${from}&to=${to}&format=csv" download>Export CSV</a></div></div>
    <div class="card"><h2 class="mt0">The Aids Challenge Youth Club: activity report</h2><p>${fmtD(r.from)} to ${fmtD(r.to)} · created ${fmtD(r.generated_at.slice(0, 10))}</p>
    <div class="grid g4"><div class="stat"><b>${r.activities_held}</b><span>Activities held</span></div><div class="stat"><b>${r.activities_upcoming}</b><span>Still to come</span></div><div class="stat"><b>${r.activities_cancelled}</b><span>Cancelled</span></div>
    <div class="stat"><b>${att.present + att.late}</b><span>Attendances (present + late)</span></div></div>
    <p>Attendance totals: Present ${att.present}, Late ${att.late}, Absent ${att.absent}, Excused ${att.excused}.</p>
    <h2>Activities held</h2>${r.per_activity.length ? `<div class="tablewrap"><table><thead><tr><th>Date and time</th><th>Activity</th><th>Present</th><th>Late</th><th>Absent</th><th>Excused</th></tr></thead><tbody>${r.per_activity.map((a) => `<tr><td>${fmtDT(a.starts_at)}</td><td>${esc(a.title)}${demoBadge(a)}</td>${a.recorded ? `<td>${a.counts.present}</td><td>${a.counts.late}</td><td>${a.counts.absent}</td><td>${a.counts.excused}</td>` : '<td colspan="4" class="muted">Attendance not recorded</td>'}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">No activities held in this period.</p>'}
    <h2>Member participation</h2>${r.participation.length ? `<div class="tablewrap"><table><thead><tr><th>Member</th><th>Present</th><th>Late</th><th>Absent</th><th>Excused</th><th>Attended</th></tr></thead><tbody>${r.participation.map((p) => `<tr><td>${esc(p.full_name)}</td><td>${p.present}</td><td>${p.late}</td><td>${p.absent}</td><td>${p.excused}</td><td>${p.attendance_rate === null ? '—' : p.attendance_rate + '%'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No attendance recorded in this period.</p>'}
    <h2>Outstanding tasks (as of today)</h2>${taskTable(r.outstanding_tasks, true)}</div>`;
}

/* ---------- admin: users, audit ---------- */
async function viewUsers() {
  shell('#/users', '<p class="empty">Loading…</p>');
  const { users } = await api('GET', '/api/users');
  setMain(`<h1>Users</h1><p class="muted small">Administrator: everything, including users, audit history, backups, deleting activities and removing personal data. Club leader: records attendance and can view everything and run reports. Secretary: manages members, activities, notes, tasks and reports (does not record attendance).</p>
    <div class="card"><div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.display_name)}</td><td>${esc(u.username)}</td><td>${ROLE_LABEL[u.role]}</td><td>${u.active ? badge('Active', 'b-ok') : badge('Deactivated', 'b-grey')}</td>
    <td><button class="link" data-reset="${u.id}">Reset password</button> ${u.id !== state.user.id ? `<button class="link" data-act="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Reactivate'}</button> <label class="hint" for="r${u.id}">Role</label> <select id="r${u.id}" class="rolesel" data-role="${u.id}">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : '<span class="muted small">(you)</span>'}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h2 class="mt0">Add a user</h2><form id="uf" novalidate><div class="two">${field('display_name', 'Full name', '', { required: true })}${field('username', 'Username', '', { required: true, hint: 'Letters, numbers, . - _' })}
    ${field('role', 'Role', 'secretary', { required: true, options: [['secretary', 'Secretary'], ['leader', 'Club leader'], ['admin', 'Administrator']] })}${field('password', 'Temporary password', '', { required: true, type: 'password', hint: `At least ${state.config.min_password} characters. They must change it at first sign-in.` })}</div>
    <div class="mt1"><button class="primary" type="submit">Add user</button></div></form></div>
    <div class="card"><h2 class="mt0">Backup</h2><p>Download a complete copy of all club records. Keep it somewhere safe and private (it contains personal information). See the user guide for how to restore.</p><a class="btn" href="/api/backup" download>Download backup file</a></div>`);
  const uf = document.getElementById('uf');
  uf.onsubmit = async (e) => { e.preventDefault(); showErrors(uf, null); const miss = missingRequired(uf); if (miss) return showErrors(uf, miss); try { await api('POST', '/api/users', formData(uf)); toast('User added.'); viewUsers(); } catch (err) { showErrors(uf, err); } };
  const patch = async (id, body, okMsg) => { try { await api('PATCH', `/api/users/${id}`, body); toast(okMsg); viewUsers(); } catch (e) { toast(e.message); } };
  document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => { if (b.dataset.active === '0' && !await confirmDialog({ title: 'Deactivate this user?', message: 'They will be signed out and unable to sign in.', confirmText: 'Deactivate', danger: true })) return; patch(b.dataset.act, { active: b.dataset.active === '1' }, 'User updated.'); }; });
  document.querySelectorAll('[data-role]').forEach((sel) => { sel.onchange = async () => { const to = sel.value; if (!await confirmDialog({ title: 'Change role?', message: `This user will become: ${ROLE_LABEL[to]}.`, confirmText: 'Change role' })) return viewUsers(); patch(sel.dataset.role, { role: to }, 'Role changed.'); }; });
  document.querySelectorAll('[data-reset]').forEach((b) => { b.onclick = async () => {
    const d = document.createElement('dialog'); d.innerHTML = `<h2 class="mt0">Reset password</h2><form id="rp" method="dialog" novalidate>${field('new_password', 'New temporary password', '', { type: 'password', required: true, hint: `At least ${state.config.min_password} characters` })}<div class="row end mt1"><button type="button" id="rp-c">Cancel</button><button class="primary" type="submit">Reset</button></div></form>`;
    document.body.appendChild(d); d.showModal(); const f = d.querySelector('form'); d.querySelector('#rp-c').onclick = () => { d.close(); d.remove(); };
    f.onsubmit = async (e) => { e.preventDefault(); showErrors(f, null); try { await api('PATCH', `/api/users/${b.dataset.reset}`, { new_password: formData(f).new_password }); d.close(); d.remove(); toast('Password reset. The user must change it at next sign-in.'); } catch (err) { showErrors(f, err); } };
  }; });
}
const ACTION_TEXT = { login: 'Signed in', logout: 'Signed out', login_failed: 'Failed sign-in', password_changed: 'Changed own password', password_reset: 'Reset a password', user_created: 'Created user', user_updated: 'Updated user',
  member_created: 'Added member', member_updated: 'Updated member', member_deactivated: 'Deactivated member', member_reactivated: 'Reactivated member', member_personal_data_removed: 'Removed member personal data',
  activity_created: 'Created activity', activity_updated: 'Updated activity', activity_cancelled: 'Cancelled activity', activity_deleted: 'Deleted activity', attendance_recorded: 'Recorded attendance', attendance_corrected: 'Corrected attendance',
  notes_saved: 'Saved notes', task_created: 'Added task', task_completed: 'Completed task', task_reopened: 'Reopened task', task_updated: 'Updated task', task_deleted: 'Deleted task', report_exported: 'Exported report', backup_downloaded: 'Downloaded backup' };
function auditSummary(a) {
  const d = a.detail; if (!d) return '';
  if (d.changes) return d.title + ': ' + d.changes.map((c) => `${c.name}: ${c.from || 'not recorded'} → ${c.to}`).join('; ');
  if (d.from && d.to && !Array.isArray(d.from)) return Object.entries(d.to).map(([k, v]) => `${k}: ${d.from[k]} → ${v}`).join('; ');
  return Object.entries(d).map(([k, v]) => Array.isArray(v) ? `${k}: ${v[0] || '—'} → ${v[1] || '—'}` : `${k}: ${v}`).join('; ');
}
async function viewAudit() {
  shell('#/audit', '<p class="empty">Loading…</p>');
  const { audit } = await api('GET', '/api/audit?limit=300');
  setMain(`<h1>Audit history</h1><p class="muted small">Who changed what, and when (times in ${esc(state.config.timezone)}). Latest 300 entries. This log cannot be edited from the app.</p>
    <div class="card"><div class="tablewrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>${audit.map((a) => `<tr><td>${fmtStamp(a.at)}</td><td>${esc(a.username || '—')}</td><td>${esc(ACTION_TEXT[a.action] || a.action)}</td><td class="small">${esc(auditSummary(a))}</td></tr>`).join('')}</tbody></table></div></div>`);
}

/* ---------- router ---------- */
async function route() {
  if (!state.user) return;
  if (state.user.must_change) return renderChangePassword(true);
  const [path] = location.hash.slice(1).split('?'); const p = path.split('/').filter(Boolean);
  try {
    document.title = 'Club Activity System · The Aids Challenge Youth Club';
    if (!p.length) await viewDashboard();
    else if (p[0] === 'activities') await viewActivities();
    else if (p[0] === 'activity' && p[1] === 'new') { if (!can('activities.write')) throw new Error('You do not have permission to do that.'); await activityForm(); }
    else if (p[0] === 'activity' && p[2] === 'edit') { if (!can('activities.write')) throw new Error('You do not have permission to do that.'); const r = await api('GET', `/api/activities/${p[1]}`); await activityForm(r.activity); }
    else if (p[0] === 'activity') await viewActivity(p[1], p[2] || '');
    else if (p[0] === 'members') await viewMembers();
    else if (p[0] === 'member' && p[1] === 'new') await memberForm();
    else if (p[0] === 'member' && p[2] === 'edit') { const r = await api('GET', `/api/members/${p[1]}`); await memberForm(r.member); }
    else if (p[0] === 'member') await viewMember(p[1]);
    else if (p[0] === 'tasks') await viewTasks();
    else if (p[0] === 'reports') await viewReports();
    else if (p[0] === 'users') await viewUsers();
    else if (p[0] === 'audit') await viewAudit();
    else if (p[0] === 'account') renderChangePassword(false);
    else await viewDashboard();
    document.getElementById('main')?.focus({ preventScroll: true });
  } catch (e) {
    if (!state.user) return;
    shell('', `<h1>Sorry</h1><div class="form-error" role="alert">${esc(e.message)}</div><p><a class="btn" href="#/">Back to dashboard</a></p>`);
  }
}

async function boot() {
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user; state.csrf = me.csrf; state.config = me.config;
    await route();
  } catch (e) { if (e.offline) { $app.innerHTML = `<div class="login"><div class="card"><h1>Cannot connect</h1><p>${esc(e.message)}</p><button class="primary" data-reload>Try again</button></div></div>`; } else renderLogin(); }
}
window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => { if (e.target.closest('[data-print]')) print(); if (e.target.closest('[data-reload]')) location.reload(); });
const offlineBanner = document.getElementById('offline');
const syncOnline = () => { offlineBanner.hidden = navigator.onLine; };
window.addEventListener('online', syncOnline); window.addEventListener('offline', syncOnline); syncOnline();
boot();
