'use strict';
// Creates DEMONSTRATION data only. All people below are invented; every record is flagged is_demo=1
// and shown with an "Example" badge in the app. Do not run on a database holding real club records.
const { createApp, clubNow } = require('../src/club');

const NAMES = ['Amina Example', 'Brian Sample', 'Chloe Demo', 'Daniel Placeholder', 'Esther Test', 'Felix Mockson',
  'Grace Illustrative', 'Henry Sampleton', 'Irene Pretend', 'Joseph Exemplar', 'Kevin Fictional', 'Lydia Notreal'];

function addDays(iso, d) { const t = new Date(iso.slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }

function seed(app, { adminPassword = 'DemoAdmin-2026!', leaderPassword = 'DemoLeader-2026!' } = {}) {
  const { db, hashPassword } = app;
  const today = clubNow().slice(0, 10);
  const user = db.prepare('INSERT OR IGNORE INTO users (username,display_name,role,password_hash,must_change) VALUES (?,?,?,?,0)');
  user.run('demo-admin', 'Demo Administrator (Example)', 'admin', hashPassword(adminPassword));
  user.run('demo-leader', 'Demo Leader (Example)', 'leader', hashPassword(leaderPassword));
  const mem = db.prepare('INSERT INTO members (full_name,phone,email,status,date_joined,is_demo) VALUES (?,?,?,?,?,1)');
  const ids = NAMES.map((n, i) => Number(mem.run(n, `0700 000 ${String(100 + i)}`, null, i === 11 ? 'inactive' : 'active', addDays(today, -400 + i * 20)).lastInsertRowid));
  const act = db.prepare('INSERT INTO activities (title,type,starts_at,location,description,organizer_member_id,status,cancel_reason,is_demo) VALUES (?,?,?,?,?,?,?,?,1)');
  const defs = [
    ['Weekly club meeting (Example)', 'Meeting', -21, '15:00', 'Club room', 'Review of last month; plan the outreach day.', 0],
    ['Peer education training (Example)', 'Training', -14, '10:00', 'Community hall', 'Facilitation skills practice.', 1],
    ['Weekly club meeting (Example)', 'Meeting', -7, '15:00', 'Club room', 'Outreach day logistics.', 0],
    ['Community outreach day (Example)', 'Outreach', -3, '09:00', 'Market square', 'Information stall and youth conversations.', 2],
    ['Fundraising planning (Example)', 'Meeting', -1, '16:00', 'Club room', 'Cancelled: venue unavailable.', 3, 'cancelled', 'Venue unavailable (example)'],
    ['Weekly club meeting (Example)', 'Meeting', 4, '15:00', 'Club room', 'Agenda: outreach feedback, next quarter plan.', 0],
    ['Youth awareness event (Example)', 'Event', 12, '13:00', 'School grounds', 'Drama, talks and Q&A.', 2],
  ].map((d) => d);
  const actIds = defs.map((d) => Number(act.run(d[0], d[1], `${addDays(today, d[2])}T${d[3]}`, d[4], d[5], ids[d[6]], d[7] || 'planned', d[8] || null).lastInsertRowid));
  const att = db.prepare('INSERT INTO attendance (activity_id,member_id,status) VALUES (?,?,?)');
  const pattern = ['present', 'present', 'late', 'present', 'absent', 'present', 'excused', 'present', 'absent', 'present', 'late'];
  [0, 1, 2, 3].forEach((ai) => ids.slice(0, 11).forEach((m, mi) => att.run(actIds[ai], m, pattern[(mi + ai * 3) % pattern.length])));
  db.prepare('INSERT INTO notes (activity_id,notes,decisions,outcomes) VALUES (?,?,?,?)').run(actIds[2],
    'Discussed logistics for the outreach day (example notes).', 'Hold outreach day on Saturday. Split into two teams.', 'Teams agreed; leaflets to be prepared.');
  const task = db.prepare('INSERT INTO tasks (activity_id,title,responsible_member_id,due_date,status,completed_at) VALUES (?,?,?,?,?,?)');
  task.run(actIds[2], 'Prepare information leaflets (example)', ids[4], addDays(today, -2), 'open', null);
  task.run(actIds[2], 'Book market square stall (example)', ids[2], addDays(today, -5), 'done', addDays(today, -6));
  task.run(actIds[3], 'Write outreach summary (example)', ids[2], addDays(today, 3), 'open', null);
  task.run(actIds[3], 'Return borrowed banners (example)', ids[5], addDays(today, 6), 'open', null);
  return { today };
}
module.exports = { seed };

if (require.main === module) {
  const app = createApp();
  if (app.db.prepare('SELECT COUNT(*) n FROM members').get().n > 0) { console.error('Database already has members; refusing to add demo data.'); process.exit(1); }
  seed(app);
  console.log('Demo data added. Sign in with demo-admin / DemoAdmin-2026!  or  demo-leader / DemoLeader-2026!');
  console.log('These accounts and all "Example" records are for demonstration only. Delete them before real use.');
  app.close();
}
