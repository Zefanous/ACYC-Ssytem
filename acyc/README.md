# Club Activity System: The Aids Challenge Youth Club

Simple, secure activity management for a youth club: members, activities, attendance, meeting notes and follow-up tasks, dashboard and reports, with sign-in, roles and an audit trail. Works on phones and computers. **No dependencies**: just Node.js 22.5+. The interface is maroon with frosted-glass panels and installs on phones as an app (PWA). Records live in **Google Sheets** (or a local SQLite file for development).

User instructions: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)

## Run it
```bash
npm start                      # http://127.0.0.1:3000
```
First run creates an administrator `admin` and prints a temporary password (or set `ADMIN_PASSWORD`); you must change it at first sign-in.

Try it with demonstration data (invented people, clearly badged "Example"):
```bash
DB_PATH=./data/demo.db npm run seed && DB_PATH=./data/demo.db npm start
# demo-admin / DemoAdmin-2026!    demo-leader / DemoLeader-2026!
```

| Setting | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | 3000, 127.0.0.1 | Use `HOST=0.0.0.0` to serve a local network |
| `DB_PATH` | `data/club.db` | Database file (this is "the club's records"; back it up) |
| `CLUB_TZ` | `Africa/Kampala` | Club time zone for "today", overdue and display |
| `COOKIE_SECURE=1` | off | Set when served over HTTPS (also auto-detected behind a proxy sending `X-Forwarded-Proto: https`) |

**Hosting:** with Sheets storage the server keeps nothing on disk, so any host works (VPS, container, or serverless). Always serve over HTTPS and set `COOKIE_SECURE=1`. With the SQLite option a persistent disk is required.


## Google Sheets as the database
Each table is a tab (users, members, activities, attendance, notes, tasks, audit) plus a `_meta` version tab, created automatically. Treat the sheet as **read-only**: edit records through the app, not in the sheet (hand edits are not noticed until the next save and may be overwritten or rejected).

1. Google Cloud console → create a project → enable **Google Sheets API** → create a **service account** → add a JSON key.
2. Create an empty Google Sheet, **share it with the service account's email as Editor**, and keep it private (it holds password hashes and personal details). Copy the Sheet ID from its URL.
3. Set environment variables:
```
STORAGE=sheets
SHEET_ID=<the sheet id>
GOOGLE_SERVICE_ACCOUNT_JSON='<contents of the key file>'   # or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
SESSION_SECRET=<long random text>                          # required with Sheets; signs login cookies
```
4. `npm start` (first run creates the tabs and an `admin` account). Optional demo data: `STORAGE=sheets ... npm run seed`. Move an existing local database: `npm run sheets:import -- data/club.db --yes`.

How it behaves: signed stateless sessions (so any number of servers/instances work), a version check before each request, and a refused save (HTTP 409) if two people save at the same instant. Google allows ~60 reads/minute per user, which is ample for a club.

## Vercel
See [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md) (step-by-step).

## Tests
```bash
npm test                         # 51 tests: API/security/business rules + Google Sheets storage (against a fake Google API)
npm i -D playwright && npx playwright install chromium
node --no-warnings e2e/run.js    # 36 browser checks at phone + desktop sizes, incl. CSP/console errors
```

## Security design
scrypt-hashed passwords · random server-side sessions in HttpOnly + SameSite=Strict cookies · CSRF token on every change · login lockout · role checks on every endpoint · strict Content-Security-Policy (no inline scripts/styles) · parameterised SQL · all user text escaped on render · CSV formula-injection neutralised · audit log of sign-ins and every important change · no health fields exist in the database.

## Assumptions (change if wrong)
1. Platform: responsive web app, self-hosted, one club. Needs internet/LAN; **no offline mode** (and the UI says so).
2. Roles: **club leader** (records attendance, views everything, reports), **secretary** (members, activities, notes, tasks, reports) and **administrator** (everything plus users, audit, backups); permissions in `PERMS`, `src/club.js`.
3. Activity types: Meeting, Event, Outreach, Training, Other (`ACTIVITY_TYPES`).
4. Organizer and task owner are club *members* (not login users).
5. "Held" = not cancelled and start time has passed. "Overdue" = open task past its due date. Attendance % = (present + late) ÷ (present + late + absent); excused is not counted against anyone.
6. No retention periods or legal requirements invented: removal is a manual administrator action that erases personal details but keeps anonymous counts.
7. Passwords: min 10 characters; sessions last 8 hours.
