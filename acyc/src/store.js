'use strict';
/*
 * Storage back-ends. The app logic always runs against an SQLite engine (a real file, or an
 * in-memory copy rebuilt from Google Sheets). A store only decides where the data lives:
 *
 *   sqlite store  - one persistent SQLite file (local development, tests, simple servers)
 *   sheets store  - Google Sheets is the database. Each request works on an in-memory copy of the
 *                   tabs; if anything changed, only the changed tabs are written back.
 */
const crypto = require('node:crypto');
const { openDb, TABLES } = require('./db');

/* ---------- sqlite file store ---------- */
function createSqliteStore(dbPath) {
  const fs = require('node:fs'), path = require('node:path');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  return {
    kind: 'sqlite', db,
    async open() { return { db, release() {} }; },
    async commit() {},
    close() { db.close(); },
  };
}

/* ---------- Google Sheets client (service account, no dependencies) ---------- */
const b64u = (b) => Buffer.from(b).toString('base64url');
class SheetsClient {
  constructor({ sheetId, clientEmail, privateKey, fetchImpl = fetch, apiBase = 'https://sheets.googleapis.com', tokenUrl = 'https://oauth2.googleapis.com/token' }) {
    if (!sheetId || !clientEmail || !privateKey) throw new Error('Google Sheets storage needs SHEET_ID and service-account credentials.');
    Object.assign(this, { sheetId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n'), fetchImpl, apiBase, tokenUrl });
    this.token = null; this.tokenExp = 0;
  }
  async accessToken() {
    if (this.token && Date.now() < this.tokenExp - 60e3) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64u(JSON.stringify({ iss: this.clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: this.tokenUrl, iat: now, exp: now + 3600 }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claim}`), this.privateKey).toString('base64url');
    const r = await this.fetchImpl(this.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google sign-in failed (${r.status}): ${j.error_description || j.error || 'check the service account key'}`);
    this.token = j.access_token; this.tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }
  async call(method, path, body, attempt = 0) {
    const t = await this.accessToken();
    let r;
    try { r = await this.fetchImpl(`${this.apiBase}/v4/spreadsheets/${this.sheetId}${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
    catch (e) { if (attempt < 2) return this.call(method, path, body, attempt + 1); throw new Error('Cannot reach Google Sheets: ' + e.message); }
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt)); return this.call(method, path, body, attempt + 1); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = r.status === 403 ? ' Share the spreadsheet with the service account email as Editor.' : r.status === 404 ? ' Check SHEET_ID.' : '';
      throw new Error(`Google Sheets error ${r.status}: ${j.error?.message || 'unknown'}.${hint}`);
    }
    return j;
  }
  titles() { return this.call('GET', '?fields=sheets.properties.title').then((j) => (j.sheets || []).map((s) => s.properties.title)); }
  addTabs(names) { return this.call('POST', ':batchUpdate', { requests: names.map((title) => ({ addSheet: { properties: { title } } })) }); }
  async getAll(tabs) {
    const q = tabs.map((t) => `ranges=${encodeURIComponent(t)}`).join('&');
    const j = await this.call('GET', `/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`);
    return Object.fromEntries(tabs.map((t, i) => [t, j.valueRanges?.[i]?.values || []]));
  }
  async getCell(a1) { const j = await this.call('GET', `/values/${encodeURIComponent(a1)}?valueRenderOption=UNFORMATTED_VALUE`); return j.values?.[0]?.[0]; }
  update(data) { return this.call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data }); }
  clear(ranges) { return this.call('POST', '/values:batchClear', { ranges }); }
}

/* ---------- Google Sheets store ---------- */
const META = '_meta';
const colLetter = (n) => String.fromCharCode(64 + n); // 1 -> A (we never exceed 26 columns)

function createSheetsStore(opts) {
  const client = opts.client || new SheetsClient(opts);
  const ttlMs = opts.ttlMs ?? 10_000;
  const proto = openDb(':memory:'); // used only to read column definitions
  const spec = {};
  for (const t of TABLES) spec[t] = proto.prepare(`PRAGMA table_info(${t})`).all().map((c) => ({ name: c.name, text: /TEXT/i.test(c.type), notnull: !!c.notnull }));
  proto.close();
  let ready = null, cache = null;

  const ensure = () => ready || (ready = (async () => {
    const have = new Set(await client.titles());
    const missing = [...TABLES, META].filter((t) => !have.has(t));
    if (missing.length) await client.addTabs(missing);
    const data = await client.getAll([...TABLES, META]);
    const upd = [];
    for (const t of TABLES) if (!data[t].length) upd.push({ range: `${t}!A1`, values: [spec[t].map((c) => c.name)] });
    if (!data[META].length) upd.push({ range: `${META}!A1`, values: [['version', 0], ['note', 'Do not edit this tab. It stops two people saving at once from overwriting each other.']] });
    if (upd.length) await client.update(upd);
  })().catch((e) => { ready = null; throw e; }));

  function parse(tab, grid) {
    const [head = [], ...rows] = grid;
    const idx = Object.fromEntries(head.map((h, i) => [String(h), i]));
    return rows.filter((r) => r.some((v) => v !== '' && v !== undefined && v !== null)).map((r) => spec[tab].map((c) => {
      let v = idx[c.name] === undefined ? undefined : r[idx[c.name]];
      if (v === undefined || v === '') return c.notnull && c.text ? '' : null;
      return c.text ? String(v) : Number(v);
    }));
  }
  async function load() {
    await ensure();
    const raw = await client.getAll([...TABLES, META]);
    const tables = Object.fromEntries(TABLES.map((t) => [t, parse(t, raw[t])]));
    const version = Number(raw[META]?.[0]?.[1]) || 0;
    cache = { version, tables, at: Date.now() };
    return cache;
  }
  function hydrate(data) {
    const db = openDb(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    for (const t of TABLES) {
      const cols = spec[t].map((c) => c.name);
      const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of data.tables[t]) ins.run(...row);
    }
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }
  function dump(db) {
    return Object.fromEntries(TABLES.map((t) => {
      const cols = spec[t].map((c) => c.name);
      return [t, db.prepare(`SELECT ${cols.join(',')} FROM ${t} ORDER BY rowid`).all().map((r) => cols.map((c) => r[c]))];
    }));
  }
  const cell = (v) => (v === null || v === undefined ? '' : v);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return {
    kind: 'sheets', client,
    async open() {
      const data = cache && Date.now() - cache.at < ttlMs ? cache : await load();
      const db = hydrate(data);
      return { db, base: data, release() { try { db.close(); } catch {} } };
    },
    async commit(h) {
      const next = dump(h.db);
      const changed = TABLES.filter((t) => !same(next[t], h.base.tables[t]));
      if (!changed.length) return;
      const live = Number(await client.getCell(`${META}!B1`)) || 0;
      if (live !== h.base.version) { cache = null; const e = new Error('Sheet changed while saving'); e.conflict = true; throw e; }
      const data = [];
      const trailing = [];
      for (const t of changed) {
        const old = h.base.tables[t], now = next[t], n = spec[t].length;
        const appendOnly = now.length >= old.length && old.every((r, i) => same(r, now[i]));
        if (appendOnly) data.push({ range: `${t}!A${old.length + 2}`, values: now.slice(old.length).map((r) => r.map(cell)) });
        else {
          data.push({ range: `${t}!A1`, values: [spec[t].map((c) => c.name), ...now.map((r) => r.map(cell))] });
          if (now.length < old.length) trailing.push(`${t}!A${now.length + 2}:${colLetter(n)}${old.length + 1}`);
        }
      }
      data.push({ range: `${META}!B1`, values: [[h.base.version + 1]] }); // last: marks the save as complete
      await client.update(data);
      if (trailing.length) await client.clear(trailing);
      cache = { version: h.base.version + 1, tables: next, at: Date.now() };
    },
    invalidate() { cache = null; },
    close() {},
    // used by the import script
    async replaceAll(tables) {
      await ensure();
      const raw = await client.getAll([...TABLES, META]);
      const version = Number(raw[META]?.[0]?.[1]) || 0;
      const data = TABLES.map((t) => ({ range: `${t}!A1`, values: [spec[t].map((c) => c.name), ...tables[t].map((r) => r.map(cell))] }));
      data.push({ range: `${META}!B1`, values: [[version + 1]] });
      await client.update(data);
      const clr = TABLES.map((t) => `${t}!A${tables[t].length + 2}:${colLetter(spec[t].length)}${Math.max(raw[t].length + 1, tables[t].length + 2)}`);
      await client.clear(clr); cache = null;
    },
    dumpFrom: dump,
  };
}

function storeFromEnv(env = process.env) {
  if ((env.STORAGE || 'sqlite') === 'sheets') {
    let email = env.GOOGLE_CLIENT_EMAIL, key = env.GOOGLE_PRIVATE_KEY;
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON) { const j = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); email = j.client_email; key = j.private_key; }
    return createSheetsStore({ sheetId: env.SHEET_ID, clientEmail: email, privateKey: key });
  }
  const path = require('node:path');
  return createSqliteStore(env.DB_PATH || path.join(__dirname, '..', 'data', 'club.db'));
}

module.exports = { createSqliteStore, createSheetsStore, SheetsClient, storeFromEnv };
