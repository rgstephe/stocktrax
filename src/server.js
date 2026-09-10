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
const { execSync } = require('child_process');
const express = require('express');

// --- run as non-root -------------------------------------------------------
// If we start as root (default in the container), make the data directory
// owned by the unprivileged "node" user, then drop to it before we open the
// database or listen. This self-corrects an existing root-owned ./data volume,
// so no manual chown is needed on upgrade.
(function dropPrivileges() {
  try {
    if (process.platform !== 'linux' || !process.getuid || process.getuid() !== 0) return;
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    try { execSync(`chown -R node:node "${dataDir}"`); } catch (e) { /* best effort */ }
    process.setgid('node');
    process.setuid('node');
    console.log('[startup] dropped privileges to non-root user "node"');
  } catch (e) {
    console.error('[startup] could not drop privileges:', e.message);
  }
})();

const db = require('./db');
const { lookup } = require('./barcode');
const { hashPassword, verifyPassword, generateRecoveryCode, randomToken } = require('./auth');
const pkg = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_MS = 1000 * 60 * 60 * 12; // 12 hours

app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' })); // headroom for base64 logo uploads

// Basic security headers.
// Security headers, including a Content-Security-Policy. 'unsafe-inline' is
// present because the app uses a few inline handlers; even so, the CSP blocks
// external script/object sources and clickjacking, which is the main benefit.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https: http:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

// CSRF defense: for state-changing requests, require that the browser's Origin
// (or Referer) matches this host. Browsers always send Origin on cross-site
// POST/PUT/PATCH, so this blocks forged requests without needing token plumbing.
// Non-browser clients (no Origin/Referer) are allowed — they aren't a CSRF vector.
function isSameOrigin(req) {
  const host = req.headers.host;
  const source = req.headers.origin || req.headers.referer;
  if (!source) return true;
  try { return new URL(source).host === host; } catch (e) { return false; }
}
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

// ---- small helpers --------------------------------------------------------

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

// Directions: how each transaction type changes on-hand quantity.
const DIRECTION = { receive: +1, return: +1, checkout: -1, adjustment: +1 };

