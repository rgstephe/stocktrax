-- StockTrax schema
-- Design note: categories, units, and settings live in tables (not hardcoded)
-- so the same app serves pest control, landscaping, electrical, etc. by config alone.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Offices / branches. There is always one "main" office (created on first
-- boot / upgrade). Multi-office mode is switched on in Settings; until then
-- everything quietly runs against the main office.
CREATE TABLE IF NOT EXISTS offices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  address_line1 TEXT,
  address_line2 TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  phone         TEXT,
  email         TEXT,
  manager       TEXT,
  license_no    TEXT,                   -- state pesticide business license, etc.
  notes         TEXT,
  is_main       INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'tech' CHECK (role IN ('admin','tech')),
  badge_barcode TEXT UNIQUE,            -- scanned at the kiosk to identify the tech
  pin           TEXT,                   -- legacy; superseded by password_hash
  password_hash TEXT,                   -- scrypt hash for admin console login
  recovery_hash TEXT,                   -- scrypt hash of the account recovery code
  office_id     INTEGER REFERENCES offices(id) ON DELETE SET NULL, -- home office
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin login sessions (opaque cookie tokens).
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
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

-- Physical rooms/areas stock lives in (warehouse, chemical room, tool room…).
-- Each room belongs to an office. Not seeded — the user adds whatever rooms they want.
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  office_id  INTEGER REFERENCES offices(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (office_id, name)
);

CREATE TABLE IF NOT EXISTS items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode             TEXT UNIQUE,
  name                TEXT NOT NULL,
  brand               TEXT,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  unit_id             INTEGER REFERENCES units(id) ON DELETE SET NULL,
  location_id         INTEGER REFERENCES locations(id) ON DELETE SET NULL, -- legacy/default; per-office room lives in item_stock
  image_url           TEXT,
  quantity            INTEGER NOT NULL DEFAULT 0,   -- total across all offices (kept in sync)
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,   -- default alert level for new offices
  notes               TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);

-- On-hand stock per item per office. This is the source of truth for counts;
-- items.quantity is the cached total across offices.
CREATE TABLE IF NOT EXISTS item_stock (
  item_id             INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  office_id           INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  quantity            INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  location_id         INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  PRIMARY KEY (item_id, office_id)
);

-- Every stock movement is an immutable row here. This is the audit trail.
CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  office_id  INTEGER REFERENCES offices(id) ON DELETE SET NULL,
  type       TEXT NOT NULL CHECK (type IN ('receive','checkout','return','adjustment','transfer_out','transfer_in')),
  quantity   INTEGER NOT NULL,          -- always positive; `type` decides direction
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
