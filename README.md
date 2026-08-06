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
  server.js    Express API (items, users, transactions, lookup, dashboard, settings)
  db.js        SQLite init + first-run seed
  schema.sql   Tables — configurable categories/units, users, items, transactions
  barcode.js   Pluggable barcode-lookup providers
public/
  index.html   Landing
  kiosk.html   / js/kiosk.js   Tech-facing scan station
  admin.html   / js/admin.js   Admin console
  js/code39.js Barcode SVG generator (no deps)
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
- Locations (warehouse shelf / truck) per stock item
- Per-item history view and CSV export
- Proper auth/sessions for the admin console (currently a simple PIN)

## Security note

The admin console uses a simple name + PIN check and is intended to run on your
own trusted network (like your other self-hosted tools), not exposed to the
open internet. If you put it behind a public URL, front it with a reverse proxy
and real authentication.

## License

**GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).

In plain terms: you're free to use, modify, and self-host StockTrax. If you
modify it and run it as a network service for others, the AGPL requires you to
make your modified source available to those users. Contributions are accepted
under a Developer Certificate of Origin — see [CONTRIBUTING.md](CONTRIBUTING.md).

*Not legal advice.*

