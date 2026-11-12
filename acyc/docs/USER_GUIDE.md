# Club Activity System: User Guide
**The Aids Challenge Youth Club** · version 1.0

> The records marked **Example** and the `demo-admin` / `demo-leader` accounts are **demonstration data only** (invented people). Delete them before real use.

## 1. Signing in
Open the system address in any phone or computer browser. Enter your username and password.
- First sign-in after an administrator creates or resets your account: you must choose your own password (at least 10 characters).
- Five wrong attempts lock sign-in for that username for 15 minutes.
- Forgot your password? Ask an administrator to reset it (Users → Reset password).
- You are signed out automatically after 8 hours. Always press **Sign out** on a shared device.

## 2. Who can do what
| | Club leader | Administrator |
|---|:-:|:-:|
| View members, activities, attendance, notes, tasks | ✔ | ✔ |
| Add / edit members, deactivate / reactivate | ✔ | ✔ |
| Create / edit / cancel activities | ✔ | ✔ |
| Record and correct attendance, write notes, manage tasks | ✔ | ✔ |
| Reports (print, CSV) | ✔ | ✔ |
| Delete an activity permanently | | ✔ |
| Remove a member's personal data | | ✔ |
| Manage users, view audit history, download backups | | ✔ |

These two roles are the only ones built. If the club needs different roles, the table is in one place (`PERMS` in `src/club.js`).

## 3. Everyday tasks
**Create an activity** – Dashboard → *+ New activity*. Fill in title, type, organizer, date, time and location (agenda is optional) → *Create activity*. You go straight to the attendance page.

**Record attendance** – open the activity → *Attendance*. Tap Present / Absent / Late / Excused for each person, or *Mark everyone present* first and change the exceptions. Press **Save attendance**. Later corrections use the same page; every correction is logged (who, when, old → new value).

**Meeting notes and follow-up** – activity → *Notes and tasks*. Write notes, decisions and outcomes, then add tasks: what, who is responsible, due date. A task shows **Open**, **Completed** or **Overdue** (open and past its due date). Use *Mark done* when finished.

**Members** – *Members* → *+ Add member*. Only name, optional phone/email, status and date joined are kept. *Deactivate* hides someone from new attendance lists but keeps their history.

**Reports** – *Reports* → pick dates → *Create report*. Shows activities held, attendance totals, each member's participation and outstanding tasks. Use *Print* or *Export CSV* (opens in Excel/Sheets).

**Dashboard** – upcoming activities, recent meetings with attendance, open and overdue tasks, and a reminder for past activities whose attendance was never recorded.

## 4. Privacy and safeguarding
- The system collects only what is needed to run the club. **There are no health or HIV fields; do not type health information into names, notes or anywhere else.**
- Mistakes in a record: *Edit details* on the member.
- Removing a person's data (administrator): member page → *Remove personal data*. Name, phone and email are erased; anonymous attendance counts remain so past reports stay accurate. It cannot be undone. **The club has not told us its retention rules, so none are built in**: removal is manual and your club decides when to use it.
- Every important change is in **Audit history** (administrators).
- Treat backups and CSV exports as confidential: they contain names and contact details.

## 5. Internet connection
The system needs the internet (or your local network) to work. **It does not work offline and stores nothing on your device.** If the connection drops you will see a yellow warning; changes made while offline are **not saved**, so wait for the connection to return, then repeat the change. Tip: record attendance in one go, as soon as you have a signal.

## 6. Backup and recovery (administrators)
- **Where records live:** in the club's private Google Sheet. Google keeps its own version history (File → Version history), which is a second safety net. Never edit the sheet by hand.
- **Backup:** Users → *Download backup file* (or `npm run backup` on the server). Do this weekly and after big meetings; keep copies in two safe places (e.g. an encrypted USB drive and a protected cloud folder).
- **Restore:** stop the server, run `npm run restore -- path/to/backup.db`, start the server. The current data is first saved beside it as `.before-restore-…`.
- Practise one restore on a test copy before you need it.

## 7. Troubleshooting
| Problem | Try |
|---|---|
| "Please sign in" suddenly | Session expired; sign in again. |
| Red message under a field | Fix that field; all problems are listed at once. |
| Can't see Users / Audit | Those are administrator-only. |
| A person is missing from attendance | They are inactive; reactivate them on their member page. |