const applyMovement = db.transaction((itemId, userId, type, quantity, note) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');
  const delta = DIRECTION[type] * quantity;
  const newQty = item.quantity + delta;
  if (newQty < 0) throw new Error('Not enough stock on hand');
  db.prepare("UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(newQty, itemId);
  const info = db
    .prepare('INSERT INTO transactions (item_id, user_id, type, quantity, note) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, userId, type, quantity, note || null);
  return { transaction_id: info.lastInsertRowid, quantity: newQty };
});

function itemWithLabels(row) {
  if (!row) return row;
  return { ...row, low: row.quantity <= row.low_stock_threshold && row.low_stock_threshold > 0 };
}

// Turn low-level SQLite constraint errors into friendly messages (and avoid
// leaking schema detail). Business errors thrown as plain Error pass through.
function cleanDbError(err) {
  const code = err && err.code;
  if (typeof code === 'string' && code.startsWith('SQLITE_')) {
    if (code.includes('UNIQUE')) return 'That value is already in use.';
    if (code.includes('NOTNULL')) return 'A required field is missing.';
    if (code.includes('CHECK')) return "That value isn't allowed.";
    if (code.includes('FOREIGNKEY')) return 'A related record was not found.';
    return 'Could not save — please check the values and try again.';
  }
  return (err && err.message) ? err.message : 'Request failed';
}

// Only these settings keys may be written, and some are format-checked.
const ALLOWED_SETTINGS = new Set([
  'company_name', 'brand_tagline', 'logo_data_url', 'barcode_provider', 'barcode_api_key', 'theme_default',
]);
const BARCODE_PROVIDERS = ['upcitemdb', 'openfoodfacts'];

// Accept only real raster-image data URLs. Rejecting SVG removes the stored-XSS
// vector (SVG can carry script); raster images cannot execute.
function isValidLogoDataUrl(v) {
  if (v === '') return true; // empty clears the logo
  if (typeof v !== 'string') return false;
  if (v.length > 3_000_000) return false; // ~2 MB of base64
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
}

// ---- auth plumbing --------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  // Set COOKIE_SECURE=true once you serve StockTrax over HTTPS.
  const secure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `st_session=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
function clearSessionCookie(res) {
  const secure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `st_session=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`);
}

function currentUser(req) {
  const token = parseCookies(req).st_session;
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT id, name, role FROM users WHERE id = ? AND active = 1').get(s.user_id) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u;
  next();
}
function optionalAuth(req, res, next) {
  req.user = currentUser(req);
  next();
}

// Simple in-memory rate limiting for login/recovery (per IP, 15-min window).
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count > 10;
}
function clearAttempts(ip) { attempts.delete(ip); }

// Purge expired sessions hourly.
setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (e) { /* ignore */ }
}, 60 * 60 * 1000).unref();

// ===========================================================================
// PUBLIC routes (kiosk + auth). No login required — the kiosk identifies techs
// by badge scan, not by console login.
// ===========================================================================

// Gate the admin PAGE itself for a clean redirect (real protection is the API).
app.get('/admin.html', (req, res, next) => {
  if (currentUser(req)) return next();
  return res.redirect('/login.html');
});

app.get('/api/branding', (req, res) => {
  res.json({
    company_name: getSetting('company_name', 'StockTrax'),
    tagline: getSetting('brand_tagline', 'Complete Inventory Control, On Your Terms'),
    logo_data_url: getSetting('logo_data_url', ''),
    theme_default: getSetting('theme_default', 'dark'),
  });
});

app.get('/api/version', (req, res) => {
  res.json({ version: pkg.version, name: 'StockTrax' });
});

app.get('/api/users/badge/:barcode', (req, res) => {
  const row = db
    .prepare('SELECT id, name, role, badge_barcode FROM users WHERE badge_barcode = ? AND active = 1')
    .get(req.params.barcode.trim());
  if (!row) return res.status(404).json({ error: 'Badge not recognized' });
  res.json(row);
});

app.get('/api/items/barcode/:barcode', (req, res) => {
  const row = db
    .prepare(
      `SELECT i.*, l.name AS location
       FROM items i
       LEFT JOIN locations l ON l.id = i.location_id
       WHERE i.barcode = ?`
    )
    .get(req.params.barcode.trim());
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(itemWithLabels(row));
});

// Kiosk records checkout/return without a login. Receiving/adjusting stock is
// an admin action and requires a session.
app.post('/api/transactions', optionalAuth, (req, res) => {
  const b = req.body || {};
  const { item_id, user_id, type } = b;
  const quantity = Number(b.quantity);
  if (!item_id || !type || !quantity || quantity <= 0) {
    return res.status(400).json({ error: 'item_id, type, and a positive quantity are required' });
  }
  if (!DIRECTION.hasOwnProperty(type)) {
    return res.status(400).json({ error: `Unknown transaction type: ${type}` });
  }
  if ((type === 'receive' || type === 'adjustment') && !req.user) {
    return res.status(401).json({ error: 'Admin login required for this action' });
  }
  try {
    res.status(201).json(applyMovement(item_id, user_id || null, type, quantity, b.note));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

// --- login / session / recovery -------------------------------------------

app.post('/api/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again.' });
  const { name, password } = req.body || {};
  const user = db
    .prepare("SELECT * FROM users WHERE name = ? AND role = 'admin' AND active = 1")
    .get((name || '').trim());
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid name or password' });
  }
  clearAttempts(req.ip);
  const token = randomToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, user.id, now, now + SESSION_MS);
  setSessionCookie(res, token);
  res.json({ id: user.id, name: user.name, role: user.role, recovery_set: !!user.recovery_hash });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).st_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const row = db.prepare('SELECT recovery_hash FROM users WHERE id = ?').get(u.id);
  res.json({ ...u, recovery_set: !!(row && row.recovery_hash) });
});

// Forgot-password: reset using the saved recovery code. Rotates the code and
// invalidates existing sessions.
app.post('/api/recover', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again.' });
  const { name, code, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const user = db
    .prepare("SELECT * FROM users WHERE name = ? AND role = 'admin' AND active = 1")
    .get((name || '').trim());
  const codeUpper = String(code || '').trim().toUpperCase();
  if (!user || !user.recovery_hash || !verifyPassword(codeUpper, user.recovery_hash)) {
    return res.status(401).json({ error: 'Name or recovery code is incorrect.' });
  }
  clearAttempts(req.ip);
  const newCode = generateRecoveryCode();
  db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?')
    .run(hashPassword(new_password), hashPassword(newCode), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ ok: true, recovery_code: newCode });
});

// ===========================================================================
// Everything below requires a valid admin session.
// ===========================================================================
app.use('/api', requireAuth);

// --- account (self-service password & recovery) ----------------------------

app.get('/api/account', (req, res) => {
  const u = db.prepare('SELECT name, recovery_hash FROM users WHERE id = ?').get(req.user.id);
  res.json({ name: u.name, recovery_set: !!u.recovery_hash });
});

app.post('/api/account/password', (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), user.id);
  res.json({ ok: true });
});

app.post('/api/account/recovery-code', (req, res) => {
  const code = generateRecoveryCode();
  db.prepare('UPDATE users SET recovery_hash = ? WHERE id = ?').run(hashPassword(code), req.user.id);
  res.json({ recovery_code: code });
});

// --- barcode lookup (receiving) --------------------------------------------

app.get('/api/lookup/:barcode', async (req, res) => {
  const barcode = req.params.barcode.trim();
  const existing = db.prepare('SELECT * FROM items WHERE barcode = ?').get(barcode);
  if (existing) return res.json({ found: 'local', item: itemWithLabels(existing) });
  try {
    const product = await lookup(barcode, {
      provider: getSetting('barcode_provider', 'upcitemdb'),
      apiKey: getSetting('barcode_api_key', ''),
    });
    if (product && product.name) return res.json({ found: 'external', product });
    return res.json({ found: 'none' });
  } catch (err) {
    return res.json({ found: 'error', error: cleanDbError(err) });
  }
});

// --- items -----------------------------------------------------------------

app.get('/api/items', (req, res) => {
  const includeInactive = req.query.include_inactive === '1';
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS category, u.name AS unit, l.name AS location
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN units u ON u.id = i.unit_id
       LEFT JOIN locations l ON l.id = i.location_id
       ${includeInactive ? '' : 'WHERE i.active = 1'}
       ORDER BY i.name COLLATE NOCASE`
    )
    .all();
  res.json(rows.map(itemWithLabels));
});

