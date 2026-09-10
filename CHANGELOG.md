# Changelog

All notable changes to StockTrax, newest first.

## 0.5.1
- **Fix:** printing a barcode now prints only the label (item name or tech name +
  barcode), not the whole page.
- **Fix:** external product images display again — the Content-Security-Policy was
  blocking off-site images (from barcode lookups and pasted links); `img-src` now
  allows external images (scripts and everything else stay locked down).
- **Fix:** the Edit item dialog's category/unit/location dropdowns now populate.
- **Print sizing:** barcodes print at 3 inches wide to scale correctly.
- **New:** "Print all badges" prints every tech's badge, 10 per 8.5×11 sheet
  (2 columns × 5 rows), each with the tech's name.

## 0.5.0
- **About section** showing the app version (read from `package.json`).
- **Mobile camera badge login** — reusable camera scanner (native `BarcodeDetector`);
  wired to kiosk login. Requires HTTPS to run on phones; degrades gracefully with
  a clear message and a type-the-code fallback over plain HTTP.
- **Cancel button** on the Receive Stock form.
- **In-app barcode printing** — printable Code 39 labels for items; auto-generated
  in-house codes (`STK-#####`) for stock with no barcode, or enter your own.
- **Kiosk light/dark theme** — per-device choice with an admin-set default.
- **Edit / deactivate items** — edit any field; deactivate/reactivate keeps history;
  "Show inactive" toggle.
- **Manual stock adjustment** with a reason, recorded in the audit log (supports
  downward corrections like breakage).
- **CSV export** of the full current inventory.

## 0.4.0
- Configurable **stock locations** (rooms) assignable to items; shown on the kiosk.
- Branding fix: a blank company name renders the logo only instead of falling back
  to "StockTrax".

## 0.3.1
- Security hardening: CSRF same-origin check, Content-Security-Policy + headers,
  server-side logo validation (raster only), settings allowlist, sanitized DB
  errors, non-root container, HTTPS cookie option.

## 0.3.0
- Timezone-aware reports (local calendar boundaries; local times in CSV).
- Admin login with scrypt-hashed passwords and server-side sessions; login rate
  limiting; password recovery (recovery code + CLI reset).

## 0.2.0
- White-labeling (company name, tagline, logo).
- Date-range reports with summaries and CSV download.

## 0.1.0
- Initial release: kiosk (badge scan → take/return), admin console (receive with
  barcode lookup, items, techs + printable badges, activity log, low-stock
  dashboard, settings), self-hosted via Docker.
