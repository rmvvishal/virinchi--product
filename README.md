# Campus Stores

A media equipment desk for a college stores team: approve club requests, issue kits, take returns with condition checks, hand over between shifts, track repairs, and report on usage.

It started as a Product Engineer work sample (open **Candidate brief** in the app). The three moments from the brief are still built in: the Film Society pickup, the partial return and the morning handover. Use the shift banner to move between them.

## Run it

**On one computer (no install):** open `index.html` in a modern browser. Records are saved in that browser and stay in sync across its tabs. Use the *Acting as* menu at the top to switch between staff and roles.

**On a shared desk (several computers):**

```sh
node server.js            # Node 20+, no dependencies
```

Open `http://127.0.0.1:8080`. The first run creates one account per staff member and prints their passwords once. Change a password with:

```sh
CAMPUS_NEW_PASSWORD='a long new password' node server.js passwd arjun
```

Settings: `PORT`, `HOST` (default `127.0.0.1`), `DATA_DIR` (default `./data`), and `SECURE_COOKIES=1` when it runs behind HTTPS. To reach it from other machines, put it behind an HTTPS reverse proxy (Caddy or nginx, for example) and set `HOST=0.0.0.0`. Back up the `data/` folder.

## Guided demo (start here)

Click **▶ Guided demo** at the top of the page. In 23 short steps it runs the brief's job through the real app, highlighting each part as it goes:

1. **Friday 3:45 pm, pickup.** The dashboard and notifications, the request as a kit, the club's message on the request, the confirmation screen, then issuing three slips under one transaction.
2. **7:30 pm, partial return.** Return two of three items, the wrong speaker caught by the ID check, the missing power cable sending the speaker to maintenance, and the adapter handed over to Leela on its slip.
3. **Saturday 9:00 am, handover.** Meera takes over, acknowledges the handover, finds the adapter's slip by scanning AD-12 (Leela is pre-filled), and closes the right loan.
4. **Safety nets.** The activity log and reversals, maintenance as a store manager, inventory reasons, and reports.

**Back** replays the shift up to the previous step. **×** or Esc leaves the tour, and the app stays exactly where the tour left it, so you can keep exploring. Opening `index.html?demo` starts the tour straight away. The demo resets the sample shift and only appears in browser-only mode, not on the shared server.

## What it does

| Area | What you get |
|---|---|
| **Pickup** | Each request opens as a kit, with one unit pre-picked per approved item (shelf location shown). The return time comes from the request. A confirmation screen lists the request, the units, the accessories to hand over, the borrower, the deadline and the item count, and you tick *“I have verified the equipment and borrower details.”* You can issue part of a kit when something isn't available. |
| **Returns** | Scan or type the unit ID to find its slip. Each unit's ID must match its slip. Record who physically brought it back, its condition (good / minor / major / missing accessories), which accessories came back, and remarks (required for damage). The time is stamped automatically and you confirm before it saves. Several units can be returned at once. |
| **Damage** | Anything returned damaged or incomplete is held off the shelf, a maintenance ticket opens automatically, and the unit can't be issued until a store manager clears it. |
| **Inventory** | Statuses: available, on loan, reserved, damaged, under maintenance, missing, retired. Each shows why the unit is unavailable and when it's expected back. You can filter by status, category and condition, and search. |
| **Maintenance** | Tickets carry a technician, an expected-back date and a full history. Store managers clear a unit back to the shelf or retire it. |
| **Requests** | Pending → approved / rejected / cancelled → partly fulfilled → fulfilled → closed. Includes an availability check before approval, modification, cancellation with a reason, approval history, and reservations held for a specific request. |
| **Safety and audit** | Every change gets a transaction ID and an activity-log entry. Mistakes are fixed by an audited **reversal** with a reason, never by editing history. Desk operators can reverse their own latest record; store managers can reverse any record. Double-clicks and repeated submissions are ignored. A unit can't be issued twice, even from two computers at the same moment. |
| **Dashboard** | Totals, available, on loan, reserved, damaged or in repair, overdue, pending and to-issue counts, each linking to the filtered list. Quick actions: process pickup, record return, check inventory, view overdue, scan a label. Also shows what needs attention, pickups waiting, what's out now, and recent activity. |
| **Handover** | Structured tasks (responsible person, priority, due time, status) plus free notes. Saying *“Leela is bringing the adapter back at 9”* on a slip creates a task, which closes itself when the adapter is returned. Incoming staff **acknowledge** the handover, and the app records who acknowledged it and when. |
| **Notifications** | A bell in the app: overdue and due-soon loans, damaged units, pickups coming up, requests awaiting approval, repairs awaiting release, and handover to acknowledge. Each viewer can dismiss their own. |
| **Search and filters** | Global search (press `/`) across units, requests, open slips and people. Each list has its own filters, including date ranges, a clear-filters button and empty-result states. |
| **Scanning** | Camera scanning of Code 128 / QR labels in browsers that support it. USB barcode scanners work anywhere because they type into the ID field. Code 128 labels can be printed from Inventory. |
| **Roles** | Desk operator, store manager, admin. On the server, permissions are enforced server-side, not just hidden in the UI. |
| **Reports** | Utilisation by category, most-borrowed units, damage rate, late/overdue rate and transactions per month, for the term, the last 30 days or the last 7 days. |
| **Export and print** | CSV exports of loans, inventory and transactions (cells are guarded against spreadsheet formula injection). Printable pickup and return receipts with signature lines, printable lists, printable unit labels, and a full JSON backup and restore in local mode. |
| **Worldwide** | Every time is stored as an absolute instant (UTC) and shown in the desk's time zone. Dates and numbers follow the chosen language/region. The admin can switch between the sample-shift clock and a live clock. |

## How it's built

- `domain.js` holds every rule as pure functions: validation, permissions, the audit log, reversals and reports. The browser and the server both use this same file, so they can't disagree.
- `app.js` is the desk UI. It uses browser storage when opened as a file, and the server when served by `server.js`.
- `tour.js` is the guided demo. It clicks and types into the real UI like a person would, so it shows exactly what a desk worker gets.
- `server.js` is plain Node with no dependencies:
  - scrypt-hashed passwords, HttpOnly SameSite cookies and rate-limited sign-in
  - a required request header on every write, which blocks cross-site request forgery
  - a strict Content-Security-Policy
  - changes applied one at a time, written atomically, and backed up on a rolling basis to `data/backups/`
  - live updates to every open screen via Server-Sent Events
- No build step and no runtime dependencies.

## Tests

```sh
npm install          # only needed for the browser tests (Playwright, axe-core)
npm test             # rules + server: sign-in, roles, CSRF, race for the same unit, live sync, restart
npm run test:e2e     # browser: the whole practical, every guided-demo step, an accessibility scan of every page, phone layout, two desks on the server
```

Set `CHROME_PATH` to use an installed Chrome (otherwise run `npx playwright install chromium` first).

## Not included (yet)

- **Email notifications.** Notifications appear in the app only; sending email needs a mail provider.
- **Translated screens.** The app's words are English. Dates, times and numbers are localised.
- **Staff accounts.** The staff list is fixed; admins change roles in Settings. Adding staff means editing the data file.
- **Camera scanning** depends on the browser (Chrome on Android and desktop yes; Safari no). USB scanners work everywhere.
- **Hosting and HTTPS** are up to whoever runs the server.
