'use strict';

let categories = [];
let units = [];
let locations = [];

// ---- office context -------------------------------------------------------
// When multi-office is on, the header switcher picks which office the console
// is looking at ('all' or an office id). Remembered per browser.
let multi = false;
let offices = [];          // active + inactive
let mainOffice = null;
let officeView = 'all';
let labelPrefs = { size: 'sheet', showName: false };
let companyName = '';

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

async function loadOffices() {
  const r = await api.get('/api/offices');
  multi = !!r.enabled;
  offices = r.offices;
  mainOffice = offices.find((o) => o.is_main) || offices[0] || null;
  document.body.classList.toggle('multi', multi);
  const sw = document.getElementById('officeSwitch');
  sw.hidden = !multi;
  if (multi) {
    const saved = lsGet('stocktrax.office') || 'all';
    officeView = saved === 'all' || activeOffices().some((o) => String(o.id) === saved) ? saved : 'all';
    document.getElementById('officeSel').innerHTML =
      '<option value="all">All offices</option>' +
      activeOffices().map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    document.getElementById('officeSel').value = officeView;
  } else {
    officeView = mainOffice ? String(mainOffice.id) : 'all';
  }
}
function activeOffices() { return offices.filter((o) => o.active); }
function officeById(id) { return offices.find((o) => String(o.id) === String(id)); }
// Query-string fragment for the current view ('' in single-office mode).
function officeQS(prefix) {
  if (!multi) return '';
  return (prefix || '?') + 'office_id=' + encodeURIComponent(officeView);
}
// The specific office an action applies to (main when viewing "all").
function workOffice() {
  if (!multi) return mainOffice ? mainOffice.id : null;
  return officeView !== 'all' ? Number(officeView) : (mainOffice ? mainOffice.id : null);
}
function viewingAll() { return multi && officeView === 'all'; }
function officeOptions(selected, withAll) {
  return (withAll ? '<option value="all">All offices</option>' : '') +
    activeOffices().map((o) => `<option value="${o.id}"${String(o.id) === String(selected) ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('');
}
function officeLabel() {
  if (!multi) return '';
  return viewingAll() ? 'All offices' : (officeById(officeView) || {}).name || '';
}

document.getElementById('officeSel').addEventListener('change', (e) => {
  officeView = e.target.value;
  lsSet('stocktrax.office', officeView);
  const active = document.querySelector('#nav button.active');
  loadTab(active ? active.dataset.tab : 'dashboard');
});

async function loadLabelPrefs() {
  try {
    const s = await api.get('/api/settings');
    labelPrefs = { size: s.label_size || 'sheet', showName: s.label_show_name === '1' };
    companyName = s.company_name && s.company_name !== 'StockTrax' ? s.company_name : '';
  } catch (e) { /* keep defaults */ }
}

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
function locationsFor(officeId) {
  return locations.filter((l) => String(l.office_id) === String(officeId));
}
function optionList(rows, selected) {
  return ['<option value="">—</option>']
    .concat(rows.map((r) =>
      `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${escapeHtml(r.name)}</option>`))
    .join('');
}

// ---- DASHBOARD ------------------------------------------------------------
let lastLow = [];
async function loadDashboard() {
  const d = await api.get('/api/dashboard' + officeQS());
  lastLow = d.lowStock;
  document.querySelector('#dashboard .page-sub').textContent =
    multi ? 'Current stock at a glance — ' + officeLabel() + '.' : 'Current stock at a glance.';
  document.getElementById('stats').innerHTML =
    stat(d.totals.items, 'Distinct items') +
    stat(d.totals.units, 'Total units on hand') +
    stat(d.lowStock.length, 'Low-stock items');

  const banner = document.getElementById('lowBanner');
  banner.innerHTML = d.lowStock.length
    ? `<div class="banner"><span class="dot"></span> ${d.lowStock.length} item${d.lowStock.length > 1 ? 's' : ''} at or below the low-stock threshold.</div>`
    : '';

  const showOffice = viewingAll();
  document.getElementById('lowTable').innerHTML = d.lowStock.length
    ? table((showOffice ? ['Office'] : []).concat(['Item', 'Category', 'Room', 'On hand', 'Threshold']),
        d.lowStock.map((i) => `<tr class="is-low">${showOffice ? `<td>${escapeHtml(i.office)}</td>` : ''}<td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.category || '')}</td><td>${escapeHtml(i.location || '')}</td><td class="num">${i.quantity}</td><td class="num">${i.low_stock_threshold}</td></tr>`))
    : '<div class="empty">Everything is above its threshold. 👍</div>';
  document.getElementById('printLow').disabled = !d.lowStock.length;

  document.getElementById('recentTable').innerHTML = d.recent.length
    ? table(txHeaders(), d.recent.map(txRow))
    : '<div class="empty">No activity yet.</div>';
}
function stat(n, l) { return `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`; }

// ---- RECEIVE --------------------------------------------------------------
let pendingItem = null;   // set when a known item was scanned (add-qty path)

function rcvOffice() {
  return multi ? Number(document.getElementById('rcvOffice').value) || workOffice() : workOffice();
}
async function loadReceive() {
  await ensureTaxonomy();
  document.getElementById('rcvCategory').innerHTML = optionList(categories);
  document.getElementById('rcvUnit').innerHTML = optionList(units);
  if (multi) document.getElementById('rcvOffice').innerHTML = officeOptions(workOffice());
  document.getElementById('rcvLocation').innerHTML = optionList(locationsFor(rcvOffice()));
  document.getElementById('rcvForm').style.display = 'none';
  document.getElementById('rcvPreview').innerHTML = '';
  pendingItem = null;
  const input = document.getElementById('rcvBarcode');
  input.value = '';
  input.focus();
  document.getElementById('rcvLabelArea').innerHTML = '';
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
  document.getElementById('rcvLabelArea').innerHTML = '';
  preview.innerHTML = '<div class="preview">Looking up…</div>';
  pendingItem = null;

  let res;
  try {
    res = await api.get('/api/lookup/' + encodeURIComponent(code) + '?office_id=' + rcvOffice());
  } catch (err) {
    res = { found: 'error', error: err.message };
  }

  form.style.display = 'block';
  document.getElementById('rcvName').dataset.barcode = code;

  if (res.found === 'local') {
    // Known item — just adding quantity.
    pendingItem = res.item;
    preview.innerHTML = previewCard(res.item.image_url, res.item.name, res.item.brand,
      `Already in catalog · ${res.item.quantity} on hand` + (multi ? ' at ' + ((officeById(rcvOffice()) || {}).name || '') : ''));
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
        office_id: rcvOffice(),
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
        office_id: rcvOffice(),
      });
      itemId = item.id;
    }
    const r = await api.post('/api/transactions', { item_id: itemId, type: 'receive', quantity: qty, office_id: rcvOffice() });
    toast(`Added ${qty} · now ${r.quantity} on hand`);
    document.getElementById('rcvForm').style.display = 'none';
    document.getElementById('rcvPreview').innerHTML = '';
    // For a newly created item that has a barcode, offer a printable label
    // (especially useful for the auto-generated STK-##### codes).
    if (!pendingItem && barcode) {
      printLabel(barcode, val('rcvName'), 'rcvLabelArea', 'item');
    }
    const input = document.getElementById('rcvBarcode');
    input.value = ''; input.focus();
    pendingItem = null;
  } catch (err) {
    toast(err.message, true);
  }
});

// Switching the receiving office: refresh its rooms and re-check the barcode.
document.getElementById('rcvOffice').addEventListener('change', async () => {
  document.getElementById('rcvLocation').innerHTML = optionList(locationsFor(rcvOffice()));
  const code = document.getElementById('rcvBarcode').value.trim();
  if (code && document.getElementById('rcvForm').style.display !== 'none') await doLookup(code);
});

// Cancel the receive form without saving.
document.getElementById('rcvCancel').addEventListener('click', () => {
  document.getElementById('rcvForm').style.display = 'none';
  document.getElementById('rcvPreview').innerHTML = '';
  document.getElementById('rcvLabelArea').innerHTML = '';
  const input = document.getElementById('rcvBarcode');
  input.value = ''; input.focus();
  pendingItem = null;
});

// Generate an in-house barcode for stock that has none.
document.getElementById('rcvGenBarcode').addEventListener('click', async () => {
  try {
    const { barcode } = await api.get('/api/items/next-barcode');
    document.getElementById('rcvBarcode').value = barcode;
    await doLookup(barcode); // new code -> shows the manual entry form
    toast('Generated ' + barcode + ' — fill in the details');
  } catch (e) { toast(e.message, true); }
});

function previewCard(img, name, brand, src) {
  return `<div class="preview">
    ${img ? `<img src="${escapeAttr(img)}" alt="">` : '<img alt="">'}
    <div><div class="name">${escapeHtml(name || 'Unnamed')}</div>
    <div class="src">${escapeHtml(brand || '')}${brand ? ' · ' : ''}${escapeHtml(src)}</div></div>
  </div>`;
}

// ---- ITEMS ----------------------------------------------------------------
let itemsById = {};

async function loadItems() {
  await ensureTaxonomy(); // so the Edit modal's category/unit/location dropdowns populate
  const includeInactive = document.getElementById('showInactive') && document.getElementById('showInactive').checked;
  const qs = [];
  if (includeInactive) qs.push('include_inactive=1');
  if (multi) qs.push('office_id=' + encodeURIComponent(officeView));
  const items = await api.get('/api/items' + (qs.length ? '?' + qs.join('&') : ''));
  document.querySelector('#items .page-sub').textContent = multi
    ? 'Everything in the catalog and how much is on hand — ' + officeLabel() + '.'
    : 'Everything in the catalog and how much is on hand.';
  itemsById = {};
  items.forEach((i) => { itemsById[i.id] = i; });
  document.getElementById('itemsTable').innerHTML = items.length
    ? table(['', 'Item', 'Category', 'Location', 'On hand', 'Threshold', 'Barcode', ''],
        items.map((i) => `<tr class="${i.low ? 'is-low' : ''}" style="${i.active ? '' : 'opacity:.55;'}">
          <td>${i.image_url ? `<img class="thumb-sm" src="${escapeAttr(i.image_url)}">` : '<span class="thumb-sm"></span>'}</td>
          <td>${escapeHtml(i.name)}${i.low ? ' <span class="pill low">LOW</span>' : ''}${i.active ? '' : ' <span class="pill adjustment">inactive</span>'}<br><small class="src" style="color:var(--muted)">${escapeHtml(i.brand || '')}</small></td>
          <td>${escapeHtml(i.category || '')}</td>
          <td>${viewingAll() ? '<span style="color:var(--muted)">—</span>' : escapeHtml(i.location || '')}</td>
          <td class="num">${i.quantity} ${escapeHtml(i.unit || '')}${viewingAll() ? stockBreak(i.stock) : ''}</td>
          <td class="num">${viewingAll() ? '—' : (i.low_stock_threshold || '—')}</td>
          <td class="sku">${escapeHtml(i.barcode || '—')}</td>
          <td><div class="item-actions">
            <button class="btn btn-sm" onclick="editItem(${i.id})">Edit</button>
            <button class="btn btn-sm" onclick="adjustItem(${i.id})">Adjust</button>
            ${multi ? `<button class="btn btn-sm" onclick="transferItem(${i.id})">Transfer</button>` : ''}
            ${i.barcode ? `<button class="btn btn-sm" onclick="labelItem(${i.id})">Label</button>` : ''}
            <button class="btn btn-sm" onclick="toggleItemActive(${i.id})">${i.active ? 'Deactivate' : 'Reactivate'}</button>
          </div></td>
        </tr>`))
    : '<div class="empty">No items yet. Head to <b>Receive Stock</b> to add your first product.</div>';
}

document.getElementById('showInactive').addEventListener('change', loadItems);
document.getElementById('itemsExport').addEventListener('click', () => { window.location = '/api/items.csv' + officeQS(); });

function stockBreak(stock) {
  if (!stock || !stock.length) return '';
  return stock.map((s) => `<span class="stock-break${s.low ? ' low' : ''}">${escapeHtml(s.office)}: ${s.quantity}${s.low ? ' · LOW' : ''}</span>`).join('');
}

// Per-office stock for one item, keyed by office id.
async function itemStock(id) {
  const rows = await api.get('/api/items/' + id + '/stock');
  const map = {};
  rows.forEach((r) => { map[r.office_id] = r; });
  return map;
}

async function editItem(id) {
  const i = itemsById[id];
  let stock = null;
  let edOffice = workOffice();
  if (multi) { try { stock = await itemStock(id); } catch (e) { return toast(e.message, true); } }
  const cur = stock && stock[edOffice] ? stock[edOffice] : { low_stock_threshold: i.low_stock_threshold, location_id: i.location_id };
  openModal(`
    <h3>Edit item</h3>
    ${multi ? `<div class="field"><label>Office (for low-stock alert and room)</label><select id="edOffice">${officeOptions(edOffice)}</select></div>` : ''}
    <div class="row"><div class="field"><label>Name</label><input id="edName" value="${escapeAttr(i.name)}"></div>
      <div class="field"><label>Brand</label><input id="edBrand" value="${escapeAttr(i.brand || '')}"></div></div>
    <div class="row"><div class="field"><label>Category</label><select id="edCategory">${optionList(categories, i.category_id)}</select></div>
      <div class="field"><label>Unit</label><select id="edUnit">${optionList(units, i.unit_id)}</select></div>
      <div class="field"><label>Room</label><select id="edLocation">${optionList(locationsFor(edOffice), cur.location_id)}</select></div></div>
    <div class="row"><div class="field mono"><label>Barcode</label><input id="edBarcode" value="${escapeAttr(i.barcode || '')}"></div>
      <div class="field mono"><label>Low-stock alert at</label><input id="edThreshold" type="number" min="0" value="${cur.low_stock_threshold || 0}"></div></div>
    <div class="field"><label>Image URL</label><input id="edImage" value="${escapeAttr(i.image_url || '')}"></div>
    <div class="field"><label>Notes</label><input id="edNotes" value="${escapeAttr(i.notes || '')}"></div>
    <p style="color:var(--muted);font-size:12px;margin:0;">To change the on-hand quantity, use <b>Adjust</b> instead — it keeps an audit record.</p>
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveEdit(${id})">Save changes</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  `);
  if (multi) {
    document.getElementById('edOffice').addEventListener('change', (e) => {
      const o = e.target.value;
      const s = stock[o] || { low_stock_threshold: i.low_stock_threshold, location_id: null };
      document.getElementById('edThreshold').value = s.low_stock_threshold || 0;
      document.getElementById('edLocation').innerHTML = optionList(locationsFor(o), s.location_id);
    });
  }
}
async function saveEdit(id) {
  try {
    await api.patch('/api/items/' + id, {
      office_id: multi ? Number(document.getElementById('edOffice').value) : undefined,
      name: document.getElementById('edName').value.trim(),
      brand: document.getElementById('edBrand').value.trim() || null,
      category_id: numOrNull('edCategory'),
      unit_id: numOrNull('edUnit'),
      location_id: numOrNull('edLocation'),
      barcode: document.getElementById('edBarcode').value.trim() || null,
      low_stock_threshold: Number(document.getElementById('edThreshold').value) || 0,
      image_url: document.getElementById('edImage').value.trim() || null,
      notes: document.getElementById('edNotes').value.trim() || null,
    });
    closeModal(); await loadItems(); toast('Item updated');
  } catch (e) { toast(e.message, true); }
}

