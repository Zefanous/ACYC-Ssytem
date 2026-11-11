'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','leader')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','removed')),
  date_joined TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  starts_at TEXT NOT NULL,           -- local club time, YYYY-MM-DDTHH:MM
  location TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  organizer_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','cancelled')),
  cancel_reason TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_starts ON activities(starts_at);
CREATE TABLE IF NOT EXISTS attendance (
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (activity_id, member_id)
);
CREATE TABLE IF NOT EXISTS notes (
  activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  notes TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  outcomes TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  responsible_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  due_date TEXT NOT NULL,            -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
`;

// Tabs (in this order) are also the sheet tabs when Google Sheets is the database.
const TABLES = ['users', 'members', 'activities', 'attendance', 'notes', 'tasks', 'audit'];

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
module.exports = { openDb, TABLES };