// Suggest the next auto-generated in-house barcode (STK-#####) for stock that
// has no manufacturer barcode. Uniqueness is guaranteed by scanning existing.
function nextAutoBarcode() {
  const rows = db.prepare("SELECT barcode FROM items WHERE barcode LIKE 'STK-%'").all();
  let max = 0;
  for (const r of rows) {
    const m = /^STK-(\d+)$/.exec(r.barcode || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'STK-' + String(max + 1).padStart(5, '0');
}
app.get('/api/items/next-barcode', (req, res) => {
  res.json({ barcode: nextAutoBarcode() });
});

app.post('/api/items', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db
      .prepare(
        `INSERT INTO items (barcode, name, brand, category_id, unit_id, location_id, image_url, quantity, low_stock_threshold, notes)
         VALUES (@barcode, @name, @brand, @category_id, @unit_id, @location_id, @image_url, @quantity, @low_stock_threshold, @notes)`
      )
      .run({
        barcode: b.barcode || null,
        name: b.name,
        brand: b.brand || null,
        category_id: b.category_id || null,
        unit_id: b.unit_id || null,
        location_id: b.location_id || null,
        image_url: b.image_url || null,
        quantity: Number(b.quantity) || 0,
        low_stock_threshold: Number(b.low_stock_threshold) || 0,
        notes: b.notes || null,
      });
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(itemWithLabels(row));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

app.patch('/api/items/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['barcode', 'name', 'brand', 'category_id', 'unit_id', 'location_id', 'image_url', 'low_stock_threshold', 'notes', 'active'];
  const sets = [];
  const params = { id: req.params.id };
  for (const f of fields) if (f in b) { sets.push(`${f} = @${f}`); params[f] = b[f]; }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  try {
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = @id`).run(params);
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    res.json(itemWithLabels(row));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

// Manual stock adjustment: set the on-hand count to a corrected value and log
// why (physical recount, breakage, etc.). Recorded as an 'adjustment' movement.
const applyAdjustment = db.transaction((itemId, userId, newCount, note) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Item not found');
  db.prepare("UPDATE items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(newCount, itemId);
  const fullNote = `Set to ${newCount} (was ${item.quantity}).` + (note ? ' ' + note : '');
  db.prepare('INSERT INTO transactions (item_id, user_id, type, quantity, note) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, userId, 'adjustment', newCount, fullNote);
  return { quantity: newCount, was: item.quantity };
});
app.post('/api/items/:id/adjust', (req, res) => {
  const b = req.body || {};
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 0) {
    return res.status(400).json({ error: 'Enter a whole number of 0 or more.' });
  }
  try {
    res.json(applyAdjustment(req.params.id, req.user.id, count, (b.note || '').trim()));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

// Full inventory export as CSV (includes inactive items, flagged).
app.get('/api/items.csv', (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.name, i.brand, c.name AS category, l.name AS location, u.name AS unit,
              i.quantity, i.low_stock_threshold, i.barcode, i.active
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN locations l ON l.id = i.location_id
       LEFT JOIN units u ON u.id = i.unit_id
       ORDER BY i.name COLLATE NOCASE`
    )
    .all();
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Name', 'Brand', 'Category', 'Location', 'Unit', 'Quantity', 'Low stock at', 'Barcode', 'Active'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.brand, r.category, r.location, r.unit, r.quantity, r.low_stock_threshold, r.barcode, r.active ? 'Yes' : 'No'].map(esc).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stocktrax_inventory_${stamp}.csv"`);
  res.send(lines.join('\r\n'));
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

function randomBadge() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
      .prepare('INSERT INTO users (name, role, badge_barcode) VALUES (?, ?, ?)')
      .run(b.name, b.role === 'admin' ? 'admin' : 'tech', badge);
    res.status(201).json(db.prepare('SELECT id, name, role, badge_barcode, active FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

app.patch('/api/users/:id', (req, res) => {
  const b = req.body || {};
  const fields = ['name', 'role', 'badge_barcode', 'active'];
  const sets = [];
  const params = { id: req.params.id };
  for (const f of fields) if (f in b) { sets.push(`${f} = @${f}`); params[f] = b[f]; }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
    res.json(db.prepare('SELECT id, name, role, badge_barcode, active FROM users WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(400).json({ error: cleanDbError(err) });
  }
});

// --- categories & units ----------------------------------------------------

app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all());
});
app.post('/api/categories', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) { res.status(400).json({ error: cleanDbError(err) }); }
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
  } catch (err) { res.status(400).json({ error: cleanDbError(err) }); }
});

app.get('/api/locations', (req, res) => {
  res.json(db.prepare('SELECT * FROM locations ORDER BY sort_order, name').all());
});
app.post('/api/locations', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
    res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) { res.status(400).json({ error: cleanDbError(err) }); }
});

