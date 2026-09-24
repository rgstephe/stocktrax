/*
 * Allokis: self-hosted barcode inventory. Everything accounted for.
 * Copyright (C) 2026 Ultra Pest Control.
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed WITHOUT ANY WARRANTY; without even
 * the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU AGPL for more details: <https://www.gnu.org/licenses/>.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// The database file is allokis.db. Installs from before the rename have
// stocktrax.db; if that's the only one present, rename it (and its WAL/SHM
// side files) once so nothing is lost. If the rename fails for any reason,
// keep using the old file in place.
function resolveDbPath() {
  const next = path.join(DATA_DIR, 'allokis.db');
  const old = path.join(DATA_DIR, 'stocktrax.db');
  if (fs.existsSync(next) || !fs.existsSync(old)) return next;
  try {
    fs.renameSync(old, next);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(old + ext)) fs.renameSync(old + ext, next + ext);
    }
    console.log('[migrate] Renamed stocktrax.db to allokis.db.');
    return next;
  } catch (e) {
    console.error('[migrate] Could not rename stocktrax.db, using it as-is:', e.message);
    return old;
  }
}
const DB_PATH = resolveDbPath();
const db = new Database(DB_PATH);

// Apply schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ---- Migrations -----------------------------------------------------------
// Bring older databases (created before auth existed) up to the current shape,
// without losing data. Safe to run on every boot.

function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
ensureColumn('users', 'password_hash', 'TEXT');
ensureColumn('users', 'recovery_hash', 'TEXT');
ensureColumn('items', 'location_id', 'INTEGER'); // stock room/area; locations table added via schema.sql
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`);

// Upgrade path: any admin who still logs in with a legacy PIN and has no
// password yet gets that PIN turned into a proper hashed password, so their
// existing credential keeps working and nobody is locked out by the upgrade.
const legacyAdmins = db
  .prepare("SELECT id, pin FROM users WHERE role = 'admin' AND password_hash IS NULL AND pin IS NOT NULL AND pin != ''")
  .all();
if (legacyAdmins.length) {
  const setPw = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const a of legacyAdmins) setPw.run(hashPassword(a.pin), a.id);
  console.log(`[migrate] Upgraded ${legacyAdmins.length} admin PIN(s) to hashed passwords.`);
}

// ---- First-run seed -------------------------------------------------------
// Only seeds when the tables are empty, so restarts never clobber real data.

const seedSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
seedSetting.run('company_name', process.env.COMPANY_NAME || 'Allokis');
// Installs that never set a company name still carry the old default.
db.prepare("UPDATE settings SET value = 'Allokis' WHERE key = 'company_name' AND value = 'StockTrax'").run();
seedSetting.run('barcode_provider', process.env.BARCODE_PROVIDER || 'upcitemdb');
seedSetting.run('barcode_api_key', process.env.BARCODE_API_KEY || '');

const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
if (catCount === 0) {
  const insCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  // Generic-but-useful starter set. Fully editable in Settings.
  ['Chemicals', 'Bait', 'Traps', 'Equipment', 'PPE', 'Office/Misc'].forEach(
    (name, i) => insCat.run(name, i)
  );
}

const unitCount = db.prepare('SELECT COUNT(*) AS n FROM units').get().n;
if (unitCount === 0) {
  const insUnit = db.prepare('INSERT INTO units (name) VALUES (?)');
  ['each', 'bottle', 'case', 'box', 'bag', 'gallon', 'roll'].forEach((n) =>
    insUnit.run(n)
  );
}

seedSetting.run('multi_office_enabled', '0');
seedSetting.run('label_size', 'sheet');
seedSetting.run('label_show_name', '0');

// ---- Offices migration (v0.6.0) ------------------------------------------
// Every install gets a "main" office. Existing stock, stock rooms, techs and
// history are attached to it, so single-office users see no difference.
function tableSql(name) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return r ? r.sql : '';
}

let mainOffice = db.prepare('SELECT id FROM offices WHERE is_main = 1 ORDER BY id LIMIT 1').get();
if (!mainOffice) {
  const anyOffice = db.prepare('SELECT id FROM offices ORDER BY id LIMIT 1').get();
  if (anyOffice) {
    db.prepare('UPDATE offices SET is_main = 1 WHERE id = ?').run(anyOffice.id);
    mainOffice = anyOffice;
  } else {
    const co = (db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get() || {}).value;
    const name = co && co.trim() && co.trim() !== 'StockTrax' && co.trim() !== 'Allokis' ? co.trim() : 'Main Office';
    const info = db.prepare('INSERT INTO offices (name, is_main) VALUES (?, 1)').run(name);
    mainOffice = { id: Number(info.lastInsertRowid) };
  }
}
const MAIN_OFFICE_ID = mainOffice.id;

ensureColumn('users', 'office_id', 'INTEGER');

// Older databases need two tables rebuilt (SQLite can't alter a UNIQUE or
// CHECK constraint in place): locations become per-office, and transactions
// gain an office column plus the transfer movement types. This is SQLite's
// documented create-copy-drop-rename procedure, done atomically.
const needLocRebuild = !/office_id/.test(tableSql('locations'));
const needTxRebuild = !/transfer_in/.test(tableSql('transactions'));
if (needLocRebuild || needTxRebuild) {
  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    if (needLocRebuild) {
      db.exec(`CREATE TABLE locations_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        office_id  INTEGER REFERENCES offices(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (office_id, name)
      )`);
      db.prepare('INSERT INTO locations_new (id, name, office_id, sort_order) SELECT id, name, ?, sort_order FROM locations')
        .run(MAIN_OFFICE_ID);
      db.exec('DROP TABLE locations');
      db.exec('ALTER TABLE locations_new RENAME TO locations');
    }
    if (needTxRebuild) {
      const hasOfficeCol = /office_id/.test(tableSql('transactions'));
      db.exec(`CREATE TABLE transactions_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        office_id  INTEGER REFERENCES offices(id) ON DELETE SET NULL,
        type       TEXT NOT NULL CHECK (type IN ('receive','checkout','return','adjustment','transfer_out','transfer_in')),
        quantity   INTEGER NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.prepare(
        `INSERT INTO transactions_new (id, item_id, user_id, office_id, type, quantity, note, created_at)
         SELECT id, item_id, user_id, ${hasOfficeCol ? 'COALESCE(office_id, @m)' : '@m'}, type, quantity, note, created_at FROM transactions`
      ).run({ m: MAIN_OFFICE_ID });
      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
    }
  });
  rebuild();
  db.pragma('foreign_keys = ON');
  console.log('[migrate] Upgraded database for multi-office support.');
}

// Indexes that reference columns added above (so they come after migration).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_tx_office ON transactions(office_id);
  CREATE INDEX IF NOT EXISTS idx_stock_office ON item_stock(office_id);
`);

// Anything not yet attached to an office belongs to the main office.
db.prepare('UPDATE users SET office_id = ? WHERE office_id IS NULL').run(MAIN_OFFICE_ID);
db.prepare('UPDATE locations SET office_id = ? WHERE office_id IS NULL').run(MAIN_OFFICE_ID);
db.prepare('UPDATE transactions SET office_id = ? WHERE office_id IS NULL').run(MAIN_OFFICE_ID);
// Items with no per-office stock rows yet: their current count moves to main.
db.prepare(
  `INSERT OR IGNORE INTO item_stock (item_id, office_id, quantity, low_stock_threshold, location_id)
   SELECT id, ?, quantity, low_stock_threshold, location_id FROM items
   WHERE id NOT IN (SELECT item_id FROM item_stock)`
).run(MAIN_OFFICE_ID);

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  // A starter admin so you can log into the console on first boot.
  // Default login is  Admin / (ADMIN_PASSWORD env, or "admin").
  // Change it immediately in Settings and set a recovery code.
  const startPw = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare(
    "INSERT INTO users (name, role, badge_barcode, password_hash, office_id) VALUES (?, 'admin', ?, ?, ?)"
  ).run('Admin', 'ADMIN-0001', hashPassword(startPw), MAIN_OFFICE_ID);
}

module.exports = db;
