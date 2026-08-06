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
const express = require('express');
const db = require('./db');
const { lookup } = require('./barcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- small helpers ---------------------------------------------------------

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// Directions: how each transaction type changes on-hand quantity.
const DIRECTION = { receive: +1, return: +1, checkout: -1, adjustment: +1 };

// Apply a stock movement + write the audit row, atomically.
const applyMovement = db.transaction((itemId, userId, type, quantity, note) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');
  const delta = DIRECTION[type] * quantity;
  const newQty = item.quantity + delta;
  if (newQty < 0) throw new Error('Not enough stock on hand');
  db.prepare(
    "UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(newQty, itemId);
  const info = db
    .prepare(
      'INSERT INTO transactions (item_id, user_id, type, quantity, note) VALUES (?, ?, ?, ?, ?)'
    )
    .run(itemId, userId, type, quantity, note || null);
  return { transaction_id: info.lastInsertRowid, quantity: newQty };
});

function itemWithLabels(row) {
  if (!row) return row;
  return {
    ...row,
    low: row.quantity <= row.low_stock_threshold && row.low_stock_threshold > 0,
  };
}

// --- barcode lookup --------------------------------------------------------

app.get('/api/lookup/:barcode', async (req, res) => {
  const barcode = req.params.barcode.trim();

  // 1) Already in our catalog? Return it instantly, no external call.
  const existing = db
    .prepare('SELECT * FROM items WHERE barcode = ?')
    .get(barcode);
  if (existing) {
    return res.json({ found: 'local', item: itemWithLabels(existing) });
  }

  // 2) Ask the configured external provider.
  try {
    const product = await lookup(barcode, {
      provider: getSetting('barcode_provider', 'upcitemdb'),
      apiKey: getSetting('barcode_api_key', ''),
    });
    if (product && product.name) {
      return res.json({ found: 'external', product });
    }
    return res.json({ found: 'none' });
  } catch (err) {
    // Lookup failed (network/rate limit) — tell the client so it can fall back
    // to manual entry rather than pretending the product doesn't exist.
    return res.json({ found: 'error', error: err.message });
  }
});

// --- items -----------------------------------------------------------------

app.get('/api/items', (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS category, u.name AS unit
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN units u ON u.id = i.unit_id
       WHERE i.active = 1
       ORDER BY i.name COLLATE NOCASE`
    )
    .all();
  res.json(rows.map(itemWithLabels));
});

app.get('/api/items/barcode/:barcode', (req, res) => {
  const row = db
    .prepare('SELECT * FROM items WHERE barcode = ?')
    .get(req.params.barcode.trim());
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(itemWithLabels(row));
});

app.post('/api/items', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db
      .prepare(
        `INSERT INTO items (barcode, name, brand, category_id, unit_id, image_url, quantity, low_stock_threshold, notes)
         VALUES (@barcode, @name, @brand, @category_id, @unit_id, @image_url, @quantity, @low_stock_threshold, @notes)`
      )
      .run({
        barcode: b.barcode || null,
        name: b.name,
        brand: b.brand || null,
        category_id: b.category_id || null,
        unit_id: b.unit_id || null,
        image_url: b.image_url || null,
        quantity: Number(b.quantity) || 0,
        low_stock_threshold: Number(b.low_stock_threshold) || 0,
        notes: b.notes || null,
      });
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(itemWithLabels(row));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/items/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['barcode', 'name', 'brand', 'category_id', 'unit_id', 'image_url', 'low_stock_threshold', 'notes'];
  const sets = [];
  const params = { id: req.params.id };
  for (const f of fields) {
    if (f in b) { sets.push(`${f} = @${f}`); params[f] = b[f]; }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  try {
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run(params);
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    res.json(itemWithLabels(row));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- stock movements (receive / checkout / return / adjustment) ------------

app.post('/api/transactions', (req, res) => {
  const b = req.body || {};
  const { item_id, user_id, type } = b;
  const quantity = Number(b.quantity);
  if (!item_id || !type || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'item_id, type, and a positive quantity are required' });
  }
  if (!DIRECTION.hasOwnProperty(type)) {
    return res.status(400).json({ error: `Unknown transaction type: ${type}` });
  }
  try {
    const result = applyMovement(item_id, user_id || null, type, quantity, b.note);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/transactions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = db
    .prepare(
      `SELECT t.*, i.name AS item_name, i.barcode AS item_barcode, u.name AS user_name
       FROM transactions t
       LEFT JOIN items i ON i.id = t.item_id
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`
    )
    .all(limit);
  res.json(rows);
});

// --- users / techs ---------------------------------------------------------

app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT id, name, role, badge_barcode, active, created_at FROM users ORDER BY name COLLATE NOCASE').all());
});

app.get('/api/users/badge/:barcode', (req, res) => {
  const row = db
    .prepare('SELECT id, name, role, badge_barcode FROM users WHERE badge_barcode = ? AND active = 1')
    .get(req.params.barcode.trim());
  if (!row) return res.status(404).json({ error: 'Badge not recognized' });
  res.json(row);
});

function randomBadge() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `TECH-${s}`;
}

app.post('/api/users', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  const badge = (b.badge_barcode || randomBadge()).toUpperCase();
  try {
    const info = db
      .prepare("INSERT INTO users (name, role, badge_barcode, pin) VALUES (?, ?, ?, ?)")
      .run(b.name, b.role === 'admin' ? 'admin' : 'tech', badge, b.pin || null);
    res.status(201).json(db.prepare('SELECT id, name, role, badge_barcode, active FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/users/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['name', 'role', 'badge_barcode', 'active', 'pin'];
  const sets = [];
  const params = { id: req.params.id };
  for (const f of fields) {
    if (f in b) { sets.push(`${f} = @${f}`); params[f] = b[f]; }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
    res.json(db.prepare('SELECT id, name, role, badge_barcode, active FROM users WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin console login: match name + pin. (Simple by design; see README.)
app.post('/api/login', (req, res) => {
  const { name, pin } = req.body || {};
  const row = db
    .prepare("SELECT id, name, role FROM users WHERE name = ? AND pin = ? AND role = 'admin' AND active = 1")
    .get(name, pin);
  if (!row) return res.status(401).json({ error: 'Invalid name or PIN' });
  res.json(row);
});

// --- categories & units (configurable taxonomy) ----------------------------

app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all());
});
app.post('/api/categories', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/units', (req, res) => {
  res.json(db.prepare('SELECT * FROM units ORDER BY name').all());
});
app.post('/api/units', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO units (name) VALUES (?)').run(name);
    res.status(201).json(db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- dashboard -------------------------------------------------------------

app.get('/api/dashboard', (req, res) => {
  const totals = db
    .prepare('SELECT COUNT(*) AS items, COALESCE(SUM(quantity),0) AS units FROM items WHERE active = 1')
    .get();
  const lowStock = db
    .prepare(
      `SELECT i.*, c.name AS category, u.name AS unit
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN units u ON u.id = i.unit_id
       WHERE i.active = 1 AND i.low_stock_threshold > 0 AND i.quantity <= i.low_stock_threshold
       ORDER BY (i.quantity * 1.0 / NULLIF(i.low_stock_threshold,0)) ASC`
    )
    .all();
  const recent = db
    .prepare(
      `SELECT t.*, i.name AS item_name, u.name AS user_name
       FROM transactions t
       LEFT JOIN items i ON i.id = t.item_id
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC, t.id DESC LIMIT 10`
    )
    .all();
  res.json({ totals, lowStock: lowStock.map(itemWithLabels), recent });
});

// --- settings --------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  delete out.barcode_api_key; // don't leak the key to the browser
  out.has_barcode_api_key = !!getSetting('barcode_api_key', '');
  res.json(out);
});
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(b)) up.run(k, String(v));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`StockTrax running on http://localhost:${PORT}`);
});
