'use strict';

let categories = [];
let units = [];
let locations = [];

// ---- tabs -----------------------------------------------------------------
document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === btn.dataset.tab));
  loadTab(btn.dataset.tab);
});

function loadTab(name) {
  if (name === 'dashboard') loadDashboard();
  else if (name === 'receive') loadReceive();
  else if (name === 'items') loadItems();
  else if (name === 'techs') loadTechs();
  else if (name === 'log') loadLog();
  else if (name === 'reports') loadReports();
  else if (name === 'settings') loadSettings();
}

// ---- shared taxonomy ------------------------------------------------------
async function ensureTaxonomy() {
  if (!categories.length) categories = await api.get('/api/categories');
  if (!units.length) units = await api.get('/api/units');
  if (!locations.length) locations = await api.get('/api/locations');
}
function optionList(rows, selected) {
  return ['<option value="">—</option>']
    .concat(rows.map((r) =>
      `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${escapeHtml(r.name)}</option>`))
    .join('');
}

// ---- DASHBOARD ------------------------------------------------------------
async function loadDashboard() {
  const d = await api.get('/api/dashboard');
  document.getElementById('stats').innerHTML =
    stat(d.totals.items, 'Distinct items') +
    stat(d.totals.units, 'Total units on hand') +
    stat(d.lowStock.length, 'Low-stock items');

  const banner = document.getElementById('lowBanner');
  banner.innerHTML = d.lowStock.length
    ? `<div class="banner"><span class="dot"></span> ${d.lowStock.length} item${d.lowStock.length > 1 ? 's' : ''} at or below the low-stock threshold.</div>`
    : '';

  document.getElementById('lowTable').innerHTML = d.lowStock.length
    ? table(['Item', 'Category', 'On hand', 'Threshold'],
        d.lowStock.map((i) => `<tr class="is-low"><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.category || '')}</td><td class="num">${i.quantity}</td><td class="num">${i.low_stock_threshold}</td></tr>`))
    : '<div class="empty">Everything is above its threshold. 👍</div>';

  document.getElementById('recentTable').innerHTML = d.recent.length
    ? table(['When', 'Item', 'Tech', 'Movement'],
        d.recent.map(txRow))
    : '<div class="empty">No activity yet.</div>';
}
function stat(n, l) { return `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`; }

// ---- RECEIVE --------------------------------------------------------------
let pendingItem = null;   // set when a known item was scanned (add-qty path)

async function loadReceive() {
  await ensureTaxonomy();
  document.getElementById('rcvCategory').innerHTML = optionList(categories);
  document.getElementById('rcvUnit').innerHTML = optionList(units);
  document.getElementById('rcvLocation').innerHTML = optionList(locations);
  const input = document.getElementById('rcvBarcode');
  input.value = '';
  input.focus();
}

document.getElementById('rcvBarcode').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const code = e.target.value.trim();
  if (!code) return;
  await doLookup(code);
});

async function doLookup(code) {
  const preview = document.getElementById('rcvPreview');
  const form = document.getElementById('rcvForm');
  preview.innerHTML = '<div class="preview">Looking up…</div>';
  pendingItem = null;

  let res;
  try {
    res = await api.get('/api/lookup/' + encodeURIComponent(code));
  } catch (err) {
    res = { found: 'error', error: err.message };
  }

  form.style.display = 'block';
  document.getElementById('rcvName').dataset.barcode = code;

  if (res.found === 'local') {
    // Known item — just adding quantity.
    pendingItem = res.item;
    preview.innerHTML = previewCard(res.item.image_url, res.item.name, res.item.brand,
      `Already in catalog · ${res.item.quantity} on hand`);
    fill('rcvName', res.item.name); fill('rcvBrand', res.item.brand || '');
    document.getElementById('rcvCategory').value = res.item.category_id || '';
    document.getElementById('rcvUnit').value = res.item.unit_id || '';
    document.getElementById('rcvLocation').value = res.item.location_id || '';
    fill('rcvThreshold', res.item.low_stock_threshold || 0);
    fill('rcvImage', res.item.image_url || '');
  } else if (res.found === 'external') {
    preview.innerHTML = previewCard(res.product.image_url, res.product.name, res.product.brand,
      `Found via ${res.product.source}`);
    fill('rcvName', res.product.name); fill('rcvBrand', res.product.brand || '');
    fill('rcvImage', res.product.image_url || '');
    fill('rcvThreshold', 0);
  } else {
    const why = res.found === 'error' ? 'Lookup failed — enter details manually.' : 'No match found — enter details manually.';
    preview.innerHTML = `<div class="preview"><div><div class="name">New product</div><div class="src">${why}</div></div></div>`;
    fill('rcvName', ''); fill('rcvBrand', ''); fill('rcvImage', '');
    fill('rcvThreshold', 0);
  }
  fill('rcvQty', 1);
  document.getElementById('rcvName').focus();
}

