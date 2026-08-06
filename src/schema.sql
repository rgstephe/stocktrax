-- StockTrax schema
-- Design note: categories, units, and settings live in tables (not hardcoded)
-- so the same app serves pest control, landscaping, electrical, etc. by config alone.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'tech' CHECK (role IN ('admin','tech')),
  badge_barcode TEXT UNIQUE,            -- scanned at the kiosk to identify the tech
  pin           TEXT,                   -- optional, for admin console login
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS units (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode             TEXT UNIQUE,
  name                TEXT NOT NULL,
  brand               TEXT,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  unit_id             INTEGER REFERENCES units(id) ON DELETE SET NULL,
  image_url           TEXT,
  quantity            INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);

-- Every stock movement is an immutable row here. This is the audit trail.
CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL CHECK (type IN ('receive','checkout','return','adjustment')),
  quantity   INTEGER NOT NULL,          -- always positive; `type` decides direction
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