async function adjustItem(id) {
  const i = itemsById[id];
  let stock = null;
  const o = workOffice();
  if (multi) { try { stock = await itemStock(id); } catch (e) { return toast(e.message, true); } }
  const qty = stock ? (stock[o] ? stock[o].quantity : 0) : i.quantity;
  openModal(`
    <h3>Adjust stock — ${escapeHtml(i.name)}</h3>
    ${multi ? `<div class="field" style="max-width:320px;"><label>Office</label><select id="adjOffice">${officeOptions(o)}</select></div>` : ''}
    <p style="color:var(--muted);font-size:13px;margin-top:-8px;">Current on hand: <b id="adjCur">${qty}</b> ${escapeHtml(i.unit || '')}. Enter the corrected count and (optionally) why.</p>
    <div class="field mono" style="max-width:220px;"><label>New on-hand count</label><input id="adjCount" type="number" min="0" value="${qty}"></div>
    <div class="field"><label>Reason (optional)</label><input id="adjNote" placeholder="e.g. physical recount, breakage"></div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveAdjust(${id})">Save adjustment</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  `);
  if (multi) {
    document.getElementById('adjOffice').addEventListener('change', (e) => {
      const q = stock[e.target.value] ? stock[e.target.value].quantity : 0;
      document.getElementById('adjCur').textContent = q;
      document.getElementById('adjCount').value = q;
    });
  }
}
async function saveAdjust(id) {
  const count = Number(document.getElementById('adjCount').value);
  if (!Number.isInteger(count) || count < 0) return toast('Enter a whole number of 0 or more', true);
  try {
    const r = await api.post('/api/items/' + id + '/adjust', {
      count, note: document.getElementById('adjNote').value.trim(),
      office_id: multi ? Number(document.getElementById('adjOffice').value) : undefined,
    });
    closeModal(); await loadItems(); toast(`Adjusted to ${r.quantity} (was ${r.was})`);
  } catch (e) { toast(e.message, true); }
}

