'use strict';

// ---- state ----------------------------------------------------------------
let currentUser = null;
let mode = 'checkout';           // 'checkout' (Take) or 'return'
let idleTimer = null;
const IDLE_MS = 45000;           // auto sign-out after 45s of no scans

const idleView = document.getElementById('idle');
const sessionView = document.getElementById('session');
const techName = document.getElementById('techName');
const sessionList = document.getElementById('sessionList');
const modeToggle = document.getElementById('modeToggle');
const modeWord = document.getElementById('modeWord');
const toastEl = document.getElementById('toast');

// ---- office ---------------------------------------------------------------
// Multi-office: a kiosk can be pinned to an office with ?office=<id> in its
// URL (Settings → Offices → Kiosk link). Otherwise each tech's scans count
// against their home office.
const pinnedOffice = (() => {
  const v = new URLSearchParams(location.search).get('office');
  return v && /^\d+$/.test(v) ? Number(v) : null;
})();
let multiOffice = false;
let kioskOffice = null;          // { id, name } when pinned
const officeTag = document.getElementById('kioskOffice');
fetch('/api/branding').then((r) => r.json()).then(async (b) => {
  multiOffice = !!b.multi_office;
  if (multiOffice && pinnedOffice) {
    try { kioskOffice = await api.get('/api/kiosk/office/' + pinnedOffice); } catch (e) { kioskOffice = null; }
  }
  showOfficeTag();
}).catch(() => {});
function activeOfficeId() {
  if (!multiOffice) return undefined;
  if (kioskOffice) return kioskOffice.id;
  return currentUser && currentUser.office_id ? currentUser.office_id : undefined;
}
function showOfficeTag() {
  if (!officeTag) return;
  let name = '';
  if (multiOffice) name = kioskOffice ? kioskOffice.name : (currentUser && currentUser.office) || '';
  officeTag.textContent = name;
  officeTag.style.display = name ? '' : 'none';
}

// ---- scanner capture (keyboard wedge) -------------------------------------
// A USB scanner "types" the barcode then presses Enter. We buffer printable
// keys and process the whole string on Enter. Works no matter what's focused.
let buffer = '';
let lastKey = 0;

document.addEventListener('keydown', (e) => {
  const now = Date.now();
  // If a big gap between keys, assume a fresh scan (a human typing is slower,
  // but this page has no other inputs so buffering is safe).
  if (now - lastKey > 120) buffer = '';
  lastKey = now;

  if (e.key === 'Enter') {
    const code = buffer.trim();
    buffer = '';
    if (code) handleScan(code);
    e.preventDefault();
    return;
  }
  if (e.key.length === 1) buffer += e.key; // printable char
});

// ---- routing a scan -------------------------------------------------------
async function handleScan(code) {
  resetIdle();
  if (!currentUser) {
    await loginByBadge(code);
  } else {
    await scanItem(code);
  }
}

async function loginByBadge(code) {
  try {
    const user = await api.get('/api/users/badge/' + encodeURIComponent(code));
    currentUser = user;
    techName.textContent = user.name;
    showOfficeTag();
    sessionList.innerHTML = '';
    setMode('checkout');
    showSession(true);
    toast('Welcome, ' + user.name);
  } catch (err) {
    toast('Badge not recognized', true);
  }
}

async function scanItem(code) {
  let item;
  try {
    const oid = activeOfficeId();
    item = await api.get('/api/items/barcode/' + encodeURIComponent(code) + (oid ? '?office_id=' + oid : ''));
  } catch (err) {
    toast('Item not in catalog. See an admin to add it.', true);
    return;
  }
  try {
    const result = await api.post('/api/transactions', {
      item_id: item.id,
      user_id: currentUser.id,
      type: mode,
      quantity: 1,
      office_id: activeOfficeId(),
    });
    addSessionRow(item, mode, result);
    toast((mode === 'checkout' ? 'Took ' : 'Returned ') + item.name);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- session list ---------------------------------------------------------
function addSessionRow(item, txMode, result) {
  const li = document.createElement('li');
  const sign = txMode === 'checkout' ? '−1' : '+1';
  const where = item.location ? ' · ' + escapeHtml(item.location) : '';
  li.innerHTML =
    (item.image_url
      ? '<img class="thumb" src="' + escapeAttr(item.image_url) + '" alt="">'
      : '<div class="thumb"></div>') +
    '<div class="meta">' +
      '<div class="nm">' + escapeHtml(item.name) + '</div>' +
      '<div class="sub">' + (txMode === 'checkout' ? 'Taken' : 'Returned') +
        ' · now ' + result.quantity + ' on hand' + where + '</div>' +
    '</div>' +
    '<div class="amt ' + (txMode === 'checkout' ? 'take' : 'return') + '">' + sign + '</div>';
  sessionList.prepend(li);
}

// ---- mode toggle ----------------------------------------------------------
modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (btn) setMode(btn.dataset.mode);
});
function setMode(m) {
  mode = m;
  [...modeToggle.children].forEach((b) => {
    const on = b.dataset.mode === m;
    b.classList.toggle('active', on);
    b.classList.toggle('take', b.dataset.mode === 'checkout');
    b.classList.toggle('return', b.dataset.mode === 'return');
  });
  modeWord.textContent = m === 'checkout' ? 'take it out' : 'put it back';
}

// ---- sign out -------------------------------------------------------------
document.getElementById('doneBtn').addEventListener('click', signOut);
function signOut() {
  currentUser = null;
  showOfficeTag();
  showSession(false);
  clearTimeout(idleTimer);
}
function showSession(on) {
  sessionView.style.display = on ? 'flex' : 'none';
  idleView.style.display = on ? 'none' : 'block';
}

function resetIdle() {
  clearTimeout(idleTimer);
  if (currentUser) idleTimer = setTimeout(signOut, IDLE_MS);
}

// ---- theme + camera login ------------------------------------------------
if (window.Theme) Theme.init();

const camBtn = document.getElementById('camLoginBtn');
if (camBtn) {
  // Hide the camera button entirely if this browser can't use it at all,
  // so the stock-room USB kiosk isn't cluttered.
  if (window.Scanner && !Scanner.detectorSupported() && Scanner.secureContextOk()) {
    // supported check is best-effort; keep the button (it explains itself on tap)
  }
  camBtn.addEventListener('click', () => {
    Scanner.scan((code) => { handleScan(code); }, { title: 'Scan your badge barcode' });
  });
}

// ---- toast + escaping ------------------------------------------------------
let toastTimer;
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!isErr);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
