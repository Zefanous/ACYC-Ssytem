'use strict';
// Usage: npm run restore -- path/to/backup.db     (STOP the server first)
const path = require('node:path'); const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run restore -- <backup-file.db>'); process.exit(1); }
const dest = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'club.db');
const chk = new DatabaseSync(file);
try {
  const ok = chk.prepare('PRAGMA integrity_check').get();
  const t = chk.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('users','members','activities','attendance')").get().n;
  if (Object.values(ok)[0] !== 'ok' || t !== 4) throw new Error('not a valid club backup');
} catch (e) { console.error('That file is not a valid club backup: ' + e.message); process.exit(1); } finally { chk.close(); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (fs.existsSync(dest)) { const keep = dest + '.before-restore-' + Date.now(); fs.copyFileSync(dest, keep); console.log(`Current data saved as ${keep}`); }
for (const ext of ['-wal', '-shm']) fs.rmSync(dest + ext, { force: true });
fs.copyFileSync(file, dest);
console.log(`Restored ${file} -> ${dest}. Start the server again.`);