async function toggleItemActive(id) {
  const i = itemsById[id];
  const makeInactive = !!i.active;
  if (makeInactive && !confirm(`Deactivate "${i.name}"? It'll be hidden from the kiosk and item list, but its history is kept and you can reactivate it later.`)) return;
  try {
    await api.patch('/api/items/' + id, { active: makeInactive ? 0 : 1 });
    await loadItems();
    toast(makeInactive ? 'Item deactivated' : 'Item reactivated');
  } catch (e) { toast(e.message, true); }
}

// Move stock between offices.
async function transferItem(id) {
  const i = itemsById[id];
  let stock;
  try { stock = await itemStock(id); } catch (e) { return toast(e.message, true); }
  const act = activeOffices();
  if (act.length < 2) return toast('Add a second office in Settings first', true);
  const from = workOffice();
  const to = (act.find((o) => o.id !== from) || {}).id;
  const qtyAt = (o) => (stock[o] ? stock[o].quantity : 0);
  openModal(`
    <h3>Transfer — ${escapeHtml(i.name)}</h3>
    <div class="row">
      <div class="field"><label>From</label><select id="trFrom">${officeOptions(from)}</select><small id="trFromQty" style="color:var(--muted)"></small></div>
      <div class="field"><label>To</label><select id="trTo">${officeOptions(to)}</select><small id="trToQty" style="color:var(--muted)"></small></div>
    </div>
    <div class="row">
      <div class="field mono" style="max-width:180px;"><label>Quantity</label><input id="trQty" type="number" min="1" value="1"></div>
      <div class="field"><label>Note (optional)</label><input id="trNote" placeholder="e.g. restock for weekend jobs"></div>
    </div>
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveTransfer(${id})">Transfer stock</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  `);
  const show = () => {
    document.getElementById('trFromQty').textContent = qtyAt(document.getElementById('trFrom').value) + ' on hand';
    document.getElementById('trToQty').textContent = qtyAt(document.getElementById('trTo').value) + ' on hand';
  };
  document.getElementById('trFrom').addEventListener('change', show);
  document.getElementById('trTo').addEventListener('change', show);
  show();
}
async function saveTransfer(id) {
  const quantity = Number(document.getElementById('trQty').value);
  if (!Number.isInteger(quantity) || quantity <= 0) return toast('Enter a whole number of 1 or more', true);
  try {
    await api.post('/api/items/' + id + '/transfer', {
      from_office_id: Number(document.getElementById('trFrom').value),
      to_office_id: Number(document.getElementById('trTo').value),
      quantity, note: document.getElementById('trNote').value.trim(),
    });
    closeModal(); await loadItems(); toast('Moved ' + quantity);
  } catch (e) { toast(e.message, true); }
}

