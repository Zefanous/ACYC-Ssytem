'use strict';
// Usage: npm run backup [target-file]   (works while the server is running)
const path = require('node:path'); const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const src = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'club.db');
const stamp = new Date().toISOString().slice(0, 10);
const dest = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups', `club-${stamp}.db`));
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) { console.error(`Refusing to overwrite ${dest}`); process.exit(1); }
const db = new DatabaseSync(src); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); db.close();
console.log(`Backup written to ${dest}`);