document.getElementById('rcvSave').addEventListener('click', async () => {
  const barcode = document.getElementById('rcvName').dataset.barcode;
  const qty = Number(val('rcvQty')) || 0;
  if (qty <= 0) return toast('Enter a quantity of 1 or more', true);

  try {
    let itemId;
    if (pendingItem) {
      itemId = pendingItem.id;
      // keep threshold/category edits in sync
      await api.patch('/api/items/' + itemId, {
        low_stock_threshold: Number(val('rcvThreshold')) || 0,
        category_id: numOrNull('rcvCategory'),
        unit_id: numOrNull('rcvUnit'),
        location_id: numOrNull('rcvLocation'),
        image_url: val('rcvImage') || null,
      });
    } else {
      if (!val('rcvName')) return toast('Name is required', true);
      const item = await api.post('/api/items', {
        barcode,
        name: val('rcvName'),
        brand: val('rcvBrand'),
        category_id: numOrNull('rcvCategory'),
        unit_id: numOrNull('rcvUnit'),
        location_id: numOrNull('rcvLocation'),
        image_url: val('rcvImage') || null,
        low_stock_threshold: Number(val('rcvThreshold')) || 0,
        quantity: 0,
      });
      itemId = item.id;
    }
    const r = await api.post('/api/transactions', { item_id: itemId, type: 'receive', quantity: qty });
    toast(`Added ${qty} · now ${r.quantity} on hand`);
    document.getElementById('rcvForm').style.display = 'none';
    document.getElementById('rcvPreview').innerHTML = '';
    const input = document.getElementById('rcvBarcode');
    input.value = ''; input.focus();
    pendingItem = null;
  } catch (err) {
    toast(err.message, true);
  }
});

function previewCard(img, name, brand, src) {
  return `<div class="preview">
    ${img ? `<img src="${escapeAttr(img)}" alt="">` : '<img alt="">'}
    <div><div class="name">${escapeHtml(name || 'Unnamed')}</div>
    <div class="src">${escapeHtml(brand || '')}${brand ? ' · ' : ''}${escapeHtml(src)}</div></div>
  </div>`;
}

// ---- ITEMS ----------------------------------------------------------------
async function loadItems() {
  const items = await api.get('/api/items');
  document.getElementById('itemsTable').innerHTML = items.length
    ? table(['', 'Item', 'Category', 'Location', 'On hand', 'Threshold', 'Barcode'],
        items.map((i) => `<tr class="${i.low ? 'is-low' : ''}">
          <td>${i.image_url ? `<img class="thumb-sm" src="${escapeAttr(i.image_url)}">` : '<span class="thumb-sm"></span>'}</td>
          <td>${escapeHtml(i.name)}${i.low ? ' <span class="pill low">LOW</span>' : ''}<br><small class="src" style="color:var(--muted)">${escapeHtml(i.brand || '')}</small></td>
          <td>${escapeHtml(i.category || '')}</td>
          <td>${escapeHtml(i.location || '')}</td>
          <td class="num">${i.quantity} ${escapeHtml(i.unit || '')}</td>
          <td class="num">${i.low_stock_threshold || '—'}</td>
          <td class="sku">${escapeHtml(i.barcode || '—')}</td>
        </tr>`))
    : '<div class="empty">No items yet. Head to <b>Receive Stock</b> to add your first product.</div>';
}

