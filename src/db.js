/*
 * StockTrax — self-hosted barcode inventory.
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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'stocktrax.db');
const db = new Database(DB_PATH);

// Apply schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ---- First-run seed -------------------------------------------------------
// Only seeds when the tables are empty, so restarts never clobber real data.

const seedSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
seedSetting.run('company_name', process.env.COMPANY_NAME || 'StockTrax');
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

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  // A starter admin so you can log into the console on first boot.
  // Change the PIN in Settings immediately.
  db.prepare(
    "INSERT INTO users (name, role, badge_barcode, pin) VALUES (?, 'admin', ?, ?)"
  ).run('Admin', 'ADMIN-0001', process.env.ADMIN_PIN || '4242');
}

module.exports = db;
