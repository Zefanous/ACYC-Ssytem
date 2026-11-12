'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/club');
const { seed } = require('../scripts/seed');

let app, base, NOW = '2026-11-10T14:00';
function client() {
  const c = { cookie: '', csrf: '' };
  c.req = async (method, path, body, opts = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (c.cookie) headers.Cookie = c.cookie;
    if (c.csrf && !opts.noCsrf) headers['X-CSRF-Token'] = c.csrf;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  };
  c.login = async (u, p) => { const r = await c.req('POST', '/api/login', { username: u, password: p }); if (r.status === 200) c.csrf = r.data.csrf; return r; };
  return c;
}

before(async () => {
  app = createApp({ dbPath: ':memory:', now: () => NOW });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  // seed uses real clock; use fixed data instead for determinism
  const { hashPassword, db } = app;
  db.prepare("INSERT INTO users (username,display_name,role,password_hash) VALUES ('boss','Boss','admin',?)").run(hashPassword('AdminPass-12345'));
  db.prepare("INSERT INTO users (username,display_name,role,password_hash) VALUES ('lead','Lead','leader',?)").run(hashPassword('LeaderPass-12345'));
});
after(() => app.close());

describe('authentication & access control', () => {
  test('unauthenticated requests are rejected', async () => {
    const c = client();
    for (const p of ['/api/me', '/api/members', '/api/activities', '/api/dashboard', '/api/audit', '/api/users', '/api/backup']) {
      assert.equal((await c.req('GET', p)).status, 401, p);
    }
  });
  test('bad credentials give a generic error; good ones sign in with HttpOnly SameSite cookie', async () => {
    const c = client();
    const bad1 = await c.login('boss', 'wrong'); const bad2 = await c.login('nobody', 'wrong');
    assert.equal(bad1.status, 401); assert.equal(bad1.data.error, bad2.data.error);
    const ok = await c.login('boss', 'AdminPass-12345');
    assert.equal(ok.status, 200);
    const sc = ok.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
    assert.equal(JSON.stringify(ok.data).includes('password'), false);
  });
  test('lockout after 5 failed attempts', async () => {
    const c = client();
    for (let i = 0; i < 5; i++) await c.login('lead', 'nope');
    assert.equal((await c.login('lead', 'LeaderPass-12345')).status, 429);
  });
  test('CSRF token required for changes', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    assert.equal((await c.req('POST', '/api/members', { full_name: 'X' }, { noCsrf: true })).status, 403);
  });
  test('security headers present', async () => {
    const r = await fetch(base + '/');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });
  test('static path traversal blocked', async () => {
    const r = await fetch(base + '/..%2f..%2fsrc%2fserver.js'); assert.equal(r.status, 404);
    const r2 = await fetch(base + '/%2e%2e/package.json'); assert.equal(r2.status, 404);
  });
});

