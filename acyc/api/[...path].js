'use strict';
// Vercel entry point: every /api/* request is served by the same app that runs locally.
// Static files (public/) are served by Vercel itself; security headers for them are set in vercel.json.
const crypto = require('node:crypto');
const { createApp } = require('../src/club');
let app, ready;

// First run only: if BOOTSTRAP_ADMIN_PASSWORD is set and the records contain no users, create the
// administrator "admin" with that password (which must be changed at first sign-in). Does nothing otherwise.
async function bootstrap(a) {
  const pw = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const n = await a.withDb((d) => d.prepare('SELECT COUNT(*) n FROM users').get().n);
  if (n === 0 && pw && pw.length >= 10) {
    await a.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash,must_change) VALUES ('admin','Administrator','admin',?,1)").run(a.hashPassword(pw)));
  }
}

module.exports = async (req, res) => {
  try {
    if (!app) {
      if (process.env.VERCEL && process.env.STORAGE !== 'sheets') {
        res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Server is not configured: set STORAGE=sheets and the Google variables in Vercel.' }));
      }
      app = createApp();
      ready = bootstrap(app).catch((e) => { console.error('Setup failed:', e.message); app = null; throw e; });
    }
    await ready;
  } catch (e) {
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'The club records (Google Sheets) could not be reached. Check the Google settings in Vercel, then try again.' }));
  }
  app.server.emit('request', req, res);
};
