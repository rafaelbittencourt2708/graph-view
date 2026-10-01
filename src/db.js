// Share links, stored in SQLite. A share is (repo, branch, folder) behind a random, unguessable id,
// optionally with a password (stored as a scrypt hash, never in plain text).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './access.js';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    ref TEXT NOT NULL,
    folder TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`);
  // Added after the first deploy: older databases get the column on start.
  if (!db.prepare('PRAGMA table_info(shares)').all().some((c) => c.name === 'password_hash')) {
    db.exec('ALTER TABLE shares ADD COLUMN password_hash TEXT');
  }
  // A random key for signing viewer cookies, kept in the database so a restart doesn't sign everyone out.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('cookie_secret', crypto.randomBytes(32).toString('base64url'));
  const cookieSecret = db.prepare('SELECT value FROM meta WHERE key = ?').get('cookie_secret').value;

  // What the admin API may show: everything except the hash.
  const summary = ({ password_hash, ...share }) => ({ ...share, has_password: Boolean(password_hash) });

  return {
    cookieSecret,
    summary,
    create({ owner, repo, ref, folder, title, password }) {
      const id = crypto.randomBytes(16).toString('base64url'); // 128 bits
      db.prepare('INSERT INTO shares (id, owner, repo, ref, folder, title, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, owner, repo, ref, folder, title, new Date().toISOString(), password ? hashPassword(password) : null);
      return this.get(id);
    },
    get(id) {
      return db.prepare('SELECT * FROM shares WHERE id = ? AND revoked_at IS NULL').get(id) || null;
    },
    list() {
      return db.prepare('SELECT * FROM shares WHERE revoked_at IS NULL ORDER BY created_at DESC').all().map(summary);
    },
    setPassword(id, password) {
      return db.prepare('UPDATE shares SET password_hash = ? WHERE id = ? AND revoked_at IS NULL')
        .run(password ? hashPassword(password) : null, id).changes > 0;
    },
    revoke(id) {
      return db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0;
    },
  };
}