describe('roles', () => {
  let admin, leader;
  before(async () => {
    app.db.prepare("INSERT OR IGNORE INTO users (username,display_name,role,password_hash) VALUES ('lead2','Lead Two','leader',?)").run(app.hashPassword('LeaderPass-12345'));
    admin = client(); await admin.login('boss', 'AdminPass-12345');
    leader = client(); assert.equal((await leader.login('lead2', 'LeaderPass-12345')).status, 200);
  });
  test('leader blocked from users, audit, backup, member removal, activity delete', async () => {
    assert.equal((await leader.req('GET', '/api/users')).status, 403);
    assert.equal((await leader.req('GET', '/api/audit')).status, 403);
    assert.equal((await leader.req('GET', '/api/backup')).status, 403);
    assert.equal((await leader.req('POST', '/api/users', { username: 'zz', display_name: 'Z', role: 'admin', password: 'x'.repeat(12) })).status, 403);
    assert.equal((await leader.req('POST', '/api/members/1/remove', { confirm: true })).status, 403);
    assert.equal((await leader.req('DELETE', '/api/activities/1')).status, 403);
  });
  test('admin can create users; new user must change temp password', async () => {
    const r = await admin.req('POST', '/api/users', { username: 'new.leader', display_name: 'New Leader', role: 'leader', password: 'Temporary-1234' });
    assert.equal(r.status, 200);
    const n = client(); await n.login('new.leader', 'Temporary-1234');
    assert.equal((await n.req('GET', '/api/members')).status, 403);
    assert.equal((await n.req('POST', '/api/password', { current_password: 'Temporary-1234', new_password: 'short' })).status, 400);
    assert.equal((await n.req('POST', '/api/password', { current_password: 'Temporary-1234', new_password: 'BrandNew-Pass-99' })).status, 200);
    assert.equal((await n.req('GET', '/api/members')).status, 200);
  });
  test('cannot demote/deactivate the last admin or yourself', async () => {
    const users = (await admin.req('GET', '/api/users')).data.users;
    const boss = users.find((u) => u.username === 'boss');
    assert.equal((await admin.req('PATCH', `/api/users/${boss.id}`, { role: 'leader' })).status, 400);
    assert.equal((await admin.req('PATCH', `/api/users/${boss.id}`, { active: false })).status, 400);
  });
  test('deactivated user is signed out and cannot sign in', async () => {
    const u = (await admin.req('GET', '/api/users')).data.users.find((x) => x.username === 'lead2');
    assert.equal((await admin.req('PATCH', `/api/users/${u.id}`, { active: false })).status, 200);
    assert.equal((await leader.req('GET', '/api/members')).status, 401);
    assert.equal((await client().login('lead2', 'LeaderPass-12345')).status, 401);
    await admin.req('PATCH', `/api/users/${u.id}`, { active: true });
  });
});

describe('members', () => {
  let c;
  before(async () => { c = client(); await c.login('boss', 'AdminPass-12345'); });
  test('validation: name required, bad email/phone/date', async () => {
    assert.equal((await c.req('POST', '/api/members', { full_name: '' })).status, 400);
    assert.equal((await c.req('POST', '/api/members', { full_name: 'A', email: 'nope' })).status, 400);
    assert.equal((await c.req('POST', '/api/members', { full_name: 'A', phone: 'abc' })).status, 400);
    assert.equal((await c.req('POST', '/api/members', { full_name: 'A', date_joined: '2026-02-31' })).status, 400);
  });
  test('create, view, update, deactivate; no sensitive fields stored', async () => {
    const r = await c.req('POST', '/api/members', { full_name: 'Test Person', phone: '0700 111 222', date_joined: '2026-01-05', hiv_status: 'x', health: 'y' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data.member).sort(), ['date_joined', 'email', 'full_name', 'id', 'is_demo', 'phone', 'status']);
    const id = r.data.member.id;
    const cols = app.db.prepare('PRAGMA table_info(members)').all().map((x) => x.name);
    assert.ok(!cols.some((n) => /hiv|health|status_med|diagnos/i.test(n)));
    const u = await c.req('PATCH', `/api/members/${id}`, { phone: '0700 999 888' });
    assert.equal(u.data.member.phone, '0700 999 888');
    const d = await c.req('PATCH', `/api/members/${id}`, { status: 'inactive' });
    assert.equal(d.data.member.status, 'inactive');
    const a = (await c.req('GET', '/api/audit')).data.audit.filter((x) => x.entity === 'member' && x.entity_id === id).map((x) => x.action);
    assert.deepEqual(a.reverse(), ['member_created', 'member_updated', 'member_deactivated']);
  });
  test('removal anonymises personal data but keeps anonymous attendance', async () => {
    const m = (await c.req('POST', '/api/members', { full_name: 'Remove Me', phone: '0700 123 456', email: 'rm@example.org' })).data.member;
    const org = (await c.req('POST', '/api/members', { full_name: 'Org Person' })).data.member;
    const act = (await c.req('POST', '/api/activities', { title: 'Past', type: 'Meeting', starts_at: '2026-11-01T10:00', location: 'Room', organizer_member_id: org.id })).data.activity;
    await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: m.id, status: 'present' }] });
    assert.equal((await c.req('POST', `/api/members/${m.id}/remove`, {})).status, 400); // needs confirm
    assert.equal((await c.req('POST', `/api/members/${m.id}/remove`, { confirm: true, reason: 'Requested by member' })).status, 200);
    const row = app.db.prepare('SELECT * FROM members WHERE id=?').get(m.id);
    assert.equal(row.phone, null); assert.equal(row.email, null); assert.match(row.full_name, /^Removed member/);
    assert.equal((await c.req('GET', `/api/members/${m.id}`)).status, 404);
    assert.ok(!(await c.req('GET', '/api/members')).data.members.some((x) => x.id === m.id));
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM attendance WHERE member_id=?').get(m.id).n, 1);
  });
});

