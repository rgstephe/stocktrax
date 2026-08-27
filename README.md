# StockTrax

**Complete Inventory Control, On Your Terms.**

A deliberately simple, self-hosted barcode inventory system. Scan stock in when
it arrives, scan it out when someone takes it — every movement logged to the
person who did it. Built for a single stock-room kiosk with a USB barcode
scanner, plus an admin console for receiving stock and running the show.

No cloud, no accounts to buy, no build step. One Docker container.

---

## What it does

- **Receive stock by barcode.** Scan a new product and StockTrax looks it up in
  an online barcode database to auto-fill the name, brand, and packaging image.
  Known products just add quantity.
- **Kiosk check-out / check-in.** A tech scans their printed badge to sign in,
  then scans items to **take** or **return**. Each scan is logged with their
  name and a timestamp.
- **Printable badges & labels.** Generates real, scannable Code 39 barcodes in
  the browser — print a badge per tech straight from the Techs screen.
- **Low-stock dashboard.** Set a threshold per item; the dashboard flags
  anything at or below it.
- **Date-range reports.** Pick a week, a month, or any custom range, see a
  summary (received / taken / returned, by item and by tech), and download a
  CSV for your records.
- **Stock locations.** Define your own rooms/areas (warehouse, chemical room,
  tool room…) and assign one to each item, so techs can see where to grab it.
- **Edit, adjust & retire items.** Edit any item's details, correct the on-hand
  count with a reason (kept in the audit log), and deactivate discontinued
  products without losing their history.
- **In-app barcode labels.** Print tech badges and item labels as real scannable
  Code 39 barcodes. Stock with no manufacturer barcode gets an auto-generated
  in-house code (STK-#####), or type your own.
- **Camera scanning on mobile.** On a phone (over HTTPS), a tech can sign in by
  scanning their badge with the camera when no USB scanner is handy.
- **Light or dark kiosk.** Each device picks light or dark; the admin sets the
  default. **CSV inventory export** for backups.
- **White-labeling.** Set your company name, tagline, and logo in Settings and
  StockTrax rebrands itself across the kiosk, landing page, and browser tab.
- **Full audit log.** Who took what, when — receives, checkouts, and returns.

## Quick start (Docker)

```bash
git clone <your-repo-url> stocktrax
cd stocktrax
docker compose up -d --build
```

Then open:

- **Landing:** http://localhost:3000
- **Stock-room kiosk:** http://localhost:3000/kiosk.html
- **Admin console:** http://localhost:3000/admin.html

Your database persists in `./data/stocktrax.db`.

### Without Docker

```bash
npm install
npm start
```

Requires Node 18+. (`better-sqlite3` compiles a native module; on a bare host
you may need build tools — `python3`, `make`, and a C++ compiler.)

## First run

1. Open the **Admin console**.
2. Go to **Settings** → set your company name and confirm the barcode provider.
3. Go to **Techs** → add each tech; a badge is generated and shown for printing.
   Print one per tech (laminate them — they live in a stock room).
4. Go to **Receive Stock** → scan your existing inventory in to seed quantities.
5. On the stock-room laptop, open the **Kiosk** page and go full-screen (F11).
   Plug in the USB scanner. That's the whole tech-facing experience.

The scanner just needs to act as a **keyboard wedge** (type the barcode, then
send Enter) — this is the default mode for nearly every USB scanner.

## The kiosk workflow

```
  ┌─────────────┐   scan badge    ┌──────────────┐   scan item   ┌────────────┐
  │  Waiting…   │ ───────────────▶│  Signed in   │ ─────────────▶│  Logged.   │
  │ scan badge  │                 │  Take/Return │◀───────────── │  Scan next │
  └─────────────┘                 └──────────────┘   or Done      └────────────┘
```

- Default mode is **Take**. Tap **Return** to switch to check-ins.
- Sessions auto-close after 45 seconds of inactivity, or when the tech taps
  **Done**.

## Architecture

```
src/
  server.js       Express API (kiosk + admin, session auth, reports, settings)
  auth.js         Password hashing (scrypt), recovery codes, tokens — no deps
  reset-admin.js  Command-line admin password reset (lockout fallback)
  db.js           SQLite init, migrations, first-run seed
  schema.sql      Tables — users, items, transactions, sessions, settings
  barcode.js      Pluggable barcode-lookup providers
public/
  index.html      Landing
  login.html / recover.html   Admin sign-in and password recovery
  kiosk.html   / js/kiosk.js   Tech-facing scan station
  admin.html   / js/admin.js   Admin console
  js/branding.js  Applies company name/logo/tagline across pages
  js/code39.js    Barcode SVG generator (no deps)
  css/style.css
```

- **Backend:** Node + Express, SQLite via `better-sqlite3`. Stock movements are
  applied inside a transaction so on-hand counts can never drift from the log.
- **Frontend:** plain HTML/CSS/JS — no framework, no bundler. Easy to fork.

## Built to extend

This started as a pest-control stock room, but nothing pest-specific is baked
into the code:

- **Categories and units are data, not code** (Settings screen). Swap
  "Chemicals / Bait / Traps" for "Fertilizer / Fuel / Mowers" and it's a
  landscaping tool; for "Wire / Breakers / Conduit" it's an electrician's.
- **Barcode providers are pluggable** — add a function in `src/barcode.js` for a
  distributor API or a different database; no other file changes.
- **Transaction types are generic** (receive / checkout / return / adjustment).

### Roadmap ideas
- Photo upload for products without a database image
- Camera-based take/return on mobile (the scanner is already reusable)
- Multiple admin accounts with roles/permissions
- Report breakdowns by location

## Accounts & security

The admin console is protected by a password login with server-side sessions.
Passwords are hashed with scrypt (via Node's built-in `crypto` — no plaintext,
no external dependency). The kiosk stays login-free by design: techs identify
themselves by scanning their badge, not by signing in.

**First login:** user `Admin`, password from `ADMIN_PASSWORD` (default `admin`).
Change it immediately under **Settings → Account & security**, and generate a
**recovery code** while you're there — it's shown once, so save it somewhere safe.

**If you forget your password:** click **Forgot password?** on the sign-in page
and enter your recovery code to set a new one (a fresh recovery code is issued).

**If you're fully locked out** (no recovery code), reset from the server shell —
only someone with access to the machine can do this:

```bash
docker compose exec stocktrax node src/reset-admin.js "YourNewPassword"
```

It sets the new password, prints a new recovery code, and signs out all sessions.

**Upgrading from an older version:** the first boot migrates your database
automatically and turns your existing admin PIN into your new password — so log
in with `Admin` and your old PIN, then change it.

**Network exposure:** StockTrax is built to run on your own trusted network,
like your other self-hosted tools. If you expose it to the public internet, put
it behind a reverse proxy with HTTPS and set `COOKIE_SECURE=true`.

**Additional hardening (v0.3.1):** admin sessions with scrypt-hashed passwords;
a same-origin (CSRF) check on all state-changing requests; a Content-Security-
Policy plus `nosniff`/`X-Frame-Options`/`Referrer-Policy` headers; server-side
validation of uploaded logos (raster images only — SVG is rejected); a strict
allowlist for settings keys; sanitized database error messages; and the app
drops to a non-root user inside the container on startup.

## License

**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In plain terms: you're free to use, modify, and self-host StockTrax. If you
modify it and run it as a network service for others, the AGPL requires you to
make your modified source available to those users. Contributions are accepted
under a Developer Certificate of Origin — see [CONTRIBUTING.md](CONTRIBUTING.md).

*Not legal advice.*

