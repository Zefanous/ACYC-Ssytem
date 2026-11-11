'use strict';
// Copies a local SQLite club database into the Google Sheet (REPLACES everything in the sheet's data tabs).
// Usage:  STORAGE=sheets SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' npm run sheets:import -- data/club.db
// Handy for: loading the demo data into the sheet, or moving an existing local database to Sheets.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { storeFromEnv } = require('../src/store');
(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Usage: npm run sheets:import -- <local-database-file>'); process.exit(1); }
  process.env.STORAGE = 'sheets';
  const store = storeFromEnv();
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = store.dumpFrom(db);
  const counts = Object.entries(tables).map(([t, r]) => `${t}: ${r.length}`).join(', ');
  if (process.argv.includes('--yes') === false) { console.log(`About to REPLACE the sheet's data with ${counts}.\nRe-run with --yes to confirm.`); process.exit(0); }
  await store.replaceAll(tables);
  console.log(`Sheet updated (${counts}).`);
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