// --- dashboard -------------------------------------------------------------

app.get('/api/dashboard', (req, res) => {
  const totals = db.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(quantity),0) AS units FROM items WHERE active = 1').get();
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
  delete out.barcode_api_key;
  out.has_barcode_api_key = !!getSetting('barcode_api_key', '');
  res.json(out);
});
app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(b)) {
    if (!ALLOWED_SETTINGS.has(k)) continue; // ignore unknown keys
    const val = String(v);
    if (k === 'logo_data_url' && !isValidLogoDataUrl(val)) {
      return res.status(400).json({ error: 'Logo must be a PNG, JPG, WebP, or GIF image.' });
    }
    if (k === 'barcode_provider' && !BARCODE_PROVIDERS.includes(val)) {
      return res.status(400).json({ error: 'Unknown barcode provider.' });
    }
    if (k === 'theme_default' && !['light', 'dark'].includes(val)) {
      return res.status(400).json({ error: 'Theme must be light or dark.' });
    }
    up.run(k, val);
  }
  res.json({ ok: true });
});

// --- reports (timezone-aware, downloadable) --------------------------------
//
// The client sends `from` and `to` as absolute UTC instants (ISO strings it
// computed from the admin's LOCAL calendar selection), so a "July" report lines
// up with the admin's own July, wherever they are. `tz` is used only to format
// the human-readable timestamps in the CSV.