// ---- TECHS + BADGE PRINTING ----------------------------------------------
async function loadTechs() {
  const users = await api.get('/api/users');
  document.getElementById('techsTable').innerHTML = table(
    ['Name', 'Role', 'Badge', ''],
    users.map((u) => `<tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${u.role}</td>
      <td class="badge-code">${escapeHtml(u.badge_barcode || '—')}</td>
      <td><button class="btn btn-sm" onclick="printBadge('${escapeAttr(u.badge_barcode)}','${escapeAttr(u.name)}')">Print badge</button></td>
    </tr>`)
  );
}

document.getElementById('techAdd').addEventListener('click', async () => {
  const name = val('techNameInput');
  if (!name) return toast('Enter a name', true);
  try {
    const u = await api.post('/api/users', { name, role: val('techRole') });
    document.getElementById('techNameInput').value = '';
    await loadTechs();
    printBadge(u.badge_barcode, u.name);
    toast('Added ' + u.name);
  } catch (err) { toast(err.message, true); }
});

function printBadge(code, name) {
  const area = document.getElementById('badgeArea');
  let svg;
  try {
    svg = Code39.toSVG(code, { height: 70, narrow: 2.4, fontSize: 16 });
  } catch (e) {
    svg = '<p>Cannot render badge for this code.</p>';
  }
  area.innerHTML = `<div class="card badge-print">
    <div class="name">${escapeHtml(name)}</div>
    ${svg}
    <div class="no-print" style="margin-top:14px;">
      <button class="btn btn-sm" onclick="window.print()">Print this badge</button>
    </div>
  </div>`;
  area.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---- LOG ------------------------------------------------------------------
async function loadLog() {
  const rows = await api.get('/api/transactions?limit=300');
  document.getElementById('logTable').innerHTML = rows.length
    ? table(['When', 'Item', 'Tech', 'Movement'], rows.map(txRow))
    : '<div class="empty">No activity yet.</div>';
}

function txRow(t) {
  const dir = (t.type === 'checkout') ? '−' : '+';
  return `<tr>
    <td class="sku">${fmtDate(t.created_at)}</td>
    <td>${escapeHtml(t.item_name || '(deleted)')}</td>
    <td>${escapeHtml(t.user_name || '—')}</td>
    <td><span class="pill ${t.type}">${t.type}</span> <span class="qty">${dir}${t.quantity}</span></td>
  </tr>`;
}

// ---- SETTINGS -------------------------------------------------------------
let pendingLogo; // undefined = unchanged; '' = cleared; data-url = new logo

async function loadSettings() {
  await ensureTaxonomy();
  const s = await api.get('/api/settings');
  fill('setCompany', s.company_name && s.company_name !== 'StockTrax' ? s.company_name : '');
  fill('setTagline', s.brand_tagline || '');
  pendingLogo = undefined;
  renderLogoPreview(s.logo_data_url || '');
  document.getElementById('setProvider').value = s.barcode_provider || 'upcitemdb';
  document.getElementById('setApiKey').placeholder = s.has_barcode_api_key ? '•••••• (saved)' : 'Leave blank for free tier';
  renderChips('catList', categories, 'category');
  renderChips('unitList', units, 'unit');
  renderChips('locationList', locations, 'location');
  refreshAccountStatus();
  document.getElementById('recoveryBox').style.display = 'none';
}

function renderLogoPreview(dataUrl) {
  const box = document.getElementById('logoPreview');
  box.innerHTML = dataUrl
    ? `<img src="${escapeAttr(dataUrl)}" style="max-width:100%;max-height:100%;object-fit:contain;">`
    : '<span style="color:var(--muted); font-size:12px;">No logo</span>';
}

document.getElementById('logoFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('That image is over 2 MB — please use a smaller one', true);
  const reader = new FileReader();
  reader.onload = () => { pendingLogo = reader.result; renderLogoPreview(pendingLogo); };
  reader.readAsDataURL(file);
});
document.getElementById('logoClear').addEventListener('click', () => {
  pendingLogo = '';
  renderLogoPreview('');
  document.getElementById('logoFile').value = '';
});

