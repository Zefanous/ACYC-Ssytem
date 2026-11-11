'use strict';
// Creates the sheet tabs and the first administrator in whatever storage the environment points at.
// Run ONCE from your own computer before first use on Vercel:
//   STORAGE=sheets SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' SESSION_SECRET=x node scripts/create-admin.js
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
(async () => {
  const app = createApp();
  const n = await app.withDb((d) => d.prepare('SELECT COUNT(*) n FROM users').get().n);
  if (n > 0) { console.log(`Storage already has ${n} user(s); nothing to do.`); return app.close(); }
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  await app.withDb((d) => d.prepare("INSERT INTO users (username,display_name,role,password_hash,must_change) VALUES ('admin','Administrator','admin',?,1)").run(app.hashPassword(pw)));
  console.log(`Created administrator "admin". Temporary password: ${pw}\nYou must change it at first sign-in.`);
  app.close();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