function toStamp(iso, fallback) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS' UTC
}

function reportRows(fromIso, toIso) {
  const start = toStamp(fromIso, '1970-01-01 00:00:00');
  const end = toStamp(toIso, '9999-12-31 00:00:00');
  return db
    .prepare(
      `SELECT t.created_at, t.type, t.quantity,
              i.name AS item_name, i.barcode AS item_barcode,
              c.name AS category, u.name AS user_name
       FROM transactions t
       LEFT JOIN items i ON i.id = t.item_id
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.created_at >= ? AND t.created_at < ?
       ORDER BY t.created_at ASC, t.id ASC`
    )
    .all(start, end);
}

function fmtLocal(stamp, tz) {
  const d = new Date(stamp.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return stamp;
  try {
    return d.toLocaleString('en-US', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  } catch (e) {
    return stamp + ' UTC';
  }
}

app.get('/api/report/summary', (req, res) => {
  const rows = reportRows(req.query.from, req.query.to);
  const byType = { receive: 0, checkout: 0, return: 0, adjustment: 0 };
  const byItem = {};
  const byTech = {};
  for (const r of rows) {
    byType[r.type] = (byType[r.type] || 0) + r.quantity;
    const ik = r.item_name || '(deleted item)';
    byItem[ik] = byItem[ik] || { item: ik, received: 0, taken: 0, returned: 0 };
    if (r.type === 'receive') byItem[ik].received += r.quantity;
    else if (r.type === 'checkout') byItem[ik].taken += r.quantity;
    else if (r.type === 'return') byItem[ik].returned += r.quantity;
    if (r.type === 'checkout') {
      const tk = r.user_name || '—';
      byTech[tk] = (byTech[tk] || 0) + r.quantity;
    }
  }
  res.json({
    count: rows.length,
    byType,
    byItem: Object.values(byItem).sort((a, b) => b.taken - a.taken),
    byTech: Object.entries(byTech).map(([tech, taken]) => ({ tech, taken })).sort((a, b) => b.taken - a.taken),
  });
});

app.get('/api/report.csv', (req, res) => {
  const rows = reportRows(req.query.from, req.query.to);
  const tz = req.query.tz || 'UTC';
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = [`Date/Time (${tz})`, 'Type', 'Quantity', 'Item', 'Barcode', 'Category', 'Tech'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([fmtLocal(r.created_at, tz), r.type, r.quantity, r.item_name, r.item_barcode, r.category, r.user_name].map(esc).join(','));
  }
  const label = (req.query.label || 'report').replace(/[^\w.-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stocktrax_${label}.csv"`);
  res.send(lines.join('\r\n'));
});

// Static files last, so the gated routes above take precedence.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`StockTrax running on http://localhost:${PORT}`);
});