document.getElementById('setBrandSave').addEventListener('click', async () => {
  const body = {
    company_name: val('setCompany'),
    brand_tagline: val('setTagline'),
  };
  if (pendingLogo !== undefined) body.logo_data_url = pendingLogo;
  await api.put('/api/settings', body);
  toast('Branding saved — reloading to apply');
  setTimeout(() => location.reload(), 800); // re-run branding.js across the app
});

document.getElementById('setSave').addEventListener('click', async () => {
  const body = { barcode_provider: val('setProvider') };
  const key = val('setApiKey');
  if (key) body.barcode_api_key = key;
  await api.put('/api/settings', body);
  toast('Lookup settings saved');
});
document.getElementById('addCat').addEventListener('click', async () => {
  const name = val('newCat'); if (!name) return;
  await api.post('/api/categories', { name });
  categories = await api.get('/api/categories');
  document.getElementById('newCat').value = '';
  renderChips('catList', categories, 'category');
});
document.getElementById('addUnit').addEventListener('click', async () => {
  const name = val('newUnit'); if (!name) return;
  await api.post('/api/units', { name });
  units = await api.get('/api/units');
  document.getElementById('newUnit').value = '';
  renderChips('unitList', units, 'unit');
});
document.getElementById('addLocation').addEventListener('click', async () => {
  const name = val('newLocation'); if (!name) return;
  try {
    await api.post('/api/locations', { name });
    locations = await api.get('/api/locations');
    document.getElementById('newLocation').value = '';
    renderChips('locationList', locations, 'location');
  } catch (e) { toast(e.message, true); }
});
function renderChips(elId, rows, label) {
  document.getElementById(elId).innerHTML = rows.length
    ? rows.map((r) => `<span class="pill adjustment" style="margin:0 6px 6px 0;">${escapeHtml(r.name)}</span>`).join('')
    : `<div class="empty" style="padding:12px;">No ${label}s yet.</div>`;
}

// ---- REPORTS --------------------------------------------------------------
function loadReports() {
  // Default to the current month on first open.
  if (!document.getElementById('repFrom').value) presetThisMonth();
}
function fmtYMD(d) {
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}
function setRange(from, to) {
  document.getElementById('repFrom').value = fmtYMD(from);
  document.getElementById('repTo').value = fmtYMD(to);
  runReport();
}
function presetThisWeek() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const mon = new Date(now); mon.setDate(now.getDate() - dow);
  setRange(mon, now);
}
function presetThisMonth() {
  const now = new Date();
  setRange(new Date(now.getFullYear(), now.getMonth(), 1), now);
}
function presetLastMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  setRange(first, last);
}
document.getElementById('repThisWeek').addEventListener('click', presetThisWeek);
document.getElementById('repThisMonth').addEventListener('click', presetThisMonth);
document.getElementById('repLastMonth').addEventListener('click', presetLastMonth);
document.getElementById('repView').addEventListener('click', runReport);
document.getElementById('repDownload').addEventListener('click', () => {
  const q = reportQuery();
  if (!q) return;
  window.location = '/api/report.csv?' + q;
});
function reportQuery() {
  const from = document.getElementById('repFrom').value;
  const to = document.getElementById('repTo').value;
  if (!from || !to) { toast('Pick a start and end date', true); return null; }
  // Convert the admin's LOCAL day selection into absolute UTC instants so the
  // report matches their own calendar. End is the start of the day AFTER `to`.
  const startIso = new Date(from + 'T00:00:00').toISOString();
  const endLocal = new Date(to + 'T00:00:00');
  endLocal.setDate(endLocal.getDate() + 1);
  const endIso = endLocal.toISOString();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return 'from=' + encodeURIComponent(startIso) +
         '&to=' + encodeURIComponent(endIso) +
         '&tz=' + encodeURIComponent(tz) +
         '&label=' + encodeURIComponent(from + '_to_' + to);
}
async function runReport() {
  const q = reportQuery();
  if (!q) return;
  const r = await api.get('/api/report/summary?' + q);
  const el = document.getElementById('repResults');
  if (!r.count) { el.innerHTML = '<div class="card"><div class="empty">No activity in this date range.</div></div>'; return; }
  el.innerHTML =
    '<div class="grid stats">' +
      stat(r.byType.receive || 0, 'Units received') +
      stat(r.byType.checkout || 0, 'Units taken') +
      stat(r.byType.return || 0, 'Units returned') +
      stat(r.count, 'Total movements') +
    '</div>' +
    '<div class="card"><h3>By item</h3>' +
      table(['Item', 'Received', 'Taken', 'Returned'],
        r.byItem.map((i) => `<tr><td>${escapeHtml(i.item)}</td><td class="num">${i.received}</td><td class="num">${i.taken}</td><td class="num">${i.returned}</td></tr>`)) +
    '</div>' +
    '<div class="card"><h3>Taken by tech</h3>' +
      (r.byTech.length
        ? table(['Tech', 'Units taken'], r.byTech.map((t) => `<tr><td>${escapeHtml(t.tech)}</td><td class="num">${t.taken}</td></tr>`))
        : '<div class="empty">No checkouts in this range.</div>') +
    '</div>';
}