function labelItem(id) {
  const i = itemsById[id];
  printLabel(i.barcode, i.name, 'itemLabelArea');
}

// ---- modal helpers --------------------------------------------------------
function openModal(html) {
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('show');
}
function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  document.getElementById('modalBox').innerHTML = '';
}
document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});

// ---- printable barcode labels (items and badges) -------------------------
// All printing goes through Print (public/js/print.js), which prints from an
// isolated hidden frame — so only the label/sheet prints, never this page.

// Show an on-screen preview card with a Print button.
//   kind 'item'  -> follows the Label printing settings (size, name on/off)
//   kind 'badge' -> always includes the tech's name
function printLabel(code, title, areaId, kind) {
  const area = document.getElementById(areaId);
  let svg;
  try {
    svg = Code39.toSVG(code, { height: 70, narrow: 2.4, fontSize: 16 });
  } catch (e) {
    svg = '<p>Cannot render a barcode for this code.</p>';
  }
  area.innerHTML = `<div class="card badge-print">
    <div class="name">${escapeHtml(title)}</div>
    ${svg}
    <div class="no-print" style="margin-top:14px;">
      <button class="btn btn-sm print-label-btn" data-kind="${kind || 'item'}" data-code="${escapeAttr(code)}" data-title="${escapeAttr(title)}">Print this label</button>
    </div>
  </div>`;
  area.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function doPrintLabel(code, title, kind) {
  if (kind === 'badge') {
    Print.labels([{ code, name: title }], { size: labelPrefs.size, showName: true, title });
  } else {
    Print.labels([{ code, name: title }], { size: labelPrefs.size, showName: labelPrefs.showName, title });
  }
}

// Delegated handler so any Print button prints its own label in isolation.
document.addEventListener('click', (e) => {
  const b = e.target.closest('.print-label-btn');
  if (b) doPrintLabel(b.dataset.code, b.dataset.title, b.dataset.kind);
});

// Shared header for printed reports (company, office, date).
function printHeader(title, sub) {
  const o = multi && !viewingAll() ? officeById(officeView) : (!multi ? mainOffice : null);
  const addr = o ? [o.address_line1, o.address_line2, [o.city, o.state].filter(Boolean).join(', ') + (o.zip ? ' ' + o.zip : '')]
    .filter((x) => x && x.trim()).join(' · ') : '';
  const contact = o ? [o.phone, o.email].filter(Boolean).join(' · ') : '';
  const printed = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="ph">
    <div><div class="co">${escapeHtml(companyName || (o && o.name) || 'StockTrax')}</div>
      ${multi ? `<div class="of">${escapeHtml(viewingAll() ? 'All offices' : o.name)}</div>` : ''}
      ${addr ? `<div class="ad">${escapeHtml(addr)}</div>` : ''}
      ${contact ? `<div class="ad">${escapeHtml(contact)}</div>` : ''}</div>
    <div style="text-align:right;"><div class="tt">${escapeHtml(title)}</div><div class="ad">${escapeHtml(sub || '')}</div><div class="ad">Printed ${escapeHtml(printed)}</div></div>
  </div>`;
}
const REPORT_CSS = `
  @page { size: letter; margin: 0.5in; }
  .ph { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
  .co { font-size: 15pt; font-weight: 800; }
  .of { font-size: 11pt; font-weight: 700; }
  .tt { font-size: 14pt; font-weight: 800; }
  .ad { font-size: 9pt; color: #333; }
  h2 { font-size: 12pt; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #bbb; vertical-align: top; }
  th { font-size: 8pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1.5px solid #000; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.box { width: 0.7in; border-bottom: 1px solid #000; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  small { color: #444; }
  .foot { margin-top: 10px; font-size: 8.5pt; color: #444; }
`;

// ---- LOW STOCK: printable reorder list ------------------------------------
function printLowStock() {
  if (!lastLow.length) return toast('Nothing is low right now', true);
  const groups = {};
  lastLow.forEach((r) => { (groups[r.office] = groups[r.office] || []).push(r); });
  const showGroups = viewingAll() && Object.keys(groups).length > 0;
  const tableFor = (rows) => `<table><thead><tr>
      <th>Item</th><th>Barcode</th><th>Room</th><th class="num">On hand</th><th class="num">Alert at</th><th class="num">Order qty</th><th>Ordered ✓</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td><b>${escapeHtml(r.name)}</b>${r.brand ? `<br><small>${escapeHtml(r.brand)}</small>` : ''}</td>
      <td class="mono">${escapeHtml(r.barcode || '')}</td>
      <td>${escapeHtml(r.location || '')}</td>
      <td class="num">${r.quantity} ${escapeHtml(r.unit || '')}</td>
      <td class="num">${r.low_stock_threshold}</td>
      <td class="box"></td><td class="box"></td>
    </tr>`).join('')}</tbody></table>`;
  const body = printHeader('Reorder list', lastLow.length + ' item' + (lastLow.length > 1 ? 's' : '') + ' at or below alert level') +
    (showGroups
      ? Object.entries(groups).map(([office, rows]) => `<h2>${escapeHtml(office)}</h2>` + tableFor(rows)).join('')
      : tableFor(lastLow)) +
    '<div class="foot">Ordered by: ____________________ &nbsp; Date: ____________ &nbsp; Supplier / PO #: ____________________</div>';
  Print.html(body, { title: 'Reorder list', css: REPORT_CSS });
}
document.getElementById('printLow').addEventListener('click', printLowStock);

// ---- TECHS + BADGE PRINTING ----------------------------------------------
let techUsers = [];
async function loadTechs() {
  const users = await api.get('/api/users');
  techUsers = users;
  if (multi) document.getElementById('techOffice').innerHTML = officeOptions(workOffice());
  const shown = multi && !viewingAll() ? users.filter((u) => String(u.office_id) === String(officeView)) : users;
  document.getElementById('techsTable').innerHTML = shown.length ? table(
    ['Name', 'Role'].concat(multi ? ['Home office'] : [], ['Badge', '']),
    shown.map((u) => `<tr>
      <td>${escapeHtml(u.name)}</td>
      <td>${u.role}</td>
      ${multi ? `<td><select class="tech-office" data-id="${u.id}" style="padding:6px 8px;border:1px solid var(--line);border-radius:8px;">${officeOptions(u.office_id)}</select></td>` : ''}
      <td class="badge-code">${escapeHtml(u.badge_barcode || '—')}</td>
      <td><button class="btn btn-sm" data-badge="${u.id}">Print badge</button></td>
    </tr>`)
  ) : '<div class="empty">No techs at this office yet.</div>';
}
document.getElementById('techsTable').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-badge]');
  if (!b) return;
  const u = techUsers.find((x) => String(x.id) === b.dataset.badge);
  if (u) printBadge(u.badge_barcode, u.name);
});
document.getElementById('techsTable').addEventListener('change', async (e) => {
  const sel = e.target.closest('select.tech-office');
  if (!sel) return;
  try {
    await api.patch('/api/users/' + sel.dataset.id, { office_id: Number(sel.value) });
    toast('Home office updated');
    if (!viewingAll()) loadTechs();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('techAdd').addEventListener('click', async () => {
  const name = val('techNameInput');
  if (!name) return toast('Enter a name', true);
  try {
    const u = await api.post('/api/users', { name, role: val('techRole'), office_id: multi ? Number(val('techOffice')) : undefined });
    document.getElementById('techNameInput').value = '';
    await loadTechs();
    printBadge(u.badge_barcode, u.name);
    toast('Added ' + u.name);
  } catch (err) { toast(err.message, true); }
});

function printBadge(code, name) {
  printLabel(code, name, 'badgeArea', 'badge');
}

// Print every tech's badge, 10 per 8.5x11 sheet (2 columns x 5 rows).
async function printAllBadges() {
  let users;
  try { users = await api.get('/api/users'); } catch (e) { return toast(e.message, true); }
  if (multi && !viewingAll()) users = users.filter((u) => String(u.office_id) === String(officeView));
  const withBadges = users.filter((u) => u.badge_barcode && u.active);
  if (!withBadges.length) return toast('No badges to print yet', true);
  let pages = '';
  for (let i = 0; i < withBadges.length; i += 10) {
    const cells = withBadges.slice(i, i + 10).map((u) => {
      let svg;
      svg = Print.barcodeSvg(u.badge_barcode);
      return `<div class="badge-cell"><div class="bname">${escapeHtml(u.name)}</div>${svg}</div>`;
    }).join('');
    pages += `<div class="badge-page">${cells}</div>`;
  }
  Print.html(pages, { title: 'Badges', css: `
    @page { size: letter; margin: 0.4in; }
    .badge-page { display: grid; grid-template-columns: 1fr 1fr; break-after: page; page-break-after: always; }
    .badge-page:last-child { break-after: auto; page-break-after: auto; }
    .badge-cell { text-align: center; padding: 14px 10px; border: 1px dashed #bbb; height: 1.95in;
                  display: flex; flex-direction: column; align-items: center; justify-content: center;
                  break-inside: avoid; page-break-inside: avoid; }
    .badge-cell .bname { font-weight: 700; font-size: 13pt; margin-bottom: 6px; }
    .badge-cell svg { width: 3in; max-width: 100%; height: auto; }
  ` });
}
document.getElementById('printAllBadges').addEventListener('click', printAllBadges);

// ---- LOG ------------------------------------------------------------------
let logRows = [];
let logFiltered = false;
function logQuery() {
  const q = [];
  const from = document.getElementById('logFrom').value;
  const to = document.getElementById('logTo').value;
  if (from) q.push('from=' + encodeURIComponent(new Date(from + 'T00:00:00').toISOString()));
  if (to) { const e = new Date(to + 'T00:00:00'); e.setDate(e.getDate() + 1); q.push('to=' + encodeURIComponent(e.toISOString())); }
  const type = document.getElementById('logType').value;
  if (type) q.push('type=' + encodeURIComponent(type));
  const tech = document.getElementById('logTech').value;
  if (tech) q.push('user_id=' + encodeURIComponent(tech));
  if (multi) q.push('office_id=' + encodeURIComponent(officeView));
  logFiltered = !!(from || to || type || tech);
  q.push('limit=' + (from || to ? 5000 : 300));
  return q.join('&');
}
async function loadLog() {
  // fill the tech filter once per visit, keeping the current choice
  try {
    const users = await api.get('/api/users');
    const sel = document.getElementById('logTech');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Everyone</option>' + users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    sel.value = keep;
  } catch (e) { /* ignore */ }
  const rows = await api.get('/api/transactions?' + logQuery());
  logRows = rows;
  document.getElementById('logCount').textContent = rows.length
    ? `Showing ${rows.length} movement${rows.length > 1 ? 's' : ''}${logFiltered ? ' matching your filters' : ' (most recent)'}${multi ? ' — ' + officeLabel() : ''}.`
    : '';
  document.getElementById('logTable').innerHTML = rows.length
    ? table(txHeaders(true), rows.map((t) => txRow(t, true)))
    : '<div class="empty">No activity' + (logFiltered ? ' matches these filters.' : ' yet.') + '</div>';
}
document.getElementById('logApply').addEventListener('click', loadLog);
document.getElementById('logClear').addEventListener('click', () => {
  ['logFrom', 'logTo', 'logType', 'logTech'].forEach((id) => { document.getElementById(id).value = ''; });
  loadLog();
});
document.getElementById('logPrint').addEventListener('click', () => {
  if (!logRows.length) return toast('Nothing to print', true);
  const from = document.getElementById('logFrom').value;
  const to = document.getElementById('logTo').value;
  const typeSel = document.getElementById('logType');
  const techSel = document.getElementById('logTech');
  const bits = [];
  if (from || to) bits.push((from || '…') + ' to ' + (to || 'today'));
  if (typeSel.value) bits.push(typeSel.options[typeSel.selectedIndex].text);
  if (techSel.value) bits.push(techSel.options[techSel.selectedIndex].text);
  const showOffice = viewingAll();
  const body = printHeader('Activity log', (bits.join(' · ') || 'Most recent activity') + ' — ' + logRows.length + ' movements') +
    `<table><thead><tr><th>When</th>${showOffice ? '<th>Office</th>' : ''}<th>Item</th><th>Barcode</th><th>Tech</th><th>Movement</th><th class="num">Qty</th><th>Note</th></tr></thead><tbody>` +
    logRows.map((t) => `<tr>
      <td>${escapeHtml(fmtDateLong(t.created_at))}</td>
      ${showOffice ? `<td>${escapeHtml(t.office_name || '')}</td>` : ''}
      <td>${escapeHtml(t.item_name || '(deleted)')}</td>
      <td class="mono">${escapeHtml(t.item_barcode || '')}</td>
      <td>${escapeHtml(t.user_name || '—')}</td>
      <td>${escapeHtml(TYPE_LABEL[t.type] || t.type)}</td>
      <td class="num">${t.type === 'adjustment' ? '=' : DIR_SIGN[t.type] || ''}${t.quantity}</td>
      <td><small>${escapeHtml(t.note || '')}</small></td>
    </tr>`).join('') + '</tbody></table>';
  Print.html(body, { title: 'Activity log', css: REPORT_CSS });
});

const TYPE_LABEL = { checkout: 'Taken', return: 'Returned', receive: 'Received', adjustment: 'Adjusted', transfer_out: 'Transfer out', transfer_in: 'Transfer in' };
const DIR_SIGN = { checkout: '−', transfer_out: '−', return: '+', receive: '+', transfer_in: '+' };
function txHeaders(withNote) {
  return ['When'].concat(viewingAll() ? ['Office'] : [], ['Item', 'Tech', 'Movement'], withNote ? ['Note'] : []);
}
function txRow(t, withNote) {
  const qty = t.type === 'adjustment' ? '=' + t.quantity : (DIR_SIGN[t.type] || '+') + t.quantity;
  return `<tr>
    <td class="sku">${fmtDate(t.created_at)}</td>
    ${viewingAll() ? `<td>${escapeHtml(t.office_name || '')}</td>` : ''}
    <td>${escapeHtml(t.item_name || '(deleted)')}</td>
    <td>${escapeHtml(t.user_name || '—')}</td>
    <td><span class="pill ${t.type}">${escapeHtml(TYPE_LABEL[t.type] || t.type)}</span> <span class="qty">${qty}</span></td>
    ${withNote ? `<td><small style="color:var(--muted)">${escapeHtml(t.note || '')}</small></td>` : ''}
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
  document.getElementById('setTheme').value = s.theme_default === 'light' ? 'light' : 'dark';
  renderChips('catList', categories, 'category');
  renderChips('unitList', units, 'unit');
  document.getElementById('setLabelSize').value = s.label_size || 'sheet';
  document.getElementById('setLabelName').checked = s.label_show_name === '1';
  document.getElementById('multiOfficeToggle').checked = multi;
  if (multi) document.getElementById('newLocationOffice').innerHTML = officeOptions(workOffice());
  renderLocations();
  renderOffices();
  refreshAccountStatus();
  loadAbout();
  document.getElementById('recoveryBox').style.display = 'none';
}

async function loadAbout() {
  try {
    const v = await api.get('/api/version');
    document.getElementById('aboutName').textContent = v.name || 'StockTrax';
    document.getElementById('aboutVersion').textContent = 'v' + v.version;
  } catch (e) { /* ignore */ }
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
    theme_default: document.getElementById('setTheme').value,
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
    await api.post('/api/locations', { name, office_id: multi ? Number(val('newLocationOffice')) : undefined });
    locations = await api.get('/api/locations');
    document.getElementById('newLocation').value = '';
    renderLocations();
  } catch (e) { toast(e.message, true); }
});
function renderLocations() {
  if (!multi) {
    const mine = mainOffice ? locationsFor(mainOffice.id) : locations;
    return renderChips('locationList', mine, 'location');
  }
  const el = document.getElementById('locationList');
  const html = activeOffices().map((o) => {
    const rooms = locationsFor(o.id);
    return `<div style="margin-bottom:8px;"><b style="font-size:13px;">${escapeHtml(o.name)}:</b> ` +
      (rooms.length ? rooms.map((r) => `<span class="pill adjustment" style="margin:0 6px 6px 0;">${escapeHtml(r.name)}</span>`).join('')
                    : '<span style="color:var(--muted);font-size:13px;">no rooms yet</span>') + '</div>';
  }).join('');
  el.innerHTML = html;
}

// ---- label printing settings ----------------------------------------------
document.getElementById('setLabelSave').addEventListener('click', async () => {
  try {
    await api.put('/api/settings', {
      label_size: document.getElementById('setLabelSize').value,
      label_show_name: document.getElementById('setLabelName').checked ? '1' : '0',
    });
    await loadLabelPrefs();
    toast('Label settings saved');
  } catch (e) { toast(e.message, true); }
});
document.getElementById('labelTest').addEventListener('click', () => {
  Print.labels([{ code: 'STK-00001', name: 'Test label' }], {
    size: document.getElementById('setLabelSize').value,
    showName: document.getElementById('setLabelName').checked,
    title: 'Test label',
  });
});

// ---- offices ------------------------------------------------------------
function officeAddress(o) {
  const cityLine = [o.city, o.state].filter(Boolean).join(', ') + (o.zip ? ' ' + o.zip : '');
  return [o.address_line1, o.address_line2, cityLine].filter((x) => x && x.trim()).join(', ');
}
function renderOffices() {
  const el = document.getElementById('officeList');
  const list = multi ? offices : offices.filter((o) => o.is_main);
  el.innerHTML = table(
    ['Office', 'Contact', 'Manager'].concat(multi ? ['Techs', 'Units'] : [], ['']),
    list.map((o) => `<tr style="${o.active ? '' : 'opacity:.55;'}">
      <td><b>${escapeHtml(o.name)}</b> ${o.is_main ? '<span class="pill main">MAIN</span>' : ''}${o.active ? '' : ' <span class="pill adjustment">inactive</span>'}
        <div class="office-addr">${escapeHtml(officeAddress(o)) || '<i>No address yet</i>'}</div></td>
      <td><div>${escapeHtml(o.phone || '')}</div><div class="office-addr">${escapeHtml(o.email || '')}</div></td>
      <td>${escapeHtml(o.manager || '')}</td>
      ${multi ? `<td class="num">${o.tech_count}</td><td class="num">${o.units_on_hand}</td>` : ''}
      <td><div class="item-actions">
        <button class="btn btn-sm" onclick="editOffice(${o.id})">Edit</button>
        ${multi && o.active ? `<button class="btn btn-sm" onclick="kioskLink(${o.id})">Kiosk link</button>` : ''}
      </div></td>
    </tr>`)
  ) + (multi ? '' : '<p style="color:var(--muted);font-size:12px;margin:8px 0 0;">Your office details print at the top of the reorder list and activity log.</p>');
}

document.getElementById('multiOfficeToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (!on) {
    const others = offices.filter((o) => !o.is_main && o.units_on_hand > 0);
    if (others.length && !confirm(
      'Turn off multi-office?\n\nStock at ' + others.map((o) => o.name).join(', ') +
      ' will be hidden (not deleted) and the console will show only ' + (mainOffice ? mainOffice.name : 'the main office') +
      '. Turning it back on brings everything back.')) {
      e.target.checked = true;
      return;
    }
  }
  try {
    await api.put('/api/settings', { multi_office_enabled: on ? '1' : '0' });
    locations = [];
    await loadOffices();
    await ensureTaxonomy();
    loadSettings();
    toast(on ? 'Multi-office is on — add your branch offices below' : 'Multi-office is off');
  } catch (err) { e.target.checked = !on; toast(err.message, true); }
});

document.getElementById('addOffice').addEventListener('click', () => editOffice(null));

function editOffice(id) {
  const o = id ? officeById(id) : { active: 1 };
  const f = (k, label, ph, type) => `<div class="field"><label>${label}</label><input id="of_${k}" type="${type || 'text'}" value="${escapeAttr(o[k] || '')}" placeholder="${escapeAttr(ph || '')}"></div>`;
  openModal(`
    <h3>${id ? 'Edit office' : 'Add office'}</h3>
    ${f('name', 'Office name *', 'e.g. Ashland Branch')}
    ${f('address_line1', 'Street address', '123 Main St')}
    ${f('address_line2', 'Suite / unit (optional)', '')}
    <div class="row">${f('city', 'City', '')}<div class="field" style="max-width:90px;"><label>State</label><input id="of_state" value="${escapeAttr(o.state || '')}" maxlength="20"></div>${f('zip', 'ZIP', '')}</div>
    <div class="row">${f('phone', 'Phone', '(304) 555-0100', 'tel')}${f('email', 'Email', 'branch@yourcompany.com', 'email')}</div>
    <div class="row">${f('manager', 'Office manager', 'Full name')}${f('license_no', 'Business license # (optional)', 'e.g. state pesticide license')}</div>
    <div class="field"><label>Notes (optional)</label><input id="of_notes" value="${escapeAttr(o.notes || '')}" placeholder="Hours, delivery instructions, gate code…"></div>
    ${id && !o.is_main ? `<label class="check-row" style="margin-bottom:8px;"><input type="checkbox" id="of_active" ${o.active ? 'checked' : ''}> <span>Active <small>(inactive offices are hidden from pickers; their history is kept)</small></span></label>
      <label class="check-row"><input type="checkbox" id="of_main"> <span>Make this the main office</span></label>` : ''}
    <div class="modal-actions"><button class="btn btn-primary" onclick="saveOffice(${id || 'null'})">${id ? 'Save office' : 'Add office'}</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>
  `);
}
async function saveOffice(id) {
  const body = {};
  ['name', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'phone', 'email', 'manager', 'license_no', 'notes']
    .forEach((k) => { body[k] = document.getElementById('of_' + k).value.trim(); });
  if (!body.name) return toast('Office name is required', true);
  const act = document.getElementById('of_active');
  if (act) body.active = act.checked;
  const mk = document.getElementById('of_main');
  if (mk && mk.checked) body.is_main = true;
  try {
    if (id) await api.patch('/api/offices/' + id, body);
    else await api.post('/api/offices', body);
    closeModal();
    await loadOffices();
    renderOffices();
    if (multi) document.getElementById('newLocationOffice').innerHTML = officeOptions(workOffice());
    renderLocations();
    toast(id ? 'Office saved' : 'Office added');
  } catch (e) { toast(e.message, true); }
}
function kioskLink(id) {
  const o = officeById(id);
  const link = location.origin + '/kiosk.html?office=' + id;
  openModal(`
    <h3>Kiosk link — ${escapeHtml(o.name)}</h3>
    <p style="color:var(--muted);font-size:13px;margin-top:-6px;">Open this link on the stock-room computer at ${escapeHtml(o.name)} (bookmark it or set it as the browser's home page). Every scan on that kiosk counts against ${escapeHtml(o.name)}'s stock.</p>
    <div class="field mono"><input id="kioskLinkInput" value="${escapeAttr(link)}" readonly></div>
    <p style="color:var(--muted);font-size:12px;">Without an office in the link, the kiosk uses each tech's home office.</p>
    <div class="modal-actions"><button class="btn btn-primary" id="copyKiosk">Copy link</button><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>
  `);
  document.getElementById('copyKiosk').addEventListener('click', async () => {
    const inp = document.getElementById('kioskLinkInput');
    try { await navigator.clipboard.writeText(inp.value); toast('Link copied'); }
    catch (e) { inp.select(); toast('Press Ctrl+C to copy'); }
  });
}
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
  return (multi ? 'office_id=' + encodeURIComponent(officeView) + '&' : '') +
         'from=' + encodeURIComponent(startIso) +
         '&to=' + encodeURIComponent(endIso) +
         '&tz=' + encodeURIComponent(tz) +
         '&label=' + encodeURIComponent((multi && !viewingAll() ? ((officeById(officeView) || {}).name || '') + '_' : '') + from + '_to_' + to);
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

function fmtDateLong(s) {
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
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
    await loadOffices();
    await loadLabelPrefs();
    loadDashboard();
    refreshAccountStatus();
  } catch (e) {
    location.href = '/login.html';
  }
})();