describe('activities, attendance, notes, tasks, reports', () => {
  let c, mem = [], act;
  before(async () => {
    c = client(); await c.login('boss', 'AdminPass-12345');
    for (const n of ['Alpha Rep', 'Bravo Rep', 'Charlie Rep', 'Delta Rep']) mem.push((await c.req('POST', '/api/members', { full_name: n })).data.member);
  });
  const mk = (o = {}) => c.req('POST', '/api/activities', { title: 'Meeting', type: 'Meeting', starts_at: '2026-11-03T15:00', location: 'Club room', description: 'Agenda', organizer_member_id: mem[0].id, ...o });
  test('activity validation', async () => {
    assert.equal((await mk({ title: '' })).status, 400);
    assert.equal((await mk({ type: 'Party' })).status, 400);
    assert.equal((await mk({ starts_at: '2026-13-01T10:00' })).status, 400);
    assert.equal((await mk({ starts_at: '2026-11-03T25:00' })).status, 400);
    assert.equal((await mk({ organizer_member_id: 99999 })).status, 400);
    assert.equal((await mk({ organizer_member_id: '' })).status, 400);
  });
  test('create, phase derived from time, update, cancel', async () => {
    const past = await mk(); act = past.data.activity; assert.equal(act.phase, 'held');
    const fut = (await mk({ title: 'Future', starts_at: '2026-11-20T10:00' })).data.activity; assert.equal(fut.phase, 'upcoming');
    const u = await c.req('PATCH', `/api/activities/${fut.id}`, { location: 'Hall' }); assert.equal(u.data.activity.location, 'Hall');
    const x = await c.req('POST', `/api/activities/${fut.id}/cancel`, { reason: 'Rain' }); assert.equal(x.data.activity.phase, 'cancelled');
    assert.equal((await c.req('PATCH', `/api/activities/${fut.id}`, { location: 'Z' })).status, 400);
    assert.equal((await c.req('PUT', `/api/activities/${fut.id}/attendance`, { records: [{ member_id: mem[0].id, status: 'present' }] })).status, 400);
  });
  test('attendance: statuses validated, saved, corrected, audited with before/after', async () => {
    assert.equal((await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: mem[0].id, status: 'maybe' }] })).status, 400);
    const r = await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [
      { member_id: mem[0].id, status: 'present' }, { member_id: mem[1].id, status: 'late' }, { member_id: mem[2].id, status: 'absent' }, { member_id: mem[3].id, status: 'excused' }] });
    assert.equal(r.data.changed, 4);
    const g = (await c.req('GET', `/api/activities/${act.id}/attendance`)).data;
    assert.deepEqual(g.counts, { present: 1, absent: 1, late: 1, excused: 1 });
    // resubmitting identical data changes nothing and adds no audit noise
    assert.equal((await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: mem[2].id, status: 'absent' }] })).data.changed, 0);
    // correction
    assert.equal((await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: mem[2].id, status: 'present' }] })).data.changed, 1);
    const log = (await c.req('GET', '/api/audit')).data.audit.find((x) => x.action === 'attendance_corrected');
    assert.deepEqual(log.detail.changes[0], { member_id: mem[2].id, name: 'Charlie Rep', from: 'absent', to: 'present' });
    assert.equal(log.username, 'boss');
  });
  test('inactive members cannot be newly marked but keep existing records', async () => {
    await c.req('PATCH', `/api/members/${mem[3].id}`, { status: 'inactive' });
    const g = (await c.req('GET', `/api/activities/${act.id}/attendance`)).data;
    assert.ok(g.records.find((r) => r.member_id === mem[3].id)); // still shown, has record
    const other = (await mk({ title: 'Other', starts_at: '2026-11-05T10:00' })).data.activity;
    const r = await c.req('PUT', `/api/activities/${other.id}/attendance`, { records: [{ member_id: mem[3].id, status: 'present' }] });
    assert.equal(r.status, 400);
    await c.req('PATCH', `/api/members/${mem[3].id}`, { status: 'active' });
  });
  test('member attendance summary', async () => {
    const s = (await c.req('GET', `/api/members/${mem[2].id}`)).data.stats;
    assert.equal(s.present, 1); assert.equal(s.attendance_rate, 100);
    const s1 = (await c.req('GET', `/api/members/${mem[1].id}`)).data.stats;
    assert.equal(s1.late, 1);
  });
  test('notes save and load; task lifecycle with overdue computed', async () => {
    assert.equal((await c.req('PUT', `/api/activities/${act.id}/notes`, { notes: 'N', decisions: 'D', outcomes: 'O' })).status, 200);
    const t1 = (await c.req('POST', `/api/activities/${act.id}/tasks`, { title: 'Late task', responsible_member_id: mem[0].id, due_date: '2026-11-05' })).data.task;
    const t2 = (await c.req('POST', `/api/activities/${act.id}/tasks`, { title: 'Soon task', responsible_member_id: mem[1].id, due_date: '2026-11-15' })).data.task;
    const t3 = (await c.req('POST', `/api/activities/${act.id}/tasks`, { title: 'Done task', responsible_member_id: mem[1].id, due_date: '2026-11-01' })).data.task;
    assert.equal(t1.status, 'overdue'); assert.equal(t2.status, 'open');
    assert.equal((await c.req('PATCH', `/api/tasks/${t3.id}`, { status: 'done' })).data.task.status, 'done');
    assert.equal((await c.req('POST', `/api/activities/${act.id}/tasks`, { title: 'x', due_date: '2026-11-15' })).status, 400); // no responsible
    assert.equal((await c.req('POST', `/api/activities/${act.id}/tasks`, { title: 'x', responsible_member_id: mem[0].id, due_date: 'soon' })).status, 400);
    const d = (await c.req('GET', `/api/activities/${act.id}`)).data;
    assert.equal(d.notes.decisions, 'D');
    assert.deepEqual(d.tasks.map((t) => t.status).sort(), ['done', 'open', 'overdue']);
    const dash = (await c.req('GET', '/api/dashboard')).data;
    assert.ok(dash.overdue_count >= 1);
    assert.ok(dash.open_tasks.every((t) => t.status !== 'done'));
    assert.equal((await c.req('GET', '/api/tasks?status=overdue')).data.tasks.every((t) => t.status === 'overdue'), true);
  });
  test('dashboard flags held activities lacking attendance', async () => {
    await mk({ title: 'No attendance yet', starts_at: '2026-11-09T09:00' });
    const dash = (await c.req('GET', '/api/dashboard')).data;
    assert.ok(dash.needs_attendance.some((a) => a.title === 'No attendance yet'));
    assert.ok(dash.upcoming.every((a) => a.starts_at > NOW));
  });
  test('report for date range: totals, participation, outstanding tasks; CSV export', async () => {
    const r = (await c.req('GET', '/api/reports?from=2026-11-01&to=2026-11-04')).data;
    const mine = r.per_activity.find((a) => a.id === act.id);
    assert.deepEqual(mine.counts, { present: 2, late: 1, absent: 0, excused: 1 });
    assert.ok(r.attendance_totals.present >= 2);
    assert.ok(r.participation.find((p) => p.full_name === 'Bravo Rep').late === 1);
    assert.ok(r.outstanding_tasks.some((t) => t.title === 'Late task'));
    assert.equal((await c.req('GET', '/api/reports?from=2026-11-05&to=2026-11-01')).status, 400);
    assert.equal((await c.req('GET', '/api/reports?from=bad&to=2026-11-01')).status, 400);
    const csv = await c.req('GET', '/api/reports?from=2026-11-01&to=2026-11-04&format=csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.data, /Alpha Rep/);
  });
  test('CSV neutralises formula injection', async () => {
    const m = (await c.req('POST', '/api/members', { full_name: '=HYPERLINK("http://evil")' })).data.member;
    await c.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: m.id, status: 'present' }] });
    const csv = (await c.req('GET', '/api/reports?from=2026-11-01&to=2026-11-04&format=csv')).data;
    assert.ok(!/(^|,)=HYPERLINK/m.test(csv)); assert.match(csv, /'=HYPERLINK/);
  });
  test('only admin can delete an activity; cascades; audited', async () => {
    const a = (await mk({ title: 'To delete' })).data.activity;
    assert.equal((await c.req('DELETE', `/api/activities/${a.id}`)).status, 200);
    assert.equal((await c.req('GET', `/api/activities/${a.id}`)).status, 404);
    assert.ok((await c.req('GET', '/api/audit')).data.audit.some((x) => x.action === 'activity_deleted'));
  });
  test('backup downloads a valid database', async () => {
    const r = await fetch(base + '/api/backup', { headers: { Cookie: c.cookie } });
    assert.equal(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  });
  test('XSS payloads are stored verbatim as data (escaped at render) and API returns JSON only', async () => {
    const m = (await c.req('POST', '/api/members', { full_name: '<img src=x onerror=alert(1)>' })).data.member;
    const r = await c.req('GET', '/api/members');
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.ok(r.data.members.some((x) => x.id === m.id));
  });
  test('malformed JSON and oversize bodies are handled', async () => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(r.status, 400);
    const s = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(300000) }) }).catch(() => ({ status: 413 }));
    assert.equal(s.status, 413);
  });
  test('SQL injection strings in search are inert', async () => {
    const r = await c.req('GET', "/api/members?q=' OR 1=1 --");
    assert.equal(r.status, 200); assert.equal(r.data.members.length, 0);
  });
});

