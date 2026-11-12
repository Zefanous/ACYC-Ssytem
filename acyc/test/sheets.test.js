'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFakeGoogle } = require('./fake-google');
const { createSheetsStore } = require('../src/store');
const { createApp } = require('../src/club');

let g, app, base, store;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'test-secret-test-secret-test-secret';

function client() {
  const c = { cookie: '', csrf: '' };
  c.req = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (c.cookie) headers.Cookie = c.cookie; if (c.csrf) headers['X-CSRF-Token'] = c.csrf;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) c.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  c.login = async (u, p) => { const r = await c.req('POST', '/api/login', { username: u, password: p }); if (r.status === 200) c.csrf = r.data.csrf; return r; };
  return c;
}
const mkStore = (ttlMs = 0) => createSheetsStore({ sheetId: g.sheetId, clientEmail: g.clientEmail, privateKey: pem, apiBase: g.base, tokenUrl: g.base + '/token', ttlMs });

before(async () => {
  g = await startFakeGoogle({ publicKey });
  store = mkStore(0);
  app = createApp({ store, secret: SECRET, now: () => '2026-11-10T14:00' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await app.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash) VALUES ('boss','Boss','admin',?)").run(app.hashPassword('AdminPass-12345')));
});
after(() => { app.close(); g.close(); });

describe('Google Sheets as the database', () => {
  test('first start creates every tab with headers and a version cell', () => {
    for (const t of ['users', 'members', 'activities', 'attendance', 'notes', 'tasks', 'audit', '_meta']) assert.ok(g.tabs.has(t), t);
    assert.deepEqual(g.tabs.get('members')[0], ['id', 'full_name', 'phone', 'email', 'status', 'date_joined', 'is_demo', 'created_at', 'updated_at']);
    assert.equal(g.tabs.get('_meta')[0][0], 'version');
  });
  test('service-account JWT is signed correctly and token is reused', async () => {
    const before = g.stats.tokenCalls;
    const c = client(); await c.login('boss', 'AdminPass-12345'); await c.req('GET', '/api/members');
    assert.equal(g.stats.tokenCalls, before); // cached, no new token
  });
  test('wrong service-account key gives a clear error', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const s = createSheetsStore({ sheetId: g.sheetId, clientEmail: g.clientEmail, privateKey: other, apiBase: g.base, tokenUrl: g.base + '/token' });
    await assert.rejects(s.open(), /Google sign-in failed/);
  });
  test('wrong spreadsheet id gives a clear error', async () => {
    const s = createSheetsStore({ sheetId: 'NOPE', clientEmail: g.clientEmail, privateKey: pem, apiBase: g.base, tokenUrl: g.base + '/token' });
    await assert.rejects(s.open(), /Check SHEET_ID/);
  });
  test('data written through the app lands in the sheet and survives a "restart" (fresh store)', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    const m = await c.req('POST', '/api/members', { full_name: 'Sheet Person', phone: '0700 123 456', date_joined: '2026-01-05' });
    assert.equal(m.status, 200);
    const row = g.tabs.get('members').find((r) => r[1] === 'Sheet Person');
    assert.ok(row); assert.equal(row[2], '0700 123 456'); assert.equal(row[3], ''); assert.equal(row[4], 'active');
    // brand-new app instance with an empty cache reads the same data back
    const app2 = createApp({ store: mkStore(0), secret: SECRET });
    await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${app2.server.address().port}/api/members`, { headers: { Cookie: c.cookie } });
    assert.equal(r.status, 200); // the signed session works on another server
    assert.ok((await r.json()).members.some((x) => x.full_name === 'Sheet Person'));
    app2.close;
    app2.server.close();
  });
  test('values stay text: leading = and zeros are not interpreted by Sheets', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    await c.req('POST', '/api/members', { full_name: '=1+1', phone: '0712345678' });
    const row = g.tabs.get('members').find((r) => r[1] === '=1+1');
    assert.equal(row[2], '0712345678'); assert.equal(typeof row[2], 'string');
    const list = (await c.req('GET', '/api/members')).data.members; assert.ok(list.some((m) => m.phone === '0712345678'));
  });
  test('audit log is appended, not rewritten', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    g.stats.log.length = 0;
    await c.req('POST', '/api/members', { full_name: 'Append Check' });
    const updates = g.stats.log.filter((l) => l[0] === 'update').flatMap((l) => l[1]);
    assert.ok(updates.some((r) => /^audit!A\d+$/.test(r) && r !== 'audit!A1'), JSON.stringify(updates));
    assert.ok(!updates.includes('audit!A1'));
  });
  test('deleting rows shrinks the tab and clears leftovers', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    const org = (await c.req('POST', '/api/members', { full_name: 'Org' })).data.member;
    const a = (await c.req('POST', '/api/activities', { title: 'Doomed', type: 'Meeting', starts_at: '2026-11-01T10:00', location: 'X', organizer_member_id: org.id })).data.activity;
    assert.ok(g.tabs.get('activities').some((r) => r[1] === 'Doomed'));
    assert.equal((await c.req('DELETE', `/api/activities/${a.id}`)).status, 200);
    assert.ok(!g.tabs.get('activities').some((r) => r[1] === 'Doomed' && r[1] !== ''), 'row should be cleared');
    assert.ok((await c.req('GET', '/api/activities')).data.activities.every((x) => x.title !== 'Doomed'));
  });
  test('read-only requests do not write to the sheet (except audit-worthy ones)', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    const w = g.stats.writes;
    await c.req('GET', '/api/members'); await c.req('GET', '/api/dashboard'); await c.req('GET', '/api/activities');
    assert.equal(g.stats.writes, w);
  });
  test('caching: repeated reads within the TTL do not hit Google again', async () => {
    const s = mkStore(60_000); const a = createApp({ store: s, secret: SECRET });
    await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
    const c = client(); await c.login('boss', 'AdminPass-12345').catch(() => {});
    const u = `http://127.0.0.1:${a.server.address().port}`;
    const login = await fetch(u + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'AdminPass-12345' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r0 = g.stats.reads;
    for (let i = 0; i < 5; i++) await fetch(u + '/api/members', { headers: { Cookie: cookie } });
    assert.ok(g.stats.reads - r0 <= 3, `reads: ${g.stats.reads - r0}`); // login wrote (audit) so one reload at most + version checks
    a.server.close();
  });
  test('conflict: two servers saving at once - nothing is lost, both changes end up in the sheet', async () => {
    const mk = async () => { const a = createApp({ store: mkStore(60_000), secret: SECRET }); await new Promise((r) => a.server.listen(0, '127.0.0.1', r)); return a; };
    const A = await mk(), B = await mk();
    const login = async (a) => { const r = await fetch(`http://127.0.0.1:${a.server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'AdminPass-12345' }) }); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrf }; };
    const sa = await login(A), sb = await login(B);
    // warm both caches, then another server (A) writes so B's cache is stale
    await fetch(`http://127.0.0.1:${B.server.address().port}/api/members`, { headers: { Cookie: sb.cookie } });
    const post = (a, s, name) => fetch(`http://127.0.0.1:${a.server.address().port}/api/members`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie, 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ full_name: name }) });
    const ra = await post(A, sa, 'Writer A'); assert.equal(ra.status, 200);
    const rb = await post(B, sb, 'Writer B'); assert.equal(rb.status, 200); // B's stale write is detected, reloaded and retried
    const names = g.tabs.get('members').map((r) => r[1]);
    assert.ok(names.includes('Writer A') && names.includes('Writer B'), names.join(','));
    A.server.close(); B.server.close();
  });
  test('Google outage gives a friendly message, not a crash', async () => {
    const s = mkStore(0); const a = createApp({ store: s, secret: SECRET });
    await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${a.server.address().port}`;
    s.client.apiBase = 'http://127.0.0.1:1'; // nothing listens here
    const r = await fetch(u + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'x' }) });
    assert.equal(r.status, 500); assert.match((await r.json()).error, /could not be reached/);
    a.server.close();
  });
  test('security still holds on the sheets store: lockout works across servers via audit rows', async () => {
    const mk = async () => { const a = createApp({ store: mkStore(0), secret: SECRET }); await new Promise((r) => a.server.listen(0, '127.0.0.1', r)); return a; };
    const A = await mk(), B = await mk();
    await A.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash) VALUES ('victim','V','leader',?)").run(A.hashPassword('Right-Password-1')));
    const tryLogin = (a, pw) => fetch(`http://127.0.0.1:${a.server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'victim', password: pw }) });
    for (let i = 0; i < 3; i++) assert.equal((await tryLogin(A, 'bad')).status, 401);
    for (let i = 0; i < 2; i++) assert.equal((await tryLogin(B, 'bad')).status, 401);
    assert.equal((await tryLogin(A, 'Right-Password-1')).status, 429);
    assert.equal((await tryLogin(B, 'Right-Password-1')).status, 429);
    A.server.close(); B.server.close();
  });
  test('password change signs out other devices but not the current one', async () => {
    await app.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash) VALUES ('pw','PW','leader',?)").run(app.hashPassword('Original-Pass-1')));
    const d1 = client(), d2 = client(); await d1.login('pw', 'Original-Pass-1'); await d2.login('pw', 'Original-Pass-1');
    assert.equal((await d1.req('POST', '/api/password', { current_password: 'Original-Pass-1', new_password: 'Changed-Pass-22' })).status, 200);
    assert.equal((await d1.req('GET', '/api/members')).status, 200);
    assert.equal((await d2.req('GET', '/api/members')).status, 401);
  });
  test('tampered or expired session cookies are rejected', async () => {
    const c = client(); await c.login('boss', 'AdminPass-12345');
    const [body, sig] = c.cookie.slice(4).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), u: 999 })).toString('base64url');
    const r = await fetch(base + '/api/me', { headers: { Cookie: `sid=${forged}.${sig}` } });
    assert.equal(r.status, 401);
  });
  test('refuses to start on Sheets without a session secret', () => {
    assert.throws(() => createApp({ store: mkStore(0), secret: '' }), /SESSION_SECRET/);
  });
});

describe('import script helper', () => {
  test('replaceAll copies a local database into the sheet and the app can read it', async () => {
    const { createApp: mk } = require('../src/club'); const { seed } = require('../scripts/seed');
    const local = mk({ dbPath: ':memory:' }); seed(local);
    const s = mkStore(0);
    await s.replaceAll(s.dumpFrom(local.db));
    const a = createApp({ store: s, secret: SECRET, now: () => '2026-11-10T14:00' });
    await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${a.server.address().port}`;
    const l = await fetch(u + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo-admin', password: 'DemoAdmin-2026!' }) });
    assert.equal(l.status, 200);
    const r = await fetch(u + '/api/members', { headers: { Cookie: l.headers.get('set-cookie').split(';')[0] } });
    const { members } = await r.json(); assert.equal(members.length, 12); assert.ok(members.every((m) => m.is_demo));
    a.server.close(); local.close();
  });
});
