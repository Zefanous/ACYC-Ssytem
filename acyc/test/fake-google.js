'use strict';
// A small stand-in for Google's OAuth + Sheets v4 endpoints used by src/store.js, so the Sheets
// storage can be tested offline. It mimics the documented behaviour of the calls the app makes.
const http = require('node:http');
const crypto = require('node:crypto');

function startFakeGoogle({ sheetId = 'SHEET123', clientEmail = 'svc@proj.iam.gserviceaccount.com', publicKey } = {}) {
  const tabs = new Map(); // title -> array of rows (arrays)
  const stats = { tokenCalls: 0, reads: 0, writes: 0, log: [] };
  const colNum = (L) => [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  function parseA1(a1) { // "tab!A5", "tab!A5:H9", "tab"
    const [tab, rng] = a1.split('!');
    if (!rng) return { tab, r0: 0, c0: 0, r1: Infinity, c1: Infinity };
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(rng);
    return { tab, c0: colNum(m[1]) - 1, r0: +m[2] - 1, c1: m[3] ? colNum(m[3]) - 1 : Infinity, r1: m[4] ? +m[4] - 1 : Infinity };
  }
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/token') {
        stats.tokenCalls++;
        const p = new URLSearchParams(body); const [h, c, sig] = (p.get('assertion') || '').split('.');
        const ok = publicKey && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig || '', 'base64url'));
        const claim = ok ? JSON.parse(Buffer.from(c, 'base64url')) : {};
        if (!ok || claim.iss !== clientEmail || !/spreadsheets/.test(claim.scope)) return send(400, { error: 'invalid_grant', error_description: 'bad assertion' });
        return send(200, { access_token: 'tok-' + stats.tokenCalls, expires_in: 3600 });
      }
      if (!/^Bearer tok-\d+$/.test(req.headers.authorization || '')) return send(401, { error: { message: 'bad token' } });
      const base = `/v4/spreadsheets/${sheetId}`;
      if (!url.pathname.startsWith(base)) return send(404, { error: { message: 'Requested entity was not found.' } });
      const rest = decodeURIComponent(url.pathname.slice(base.length));
      const json = body ? JSON.parse(body) : {};
      if (req.method === 'GET' && rest === '') return send(200, { sheets: [...tabs.keys()].map((title) => ({ properties: { title } })) });
      if (req.method === 'POST' && rest === ':batchUpdate') {
        for (const r of json.requests) { const t = r.addSheet.properties.title; if (tabs.has(t)) return send(400, { error: { message: `A sheet with the name "${t}" already exists.` } }); tabs.set(t, []); }
        return send(200, {});
      }
      if (req.method === 'GET' && rest === '/values:batchGet') {
        stats.reads++;
        const ranges = url.searchParams.getAll('ranges');
        for (const r of ranges) if (!tabs.has(parseA1(r).tab)) return send(400, { error: { message: `Unable to parse range: ${r}` } });
        return send(200, { valueRanges: ranges.map((r) => { const rows = tabs.get(parseA1(r).tab); const trimmed = rows.map((row) => { const x = [...row]; while (x.length && (x[x.length - 1] === '' || x[x.length - 1] == null)) x.pop(); return x; }); while (trimmed.length && !trimmed[trimmed.length - 1].length) trimmed.pop(); return { range: r, values: trimmed.length ? trimmed : undefined }; }) });
      }
      let m;
      if (req.method === 'GET' && (m = /^\/values\/(.+)$/.exec(rest))) {
        stats.reads++;
        const a = parseA1(m[1]); const v = (tabs.get(a.tab) || [])[a.r0]?.[a.c0];
        return send(200, { values: v === undefined ? undefined : [[v]] });
      }
      if (req.method === 'POST' && rest === '/values:batchUpdate') {
        stats.writes++; stats.log.push(['update', json.data.map((d) => d.range)]);
        if (json.valueInputOption !== 'RAW') return send(400, { error: { message: 'test expects RAW' } });
        for (const d of json.data) {
          const a = parseA1(d.range); const rows = tabs.get(a.tab); if (!rows) return send(400, { error: { message: 'Unable to parse range: ' + d.range } });
          d.values.forEach((vr, i) => { const row = rows[a.r0 + i] || (rows[a.r0 + i] = []); vr.forEach((v, j) => { row[a.c0 + j] = v; }); });
          for (let i = 0; i < rows.length; i++) rows[i] = rows[i] || [];
        }
        return send(200, {});
      }
      if (req.method === 'POST' && rest === '/values:batchClear') {
        stats.writes++; stats.log.push(['clear', json.ranges]);
        for (const r of json.ranges) { const a = parseA1(r); const rows = tabs.get(a.tab); for (let i = a.r0; i <= Math.min(a.r1, rows.length - 1); i++) for (let j = a.c0; j <= Math.min(a.c1, (rows[i] || []).length - 1); j++) rows[i][j] = ''; }
        return send(200, {});
      }
      return send(404, { error: { message: 'unknown ' + req.method + ' ' + rest } });
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    ok({ base, tabs, stats, sheetId, clientEmail, close: () => srv.close() });
  }));
}
module.exports = { startFakeGoogle };