describe('demo seed data', () => {
  test('seed produces only flagged example records and no real data', async () => {
    const a2 = createApp({ dbPath: ':memory:' });
    seed(a2);
    const members = a2.db.prepare('SELECT * FROM members').all();
    assert.ok(members.length >= 10 && members.every((m) => m.is_demo === 1 && m.email === null));
    assert.ok(a2.db.prepare('SELECT * FROM activities').all().every((x) => x.is_demo === 1 && /Example/.test(x.title)));
    a2.close();
  });
});

describe('role separation: leader records attendance, secretary does the rest', () => {
  let admin, sec, cl, member, act;
  before(async () => {
    const mk = (u, role) => app.db.prepare("INSERT OR IGNORE INTO users (username,display_name,role,password_hash) VALUES (?,?,?,?)").run(u, u, role, app.hashPassword('RolePass-12345'));
    mk('sec1', 'secretary'); mk('cl1', 'leader');
    admin = client(); await admin.login('boss', 'AdminPass-12345');
    sec = client(); assert.equal((await sec.login('sec1', 'RolePass-12345')).status, 200);
    cl = client(); assert.equal((await cl.login('cl1', 'RolePass-12345')).status, 200);
  });
  test('secretary: members, activities, notes, tasks, reports allowed', async () => {
    member = (await sec.req('POST', '/api/members', { full_name: 'Role Test Member' })).data.member; assert.ok(member.id);
    act = (await sec.req('POST', '/api/activities', { title: 'Role test', type: 'Meeting', starts_at: '2026-11-02T10:00', location: 'Room', organizer_member_id: member.id })).data.activity; assert.ok(act.id);
    assert.equal((await sec.req('PUT', `/api/activities/${act.id}/notes`, { notes: 'n' })).status, 200);
    assert.equal((await sec.req('POST', `/api/activities/${act.id}/tasks`, { title: 'T', responsible_member_id: member.id, due_date: '2026-11-20' })).status, 200);
    assert.equal((await sec.req('GET', '/api/reports?from=2026-11-01&to=2026-11-30')).status, 200);
    assert.equal((await sec.req('PATCH', `/api/members/${member.id}`, { phone: '0700 000 000' })).status, 200);
  });
  test('secretary cannot record attendance, nor admin functions', async () => {
    assert.equal((await sec.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: member.id, status: 'present' }] })).status, 403);
    for (const p of ['/api/users', '/api/audit', '/api/backup']) assert.equal((await sec.req('GET', p)).status, 403, p);
    assert.equal((await sec.req('DELETE', `/api/activities/${act.id}`)).status, 403);
  });
  test('leader records and corrects attendance, can view and run reports', async () => {
    assert.equal((await cl.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: member.id, status: 'present' }] })).status, 200);
    assert.equal((await cl.req('PUT', `/api/activities/${act.id}/attendance`, { records: [{ member_id: member.id, status: 'late' }] })).status, 200);
    for (const p of ['/api/members', '/api/activities', `/api/activities/${act.id}`, '/api/tasks', '/api/dashboard', '/api/reports?from=2026-11-01&to=2026-11-30']) assert.equal((await cl.req('GET', p)).status, 200, p);
    const log = (await admin.req('GET', '/api/audit')).data.audit.find((x) => x.action === 'attendance_corrected' && x.username === 'cl1');
    assert.ok(log);
  });
  test('leader cannot change anything else', async () => {
    assert.equal((await cl.req('POST', '/api/members', { full_name: 'X' })).status, 403);
    assert.equal((await cl.req('PATCH', `/api/members/${member.id}`, { status: 'inactive' })).status, 403);
    assert.equal((await cl.req('POST', '/api/activities', { title: 'x', type: 'Meeting', starts_at: '2026-11-02T10:00', location: 'R', organizer_member_id: member.id })).status, 403);
    assert.equal((await cl.req('PUT', `/api/activities/${act.id}/notes`, { notes: 'x' })).status, 403);
    assert.equal((await cl.req('POST', `/api/activities/${act.id}/tasks`, { title: 'T', responsible_member_id: member.id, due_date: '2026-11-20' })).status, 403);
    assert.equal((await cl.req('GET', '/api/users')).status, 403);
  });
  test('admin can create secretary accounts; unknown roles are rejected', async () => {
    assert.equal((await admin.req('POST', '/api/users', { username: 'sec.new', display_name: 'Sec New', role: 'secretary', password: 'Temporary-1234' })).status, 200);
    assert.equal((await admin.req('POST', '/api/users', { username: 'bad.role', display_name: 'B', role: 'treasurer', password: 'Temporary-1234' })).status, 400);
  });
  test('installable app files are served with correct types', async () => {
    const m = await fetch(base + '/manifest.webmanifest'); assert.equal(m.status, 200); const j = await m.json(); assert.equal(j.display, 'standalone'); assert.ok(j.icons.length >= 3);
    const sw = await fetch(base + '/sw.js'); assert.match(sw.headers.get('content-type'), /javascript/); assert.match(await sw.text(), /startsWith\('\/api\/'\)/);
    for (const i of j.icons) { const r = await fetch(base + i.src); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); }
  });
});
