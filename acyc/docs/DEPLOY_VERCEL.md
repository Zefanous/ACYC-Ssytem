# Deploying to Vercel

The app is ready for Vercel: static pages come from `public/`, the API runs as one serverless function (`api/[...path].js`), and records live in Google Sheets (nothing is stored on Vercel).

## 1. Google (about 10 minutes)
1. console.cloud.google.com → create a project (e.g. "club-system").
2. **APIs & Services → Library →** enable **Google Sheets API**.
3. **IAM & Admin → Service Accounts → Create** (any name). Open it → **Keys → Add key → JSON**. A `.json` file downloads. Keep it secret.
4. Create a new, empty Google Sheet. Click **Share**, paste the service account's `client_email` (from the JSON), give **Editor**. Do not make the sheet public or share it with anyone else (it holds password hashes and member details).
5. Copy the Sheet ID: the long text between `/d/` and `/edit` in its address.

## 2. Nothing to do here
The first time the app opens, it creates the sheet tabs and the first administrator by itself. You only choose that administrator's temporary password in step 4 (`BOOTSTRAP_ADMIN_PASSWORD`).

## 3. Put the code on GitHub
Push the `acyc` folder to a **private** repository (never commit the key file).

## 4. Vercel
1. vercel.com → **Add New → Project** → import the repository. Framework preset: **Other**. Leave build/output settings empty.
2. **Settings → Environment Variables** (Production):

| Name | Value |
|---|---|
| `STORAGE` | `sheets` |
| `SHEET_ID` | your sheet id |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole contents of the key file |
| `SESSION_SECRET` | a new random value: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `BOOTSTRAP_ADMIN_PASSWORD` | a temporary password you invent, at least 10 characters (used only if there are no users yet) |
| `CLUB_TZ` | `Africa/Kampala` |
| `COOKIE_SECURE` | `1` |

3. **Deploy.** Then open the address Vercel gives you and sign in with username `admin` and the `BOOTSTRAP_ADMIN_PASSWORD` you chose; you will be asked to choose your own.

## 5. After deploying: check
- `https://<your-app>/api/me` shows `{"error":"Please sign in."}` (the API is alive).
- Sign in, add a member, open the Google Sheet: the `members` tab has the new row.
- Create a leader account (Users) and sign in with it in a private window.
- Changing `SESSION_SECRET` later signs everyone out (harmless).

## Custom domain
Vercel → Project → Settings → Domains → add the club's domain and follow the DNS instructions. HTTPS is automatic.

## Things to know
- Free Vercel plans are for non-commercial use; a club project fits. Function time limit is 30 s (set in `vercel.json`), plenty.
- Each request makes a few Google Sheets calls, so pages take roughly 0.3-1 s. Google's quota (about 60 reads/minute per service account) is ample for a club, but not for hundreds of simultaneous users.
- Logging out clears the cookie but a signed login cookie remains valid until it expires (8 h) unless the password is changed or the user is deactivated, so use *Sign out* on shared devices and deactivate leavers promptly.
- Never edit the sheet by hand. Use Google's File → Version history if you ever need to roll back.
