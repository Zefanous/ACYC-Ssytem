'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSqliteStore, storeFromEnv } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TZ = process.env.CLUB_TZ || 'Africa/Kampala';
const SESSION_HOURS = 8;
const ACTIVITY_TYPES = ['Meeting', 'Event', 'Outreach', 'Training', 'Other']; // editable default list (assumption)
const ROLES = ['admin', 'leader', 'secretary'];
const ATT_STATUSES = ['present', 'absent', 'late', 'excused'];
const MIN_PASSWORD = 10;

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
const bad = (msg, fields) => new HttpError(400, msg, fields);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function clubNow(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
function req_(obj, name, label, max = 200) {
  const v = str(obj[name]);
  if (!v) throw bad(`${label} is required.`, { [name]: `${label} is required.` });
  if (v.length > max) throw bad(`${label} is too long (max ${max} characters).`, { [name]: 'Too long.' });
  return v;
}
function opt(obj, name, label, max = 200) {
  const v = str(obj[name]);
  if (v.length > max) throw bad(`${label} is too long (max ${max} characters).`, { [name]: 'Too long.' });
  return v;
}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const isDateTime = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && isDate(s.slice(0, 10))
  && +s.slice(11, 13) < 24 && +s.slice(14, 16) < 60;

/* ---------- app factory ---------- */
function createApp({ dbPath, store: givenStore, now = () => clubNow(), secureCookies = process.env.COOKIE_SECURE === '1', secret = process.env.SESSION_SECRET } = {}) {
  const store = givenStore || (dbPath ? createSqliteStore(dbPath) : storeFromEnv());
  if (store.kind === 'sheets' && !secret) throw new Error('SESSION_SECRET must be set when using Google Sheets storage (any long random text).');
  const key = Buffer.from(secret || crypto.randomBytes(32));
  let db = null; // the database of the request being handled (set synchronously just before each handler runs)
  const q = (sql) => db.prepare(sql);
  const today = () => now().slice(0, 10);
  const TRUST_PROXY = process.env.TRUST_PROXY === '1';

  function audit(user, action, entity, entityId, detail) {
    q('INSERT INTO audit (at,user_id,username,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), user ? user.id : null, user ? user.username : null, action, entity, entityId ?? null,
        detail === undefined ? null : JSON.stringify(detail));
  }
  const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  /* ----- sessions: signed, stateless cookies (work on any number of servers) ----- */
  // The token holds the user id, a CSRF secret, an expiry and a fingerprint of the password hash, so a
  // password change/reset, deactivation or role change takes effect immediately.
  const fp = (u) => sha(u.password_hash).slice(0, 12);
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest('base64url');
  function makeToken(u, csrf = crypto.randomBytes(24).toString('hex')) {
    const body = Buffer.from(JSON.stringify({ u: u.id, c: csrf, e: Date.now() + SESSION_HOURS * 3600e3, f: fp(u) })).toString('base64url');
    return { token: `${body}.${mac(body)}`, csrf };
  }
  function getSession(req) {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const [body, sig] = m[1].split('.');
    const a = Buffer.from(sig), b = Buffer.from(mac(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
    if (!p || p.e < Date.now()) return null;
    const row = q('SELECT * FROM users WHERE id=?').get(p.u);
    if (!row || !row.active || fp(row) !== p.f) return null;
    return { csrf: p.c, user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role, must_change: !!row.must_change } };
  }
  const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '');
  const cookie = (req, value, maxAge) => {
    const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https';
    return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  /* ----- permissions ----- */
  // Single place to adjust who can do what. Roles: administrator, club leader, secretary.
  //  - Club leader: records attendance, and can view everything and run reports.
  //  - Secretary: does everything else (members, activities, notes, tasks, reports) but does not record attendance.
  //  - Administrator: everything, plus users, audit history, backups and permanent removals.
  const PERMS = {
    admin: new Set(['members.read', 'members.write', 'members.deactivate', 'members.remove', 'activities.write', 'activities.delete',
      'attendance.write', 'notes.write', 'tasks.write', 'reports.read', 'users.manage', 'audit.read', 'backup']),
    leader: new Set(['members.read', 'attendance.write', 'reports.read']),
    secretary: new Set(['members.read', 'members.write', 'members.deactivate', 'activities.write',
      'notes.write', 'tasks.write', 'reports.read']),
  };
  const can = (user, perm) => PERMS[user.role].has(perm);

  /* ----- members ----- */
  const memberRow = (m) => m && ({ id: m.id, full_name: m.full_name, phone: m.phone || '', email: m.email || '', status: m.status,
    date_joined: m.date_joined, is_demo: !!m.is_demo });
  function validateMember(b) {
    const out = { full_name: req_(b, 'full_name', 'Full name', 120), phone: opt(b, 'phone', 'Phone', 30), email: opt(b, 'email', 'Email', 120) };
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw bad('Email address looks wrong.', { email: 'Enter a valid email address.' });
    if (out.phone && !/^[0-9+()\-\s]{6,30}$/.test(out.phone)) throw bad('Phone number looks wrong.', { phone: 'Use digits, spaces, + or - only.' });
    out.date_joined = str(b.date_joined) || today();
    if (!isDate(out.date_joined)) throw bad('Date joined must be a valid date.', { date_joined: 'Use a valid date.' });
    return out;
  }
  function memberStats(id) {
    const rows = q(`SELECT a.status, COUNT(*) n FROM attendance a JOIN activities ac ON ac.id=a.activity_id
                    WHERE a.member_id=? AND ac.status='planned' GROUP BY a.status`).all(id);
    const c = { present: 0, absent: 0, late: 0, excused: 0 };
    rows.forEach((r) => { c[r.status] = r.n; });
    const counted = c.present + c.late + c.absent;
    return { ...c, recorded: counted + c.excused, attendance_rate: counted ? Math.round(((c.present + c.late) / counted) * 100) : null };
  }

  /* ----- activities ----- */
  const actRow = (a) => a && ({ id: a.id, title: a.title, type: a.type, starts_at: a.starts_at, location: a.location,
    description: a.description, organizer_member_id: a.organizer_member_id, organizer_name: a.organizer_name || null,
    status: a.status, cancel_reason: a.cancel_reason || '', is_demo: !!a.is_demo,
    phase: a.status === 'cancelled' ? 'cancelled' : (a.starts_at <= now() ? 'held' : 'upcoming') });
  const ACT_SELECT = `SELECT a.*, m.full_name AS organizer_name FROM activities a LEFT JOIN members m ON m.id=a.organizer_member_id`;
  function validateActivity(b) {
    const out = {
      title: req_(b, 'title', 'Title', 150), type: req_(b, 'type', 'Activity type', 40),
      starts_at: req_(b, 'starts_at', 'Date and time', 16), location: req_(b, 'location', 'Location', 150),
      description: opt(b, 'description', 'Agenda / description', 4000),
    };
    if (!ACTIVITY_TYPES.includes(out.type)) throw bad('Choose an activity type from the list.', { type: 'Choose from the list.' });
    if (!isDateTime(out.starts_at)) throw bad('Date and time must be valid.', { starts_at: 'Use a valid date and time.' });
    const org = b.organizer_member_id;
    if (org === null || org === undefined || org === '') throw bad('Responsible organizer is required.', { organizer_member_id: 'Responsible organizer is required.' });
    const m = q("SELECT id FROM members WHERE id=? AND status='active'").get(Number(org));
    if (!m) throw bad('Organizer must be an active member.', { organizer_member_id: 'Choose an active member.' });
    out.organizer_member_id = m.id;
    return out;
  }
  const getActivity = (id) => {
    const a = q(`${ACT_SELECT} WHERE a.id=?`).get(Number(id));
    if (!a) throw new HttpError(404, 'Activity not found.');
    return a;
  };

  /* ----- tasks ----- */
  const taskRow = (t) => ({ id: t.id, activity_id: t.activity_id, activity_title: t.activity_title, title: t.title,
    responsible_member_id: t.responsible_member_id, responsible_name: t.responsible_name || null, due_date: t.due_date,
    status: t.status === 'done' ? 'done' : (t.due_date < today() ? 'overdue' : 'open'), completed_at: t.completed_at });
  const TASK_SELECT = `SELECT t.*, m.full_name AS responsible_name, a.title AS activity_title FROM tasks t
    LEFT JOIN members m ON m.id=t.responsible_member_id JOIN activities a ON a.id=t.activity_id`;
  function validateTask(b) {
    const out = { title: req_(b, 'title', 'Task', 200), due_date: req_(b, 'due_date', 'Due date', 10) };
    if (!isDate(out.due_date)) throw bad('Due date must be a valid date.', { due_date: 'Use a valid date.' });
    const r = b.responsible_member_id;
    if (r === null || r === undefined || r === '') throw bad('Choose who is responsible.', { responsible_member_id: 'Choose who is responsible.' });
    const m = q("SELECT id FROM members WHERE id=? AND status!='removed'").get(Number(r));
    if (!m) throw bad('Responsible person must be a member.', { responsible_member_id: 'Choose a member.' });
    out.responsible_member_id = m.id;
    return out;
  }

  /* ----- reports ----- */
  function buildReport(from, to) {
    if (!isDate(from) || !isDate(to)) throw bad('Choose a valid start and end date.');
    if (from > to) throw bad('The start date must be on or before the end date.');
    const nowS = now();
    const acts = q(`${ACT_SELECT} WHERE substr(a.starts_at,1,10) BETWEEN ? AND ? ORDER BY a.starts_at`).all(from, to).map(actRow);
    const held = acts.filter((a) => a.phase === 'held');
    const totals = { present: 0, absent: 0, late: 0, excused: 0 };
    const perActivity = held.map((a) => {
      const c = { present: 0, absent: 0, late: 0, excused: 0 };
      q('SELECT status, COUNT(*) n FROM attendance WHERE activity_id=? GROUP BY status').all(a.id).forEach((r) => { c[r.status] = r.n; totals[r.status] += r.n; });
      return { ...a, counts: c, recorded: c.present + c.absent + c.late + c.excused };
    });
    const heldIds = held.map((a) => a.id);
    const participation = q(`SELECT m.id, m.full_name, m.status FROM members m WHERE m.status!='removed' ORDER BY m.full_name`).all().map((m) => {
      const c = { present: 0, absent: 0, late: 0, excused: 0 };
      if (heldIds.length) {
        q(`SELECT status, COUNT(*) n FROM attendance WHERE member_id=? AND activity_id IN (${heldIds.map(() => '?').join(',')}) GROUP BY status`)
          .all(m.id, ...heldIds).forEach((r) => { c[r.status] = r.n; });
      }
      const counted = c.present + c.late + c.absent;
      return { id: m.id, full_name: m.full_name, member_status: m.status, ...c, attendance_rate: counted ? Math.round(((c.present + c.late) / counted) * 100) : null };
    }).filter((p) => p.present + p.absent + p.late + p.excused > 0);
    const outstanding = q(`${TASK_SELECT} WHERE t.status='open' AND a.status!='cancelled' ORDER BY t.due_date`).all().map(taskRow);
    return {
      from, to, generated_at: nowS,
      activities_total: acts.length, activities_held: held.length,
      activities_cancelled: acts.filter((a) => a.phase === 'cancelled').length,
      activities_upcoming: acts.filter((a) => a.phase === 'upcoming').length,
      attendance_totals: totals, per_activity: perActivity, participation, outstanding_tasks: outstanding,
    };
  }
  const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  function reportCsv(r) {
    const rows = [['Report period', r.from, r.to], ['Activities held', r.activities_held], [], ['ACTIVITIES HELD'],
      ['Date and time', 'Title', 'Type', 'Present', 'Late', 'Absent', 'Excused']];
    r.per_activity.forEach((a) => rows.push([a.starts_at.replace('T', ' '), a.title, a.type, a.counts.present, a.counts.late, a.counts.absent, a.counts.excused]));
    rows.push([], ['MEMBER PARTICIPATION'], ['Member', 'Present', 'Late', 'Absent', 'Excused', 'Attendance %']);
    r.participation.forEach((p) => rows.push([p.full_name, p.present, p.late, p.absent, p.excused, p.attendance_rate ?? '']));
    rows.push([], ['OUTSTANDING TASKS'], ['Task', 'Activity', 'Responsible', 'Due', 'Status']);
    r.outstanding_tasks.forEach((t) => rows.push([t.title, t.activity_title, t.responsible_name, t.due_date, t.status]));
    return toCsv(rows);
  }

  /* ---------- routes ---------- */
  const routes = [];
  const route = (method, pattern, perm, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), perm, handler });

  // --- auth ---
  route('POST', '/api/login', 'public', (c) => {
    const username = str(c.body.username), password = typeof c.body.password === 'string' ? c.body.password : '';
    const ip = clientIp(c.req), lname = username.toLowerCase();
    // Lock-out is derived from the audit log, so it works across servers: 5 failures in 15 minutes since the last good sign-in.
    const cutoff = new Date(Date.now() - 15 * 60e3).toISOString();
    const lastOk = q("SELECT MAX(at) a FROM audit WHERE action='login' AND username=? COLLATE NOCASE").get(username)?.a || '';
    const fails = q("SELECT COUNT(*) n FROM audit WHERE action='login_failed' AND at>? AND at>? AND json_extract(detail,'$.username')=? AND json_extract(detail,'$.ip')=?").get(cutoff, lastOk, lname, ip).n;
    if (fails >= 5) throw new HttpError(429, 'Too many failed attempts. Please wait 15 minutes and try again.');
    const u = q('SELECT * FROM users WHERE username=?').get(username);
    const ok = u && u.active && verifyPassword(password, u.password_hash);
    if (!u) crypto.scryptSync(password, 'x'.repeat(16), 64); // equalise timing
    if (!ok) { audit(null, 'login_failed', 'user', u?.id, { username: lname, ip }); throw new HttpError(401, 'Username or password is not correct.'); }
    const { token, csrf } = makeToken(u);
    audit(u, 'login', 'user', u.id);
    c.setCookie = cookie(c.req, token, SESSION_HOURS * 3600);
    return { csrf, user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role, must_change: !!u.must_change } };
  });
  route('POST', '/api/logout', 'auth', (c) => {
    audit(c.user, 'logout', 'user', c.user.id);
    c.setCookie = cookie(c.req, '', 0);
    return { ok: true };
  });
  route('GET', '/api/me', 'auth', (c) => ({ user: c.user, csrf: c.session.csrf,
    config: { timezone: TZ, activity_types: ACTIVITY_TYPES, attendance_statuses: ATT_STATUSES, now: now(), min_password: MIN_PASSWORD,
      permissions: [...PERMS[c.user.role]] } }));
  route('POST', '/api/password', 'auth', (c) => {
    const cur = typeof c.body.current_password === 'string' ? c.body.current_password : '';
    const next = typeof c.body.new_password === 'string' ? c.body.new_password : '';
    const u = q('SELECT * FROM users WHERE id=?').get(c.user.id);
    if (!verifyPassword(cur, u.password_hash)) throw bad('Current password is not correct.', { current_password: 'Not correct.' });
    if (next.length < MIN_PASSWORD) throw bad(`New password must be at least ${MIN_PASSWORD} characters.`, { new_password: `At least ${MIN_PASSWORD} characters.` });
    if (next === cur) throw bad('Choose a different password from the current one.', { new_password: 'Must be different.' });
    q('UPDATE users SET password_hash=?, must_change=0 WHERE id=?').run(hashPassword(next), c.user.id);
    audit(c.user, 'password_changed', 'user', c.user.id);
    // every other signed-in device is signed out (their token no longer matches); this one gets a fresh token
    c.setCookie = cookie(c.req, makeToken(q('SELECT * FROM users WHERE id=?').get(c.user.id), c.session.csrf).token, SESSION_HOURS * 3600);
    return { ok: true };
  });

  // --- users (admin) ---
  const userRow = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: !!u.active, must_change: !!u.must_change });
  route('GET', '/api/users', 'users.manage', () => ({ users: q('SELECT * FROM users ORDER BY username').all().map(userRow) }));
  route('POST', '/api/users', 'users.manage', (c) => {
    const username = req_(c.body, 'username', 'Username', 40), display = req_(c.body, 'display_name', 'Display name', 80);
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw bad('Username: 3-40 letters, numbers, dot, dash or underscore.', { username: 'Invalid username.' });
    if (!ROLES.includes(c.body.role)) throw bad('Choose a role.', { role: 'Choose a role.' });
    const pw = typeof c.body.password === 'string' ? c.body.password : '';
    if (pw.length < MIN_PASSWORD) throw bad(`Temporary password must be at least ${MIN_PASSWORD} characters.`, { password: `At least ${MIN_PASSWORD} characters.` });
    if (q('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpError(409, 'That username is already taken.', { username: 'Already taken.' });
    const r = q('INSERT INTO users (username,display_name,role,password_hash,must_change) VALUES (?,?,?,?,1)').run(username, display, c.body.role, hashPassword(pw));
    audit(c.user, 'user_created', 'user', Number(r.lastInsertRowid), { username, role: c.body.role });
    return { user: userRow(q('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)) };
  });
  route('PATCH', '/api/users/:id', 'users.manage', (c) => {
    const u = q('SELECT * FROM users WHERE id=?').get(Number(c.params.id));
    if (!u) throw new HttpError(404, 'User not found.');
    const ch = {};
    if (c.body.role !== undefined) { if (!ROLES.includes(c.body.role)) throw bad('Invalid role.'); ch.role = c.body.role; }
    if (c.body.active !== undefined) ch.active = c.body.active ? 1 : 0;
    if (c.body.display_name !== undefined) ch.display_name = req_(c.body, 'display_name', 'Display name', 80);
    if (u.id === c.user.id && ((ch.role && ch.role !== 'admin') || ch.active === 0)) throw bad('You cannot remove your own administrator access or deactivate yourself.');
    const admins = q("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n;
    if (u.role === 'admin' && u.active && admins <= 1 && ((ch.role && ch.role !== 'admin') || ch.active === 0)) throw bad('There must always be at least one active administrator.');
    if (c.body.new_password !== undefined) {
      if (typeof c.body.new_password !== 'string' || c.body.new_password.length < MIN_PASSWORD) throw bad(`Password must be at least ${MIN_PASSWORD} characters.`, { new_password: `At least ${MIN_PASSWORD} characters.` });
      q('UPDATE users SET password_hash=?, must_change=1 WHERE id=?').run(hashPassword(c.body.new_password), u.id);
      audit(c.user, 'password_reset', 'user', u.id);
    }
    const keys = Object.keys(ch);
    if (keys.length) {
      q(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => ch[k]), u.id);
      audit(c.user, 'user_updated', 'user', u.id, { from: { role: u.role, active: !!u.active, display_name: u.display_name }, to: ch });
    }
    return { user: userRow(q('SELECT * FROM users WHERE id=?').get(u.id)) };
  });

  // --- members ---
  route('GET', '/api/members', 'members.read', (c) => {
    const status = c.query.get('status'), s = str(c.query.get('q') || '');
    let sql = "SELECT * FROM members WHERE status!='removed'"; const args = [];
    if (['active', 'inactive'].includes(status)) { sql += ' AND status=?'; args.push(status); }
    if (s) { sql += ' AND full_name LIKE ?'; args.push(`%${s.replace(/[%_]/g, '')}%`); }
    return { members: q(sql + ' ORDER BY full_name').all(...args).map(memberRow) };
  });
  route('POST', '/api/members', 'members.write', (c) => {
    const m = validateMember(c.body);
    const r = q('INSERT INTO members (full_name,phone,email,date_joined) VALUES (?,?,?,?)').run(m.full_name, m.phone || null, m.email || null, m.date_joined);
    audit(c.user, 'member_created', 'member', Number(r.lastInsertRowid), { full_name: m.full_name });
    return { member: memberRow(q('SELECT * FROM members WHERE id=?').get(r.lastInsertRowid)) };
  });
  const getMember = (id) => { const m = q("SELECT * FROM members WHERE id=? AND status!='removed'").get(Number(id)); if (!m) throw new HttpError(404, 'Member not found.'); return m; };
  route('GET', '/api/members/:id', 'members.read', (c) => {
    const m = getMember(c.params.id);
    const history = q(`SELECT ac.id activity_id, ac.title, ac.starts_at, a.status FROM attendance a JOIN activities ac ON ac.id=a.activity_id
      WHERE a.member_id=? AND ac.status='planned' ORDER BY ac.starts_at DESC LIMIT 50`).all(m.id);
    return { member: memberRow(m), stats: memberStats(m.id), history };
  });
  route('PATCH', '/api/members/:id', 'members.write', (c) => {
    const old = getMember(c.params.id);
    const merged = validateMember({ full_name: old.full_name, phone: old.phone, email: old.email, date_joined: old.date_joined, ...c.body });
    let status = old.status;
    if (c.body.status !== undefined) {
      if (!['active', 'inactive'].includes(c.body.status)) throw bad('Status must be active or inactive.');
      if (!can(c.user, 'members.deactivate')) throw new HttpError(403, 'You do not have permission to change membership status.');
      status = c.body.status;
    }
    q('UPDATE members SET full_name=?,phone=?,email=?,date_joined=?,status=?,updated_at=datetime(\'now\') WHERE id=?')
      .run(merged.full_name, merged.phone || null, merged.email || null, merged.date_joined, status, old.id);
    const diff = {};
    for (const k of ['full_name', 'phone', 'email', 'date_joined']) if ((old[k] || '') !== (merged[k] || '')) diff[k] = [old[k] || '', merged[k] || ''];
    if (status !== old.status) diff.status = [old.status, status];
    if (Object.keys(diff).length) audit(c.user, status !== old.status && Object.keys(diff).length === 1 ? (status === 'inactive' ? 'member_deactivated' : 'member_reactivated') : 'member_updated', 'member', old.id, diff);
    return { member: memberRow(q('SELECT * FROM members WHERE id=?').get(old.id)) };
  });
  // Removal of personal data: anonymises the person but keeps anonymous attendance counts so reports stay accurate.
  route('POST', '/api/members/:id/remove', 'members.remove', (c) => {
    const m = getMember(c.params.id);
    if (c.body.confirm !== true) throw bad('Please confirm removal.');
    tx(() => {
      q("UPDATE members SET full_name=?, phone=NULL, email=NULL, status='removed', updated_at=datetime('now') WHERE id=?").run(`Removed member #${m.id}`, m.id);
      q('UPDATE tasks SET responsible_member_id=NULL WHERE responsible_member_id=?').run(m.id);
      q('UPDATE activities SET organizer_member_id=NULL WHERE organizer_member_id=?').run(m.id);
      audit(c.user, 'member_personal_data_removed', 'member', m.id, { reason: str(c.body.reason).slice(0, 300) });
    });
    return { ok: true };
  });

  // --- activities ---
  route('GET', '/api/activities', 'members.read', (c) => {
    const from = c.query.get('from'), to = c.query.get('to'), phase = c.query.get('phase');
    let sql = `${ACT_SELECT} WHERE 1=1`; const args = [];
    if (from && isDate(from)) { sql += ' AND substr(a.starts_at,1,10)>=?'; args.push(from); }
    if (to && isDate(to)) { sql += ' AND substr(a.starts_at,1,10)<=?'; args.push(to); }
    let list = q(sql + ' ORDER BY a.starts_at DESC').all(...args).map(actRow);
    if (['upcoming', 'held', 'cancelled'].includes(phase)) list = list.filter((a) => a.phase === phase);
    const cnt = q("SELECT activity_id, COUNT(*) n, SUM(status IN ('present','late')) came FROM attendance GROUP BY activity_id").all();
    const byId = Object.fromEntries(cnt.map((r) => [r.activity_id, r]));
    return { activities: list.map((a) => ({ ...a, attendance_recorded: byId[a.id]?.n || 0, attended: byId[a.id]?.came || 0 })) };
  });
  route('POST', '/api/activities', 'activities.write', (c) => {
    const a = validateActivity(c.body);
    const r = q('INSERT INTO activities (title,type,starts_at,location,description,organizer_member_id,created_by) VALUES (?,?,?,?,?,?,?)')
      .run(a.title, a.type, a.starts_at, a.location, a.description, a.organizer_member_id, c.user.id);
    audit(c.user, 'activity_created', 'activity', Number(r.lastInsertRowid), { title: a.title, starts_at: a.starts_at });
    return { activity: actRow(getActivity(r.lastInsertRowid)) };
  });
  route('GET', '/api/activities/:id', 'members.read', (c) => {
    const a = getActivity(c.params.id);
    const notes = q('SELECT notes,decisions,outcomes,updated_at FROM notes WHERE activity_id=?').get(a.id) || { notes: '', decisions: '', outcomes: '', updated_at: null };
    const tasks = q(`${TASK_SELECT} WHERE t.activity_id=? ORDER BY t.due_date`).all(a.id).map(taskRow);
    return { activity: actRow(a), notes, tasks };
  });
  route('PATCH', '/api/activities/:id', 'activities.write', (c) => {
    const old = getActivity(c.params.id);
    if (old.status === 'cancelled') throw bad('A cancelled activity cannot be edited.');
    const a = validateActivity({ ...old, ...c.body });
    q("UPDATE activities SET title=?,type=?,starts_at=?,location=?,description=?,organizer_member_id=?,updated_at=datetime('now') WHERE id=?")
      .run(a.title, a.type, a.starts_at, a.location, a.description, a.organizer_member_id, old.id);
    const diff = {};
    for (const k of Object.keys(a)) if (String(old[k] ?? '') !== String(a[k] ?? '')) diff[k] = [old[k], a[k]];
    if (Object.keys(diff).length) audit(c.user, 'activity_updated', 'activity', old.id, diff);
    return { activity: actRow(getActivity(old.id)) };
  });
  route('POST', '/api/activities/:id/cancel', 'activities.write', (c) => {
    const a = getActivity(c.params.id);
    if (a.status === 'cancelled') throw bad('This activity is already cancelled.');
    const reason = opt(c.body, 'reason', 'Reason', 300);
    q("UPDATE activities SET status='cancelled', cancel_reason=?, updated_at=datetime('now') WHERE id=?").run(reason || null, a.id);
    audit(c.user, 'activity_cancelled', 'activity', a.id, { title: a.title, reason });
    return { activity: actRow(getActivity(a.id)) };
  });
  route('DELETE', '/api/activities/:id', 'activities.delete', (c) => {
    const a = getActivity(c.params.id);
    q('DELETE FROM activities WHERE id=?').run(a.id);
    audit(c.user, 'activity_deleted', 'activity', a.id, { title: a.title, starts_at: a.starts_at });
    return { ok: true };
  });

  // --- attendance ---
  route('GET', '/api/activities/:id/attendance', 'members.read', (c) => {
    const a = getActivity(c.params.id);
    const recs = Object.fromEntries(q('SELECT member_id,status,updated_at FROM attendance WHERE activity_id=?').all(a.id).map((r) => [r.member_id, r]));
    const members = q("SELECT id,full_name,status FROM members WHERE status!='removed' ORDER BY full_name").all()
      .filter((m) => m.status === 'active' || recs[m.id])
      .map((m) => ({ member_id: m.id, full_name: m.full_name, member_status: m.status, status: recs[m.id]?.status || null }));
    const counts = { present: 0, absent: 0, late: 0, excused: 0 };
    members.forEach((m) => { if (m.status) counts[m.status]++; });
    return { activity: actRow(a), records: members, counts };
  });
  route('PUT', '/api/activities/:id/attendance', 'attendance.write', (c) => {
    const a = getActivity(c.params.id);
    if (a.status === 'cancelled') throw bad('Attendance cannot be recorded for a cancelled activity.');
    if (!Array.isArray(c.body.records) || c.body.records.length > 2000) throw bad('No attendance records were sent.');
    const changes = [];
    tx(() => {
      for (const r of c.body.records) {
        const mid = Number(r.member_id);
        if (!ATT_STATUSES.includes(r.status)) throw bad('Each attendance status must be present, absent, late or excused.');
        const m = q("SELECT id,full_name,status FROM members WHERE id=? AND status!='removed'").get(mid);
        if (!m) throw bad('One of the members could not be found.');
        const old = q('SELECT status FROM attendance WHERE activity_id=? AND member_id=?').get(a.id, mid);
        if (old && old.status === r.status) continue;
        if (!old && m.status !== 'active') throw bad(`${m.full_name} is not an active member.`);
        q(`INSERT INTO attendance (activity_id,member_id,status,updated_by,updated_at) VALUES (?,?,?,?,datetime('now'))
           ON CONFLICT(activity_id,member_id) DO UPDATE SET status=excluded.status, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
          .run(a.id, mid, r.status, c.user.id);
        changes.push({ member_id: mid, name: m.full_name, from: old ? old.status : null, to: r.status });
      }
      if (changes.length) {
        const isCorrection = changes.some((x) => x.from !== null);
        audit(c.user, isCorrection ? 'attendance_corrected' : 'attendance_recorded', 'activity', a.id, { title: a.title, changes });
      }
    });
    return { ok: true, changed: changes.length };
  });

  // --- notes ---
  route('PUT', '/api/activities/:id/notes', 'notes.write', (c) => {
    const a = getActivity(c.params.id);
    const n = { notes: opt(c.body, 'notes', 'Notes', 10000), decisions: opt(c.body, 'decisions', 'Decisions', 10000), outcomes: opt(c.body, 'outcomes', 'Outcomes', 10000) };
    q(`INSERT INTO notes (activity_id,notes,decisions,outcomes,updated_by,updated_at) VALUES (?,?,?,?,?,datetime('now'))
       ON CONFLICT(activity_id) DO UPDATE SET notes=excluded.notes, decisions=excluded.decisions, outcomes=excluded.outcomes, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(a.id, n.notes, n.decisions, n.outcomes, c.user.id);
    audit(c.user, 'notes_saved', 'activity', a.id, { title: a.title });
    return { ok: true };
  });

  // --- tasks ---
  route('GET', '/api/tasks', 'members.read', (c) => {
    let list = q(`${TASK_SELECT} WHERE a.status!='cancelled' ORDER BY t.due_date`).all().map(taskRow);
    const st = c.query.get('status');
    if (['open', 'overdue', 'done'].includes(st)) list = list.filter((t) => t.status === st);
    return { tasks: list };
  });
  route('POST', '/api/activities/:id/tasks', 'tasks.write', (c) => {
    const a = getActivity(c.params.id);
    const t = validateTask(c.body);
    const r = q('INSERT INTO tasks (activity_id,title,responsible_member_id,due_date,created_by) VALUES (?,?,?,?,?)').run(a.id, t.title, t.responsible_member_id, t.due_date, c.user.id);
    audit(c.user, 'task_created', 'task', Number(r.lastInsertRowid), { activity: a.title, title: t.title });
    return { task: taskRow(q(`${TASK_SELECT} WHERE t.id=?`).get(r.lastInsertRowid)) };
  });
  const getTask = (id) => { const t = q('SELECT * FROM tasks WHERE id=?').get(Number(id)); if (!t) throw new HttpError(404, 'Task not found.'); return t; };
  route('PATCH', '/api/tasks/:id', 'tasks.write', (c) => {
    const old = getTask(c.params.id);
    let t = { title: old.title, due_date: old.due_date, responsible_member_id: old.responsible_member_id };
    if (c.body.title !== undefined || c.body.due_date !== undefined || c.body.responsible_member_id !== undefined) t = validateTask({ ...t, ...c.body });
    let status = old.status;
    if (c.body.status !== undefined) { if (!['open', 'done'].includes(c.body.status)) throw bad('Status must be open or done.'); status = c.body.status; }
    q("UPDATE tasks SET title=?,due_date=?,responsible_member_id=?,status=?,completed_at=?,updated_at=datetime('now') WHERE id=?")
      .run(t.title, t.due_date, t.responsible_member_id, status, status === 'done' ? (old.completed_at || today()) : null, old.id);
    audit(c.user, status !== old.status ? (status === 'done' ? 'task_completed' : 'task_reopened') : 'task_updated', 'task', old.id, { title: t.title });
    return { task: taskRow(q(`${TASK_SELECT} WHERE t.id=?`).get(old.id)) };
  });
  route('DELETE', '/api/tasks/:id', 'tasks.write', (c) => {
    const t = getTask(c.params.id);
    q('DELETE FROM tasks WHERE id=?').run(t.id);
    audit(c.user, 'task_deleted', 'task', t.id, { title: t.title });
    return { ok: true };
  });

  // --- dashboard & reports ---
  route('GET', '/api/dashboard', 'members.read', () => {
    const n = now();
    const all = q(`${ACT_SELECT} WHERE a.status='planned'`).all().map(actRow);
    const upcoming = all.filter((a) => a.starts_at > n).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 5);
    const recentRaw = all.filter((a) => a.starts_at <= n).sort((a, b) => b.starts_at.localeCompare(a.starts_at)).slice(0, 5);
    const recent = recentRaw.map((a) => {
      const c = q("SELECT COUNT(*) n, SUM(status IN ('present','late')) came FROM attendance WHERE activity_id=?").get(a.id);
      return { ...a, attendance_recorded: c.n, attended: c.came || 0 };
    });
    const tasks = q(`${TASK_SELECT} WHERE t.status='open' AND a.status!='cancelled' ORDER BY t.due_date`).all().map(taskRow);
    const activeMembers = q("SELECT COUNT(*) n FROM members WHERE status='active'").get().n;
    const rate = (() => {
      const r = q(`SELECT SUM(a.status IN ('present','late')) came, SUM(a.status IN ('present','late','absent')) counted FROM attendance a
        JOIN activities ac ON ac.id=a.activity_id WHERE ac.status='planned' AND ac.id IN (SELECT id FROM activities WHERE status='planned' AND starts_at<=? ORDER BY starts_at DESC LIMIT 5)`).get(n);
      return r.counted ? Math.round((r.came / r.counted) * 100) : null;
    })();
    return { upcoming, recent, open_tasks: tasks, overdue_count: tasks.filter((t) => t.status === 'overdue').length, active_members: activeMembers, recent_attendance_rate: rate,
      needs_attendance: recentRaw.filter((a, i) => !recent[i].attendance_recorded).map((a) => ({ id: a.id, title: a.title, starts_at: a.starts_at })) };
  });
  route('GET', '/api/reports', 'reports.read', (c) => {
    const r = buildReport(str(c.query.get('from') || ''), str(c.query.get('to') || ''));
    if (c.query.get('format') === 'csv') {
      audit(c.user, 'report_exported', 'report', null, { from: r.from, to: r.to });
      return { _raw: reportCsv(r), _type: 'text/csv; charset=utf-8', _filename: `club-report-${r.from}-to-${r.to}.csv` };
    }
    return r;
  });

  // --- admin ---
  route('GET', '/api/audit', 'audit.read', (c) => {
    const limit = Math.min(Math.max(parseInt(c.query.get('limit') || '100', 10) || 100, 1), 500);
    const rows = q('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    return { audit: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) };
  });
  route('GET', '/api/backup', 'backup', (c) => {
    const tmp = path.join(require('node:os').tmpdir(), `acyc-backup-${crypto.randomBytes(6).toString('hex')}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
    audit(c.user, 'backup_downloaded', 'system', null);
    return { _raw: buf, _type: 'application/octet-stream', _filename: `club-backup-${today()}.db` };
  });

  /* ---------- HTTP layer ---------- */
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  const SEC_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  };
  function send(res, status, body, headers = {}) { res.writeHead(status, { ...SEC_HEADERS, ...headers }); res.end(body); }
  const sendJson = (res, status, obj, headers) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (d) => { size += d.length; if (size > 200_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(d); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
        catch { reject(bad('Invalid request.')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const rt = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).find((x) => x.m && x.r.method === req.method);
        if (!rt) {
          if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'Method not allowed.');
          throw new HttpError(404, 'Not found.');
        }
        if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) var body = await readBody(req);
        // Run the handler against a fresh copy of the data. If someone else saved to the sheet in the
        // meantime (a "conflict") we simply reload and run the request again.
        for (let attempt = 0; ; attempt++) {
          const c = { req, res, query: url.searchParams, params: rt.m.groups || {}, body: body || {}, setCookie: null };
          const h = await store.open();
          db = h.db; // handler below runs synchronously, so no other request can swap this
          let out, failure = null;
          try {
            if (rt.r.perm !== 'public') {
              const s = getSession(req);
              if (!s) throw new HttpError(401, 'Please sign in.');
              c.session = s; c.user = s.user;
              if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== s.csrf) throw new HttpError(403, 'Your session check failed. Please reload the page.');
              if (s.user.must_change && !['/api/password', '/api/logout', '/api/me'].includes(url.pathname)) throw new HttpError(403, 'You must change your temporary password first.');
              if (rt.r.perm !== 'auth' && !can(s.user, rt.r.perm)) throw new HttpError(403, 'You do not have permission to do that.');
            }
            out = rt.r.handler(c);
          } catch (e) { if (!(e instanceof HttpError)) { h.release(); throw e; } failure = e; }
          try { await store.commit(h); } // saves anything the handler changed (e.g. the audit entry of a failed sign-in)
          catch (e) { h.release(); if (e.conflict && attempt < 3) continue; throw e; }
          h.release();
          if (failure) throw failure;
          const extra = c.setCookie ? { 'Set-Cookie': c.setCookie } : {};
          if (out && out._raw !== undefined) {
            return send(res, 200, out._raw, { 'Content-Type': out._type, 'Content-Disposition': `attachment; filename="${out._filename}"`, ...extra });
          }
          return sendJson(res, 200, out, extra);
        }
      }
      // static files
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const full = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Not found.');
      return send(res, 200, fs.readFileSync(full), { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, fields: e.fields });
      console.error(e);
      const msg = store.kind === 'sheets' && /Google|Sheet/.test(e.message) ? 'The club records (Google Sheets) could not be reached just now. Nothing was lost; please try again in a minute.' : 'Something went wrong on the server. Nothing was lost; please try again.';
      return sendJson(res, 500, { error: msg });
    }
  });

  // Run something against the data outside an HTTP request (first-run setup, scripts).
  async function withDb(fn) { const h = await store.open(); db = h.db; try { return await fn(h.db); } finally { await store.commit(h); h.release(); } }
  return { server, store, withDb, hashPassword, get db() { return store.db; }, close: () => { try { server.close(); } catch {} store.close(); } };
}

module.exports = { createApp, hashPassword, clubNow };

if (require.main === module) {
  (async () => {
    const app = createApp();
    const n = await app.withDb((d) => d.prepare('SELECT COUNT(*) n FROM users').get().n);
    if (n === 0) {
      const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
      await app.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash,must_change) VALUES ('admin','Administrator','admin',?,1)").run(app.hashPassword(pw)));
      console.log(`First run: created administrator "admin" with temporary password: ${pw}\n(You will be asked to change it at first sign-in.)`);
    }
    const port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1';
    app.server.listen(port, host, () => console.log(`Club system running at http://${host}:${port}  (timezone ${TZ}, storage: ${app.store.kind})`));
  })().catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}