// ---- table + util ---------------------------------------------------------
function table(headers, rows) {
  const head = headers.map((h) => `<th class="${h === 'On hand' || h === 'Threshold' ? 'num' : ''}">${h}</th>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function val(id) { return document.getElementById(id).value.trim(); }
function fill(id, v) { document.getElementById(id).value = v == null ? '' : v; }
function numOrNull(id) { const v = document.getElementById(id).value; return v ? Number(v) : null; }

function fmtDate(s) {
  // SQLite gives 'YYYY-MM-DD HH:MM:SS' in UTC; show local short form.
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

let toastTimer;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---- account & security ---------------------------------------------------
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api.post('/api/logout', {}); } catch (e) { /* ignore */ }
  location.href = '/login.html';
});

document.getElementById('pwSave').addEventListener('click', async () => {
  const current_password = document.getElementById('pwCurrent').value;
  const new_password = document.getElementById('pwNew').value;
  if (new_password.length < 8) return toast('New password must be at least 8 characters', true);
  try {
    await api.post('/api/account/password', { current_password, new_password });
    document.getElementById('pwCurrent').value = '';
    document.getElementById('pwNew').value = '';
    toast('Password changed');
  } catch (e) { toast(e.message, true); }
});

document.getElementById('genRecovery').addEventListener('click', async () => {
  try {
    const r = await api.post('/api/account/recovery-code', {});
    document.getElementById('recoveryCode').textContent = r.recovery_code;
    document.getElementById('recoveryBox').style.display = 'block';
    document.getElementById('recoveryStatus').innerHTML = '<b>A recovery code is set.</b>';
  } catch (e) { toast(e.message, true); }
});

async function refreshAccountStatus() {
  try {
    const a = await api.get('/api/account');
    document.getElementById('recoveryStatus').innerHTML = a.recovery_set
      ? '<b>A recovery code is already set.</b> Generating a new one replaces it.'
      : '<b style="color:var(--signal);">No recovery code yet — set one up now.</b>';
  } catch (e) { /* ignore */ }
}

// ---- session guard + init -------------------------------------------------
(async function init() {
  try {
    const me = await api.get('/api/me'); // 401 if not signed in
    document.getElementById('whoName').textContent = me.name || 'Admin';
    loadDashboard();
    refreshAccountStatus();
  } catch (e) {
    location.href = '/login.html';
  }
})();
