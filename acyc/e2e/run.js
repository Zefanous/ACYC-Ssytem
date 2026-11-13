'use strict';
// Browser end-to-end test. Needs Playwright (npm i -D playwright). Run: node --no-warnings e2e/run.js
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createApp } = require('../src/club');
const { seed } = require('../scripts/seed');

const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'acyc-shots'); fs.mkdirSync(SHOTS, { recursive: true });
(async () => {
  const app = createApp({ dbPath: ':memory:' }); seed(app);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  let n = 0; const ok = (m) => console.log(`  ✓ ${++n}. ${m}`);
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  await page.goto(base);
  // wrong password
  await page.fill('[name=username]', 'demo-secretary'); await page.fill('[name=password]', 'wrongwrong');
  await page.click('button[type=submit]');
  await page.waitForSelector('.form-error');
  assert.match(await page.textContent('.form-error'), /not correct/); ok('wrong password shows a plain-language error');
  await shot('01-login-mobile');
  await page.fill('[name=password]', 'DemoSecretary-2026!'); await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("Dashboard")'); ok('secretary signs in');
  assert.ok(await page.locator('text=Upcoming activities').count()); assert.ok(await page.locator('.badge:has-text("Example")').count()); ok('dashboard shows upcoming activities, with Example badges on sample data');
  assert.equal(await page.locator('nav.main a:has-text("Users")').count(), 0); assert.equal(await page.locator('nav.main a:has-text("Audit")').count(), 0); ok('secretary does not see admin navigation');
  await shot('02-dashboard-mobile');
  // no horizontal scroll on mobile
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); ok('no horizontal page scroll at phone width');

  // create activity (validation first)
  await page.goto(base + '/#/activity/new'); await page.waitForSelector('#af');
  await page.click('#af button[type=submit]'); await page.waitForSelector('.form-error');
  assert.ok((await page.textContent('#e-title')).length); assert.ok((await page.textContent('#e-organizer_member_id')).length); ok('activity form flags missing required fields');
  await page.fill('#f-title', 'E2E Planning Meeting'); await page.selectOption('#f-organizer_member_id', { label: 'Amina Example' });
  await page.fill('#f-date', '2026-11-10'); await page.fill('#f-time', '09:00'); await page.fill('#f-location', 'Club room');
  await shot('03-activity-form-mobile');
  await page.click('#af button[type=submit]');
  await page.waitForSelector('#att-list'); ok('creating an activity lands on its attendance page');
  assert.equal(await page.locator('#save-att').count(), 0); assert.equal(await page.locator('.seg').count(), 0);
  assert.match(await page.textContent('#tabbody'), /recorded by the club leader/); ok('secretary sees attendance read-only (no save button)');
  const actUrl = page.url();
  // notes and tasks
  await page.click('[data-tab=notes]'); await page.waitForSelector('#nf');
  await page.fill('#f-notes', 'Discussed plans <b>bold?</b>'); await page.fill('#f-decisions', 'Go ahead'); await page.click('#nf button[type=submit]');
  await page.waitForFunction(() => /Notes saved/.test(document.getElementById('toast').textContent));
  await page.waitForSelector('#tf'); await page.waitForSelector('#tf select option:nth-child(3)', { state: 'attached' });
  await page.fill('#tf [name=title]', 'Send invitations'); await page.selectOption('#tf [name=responsible_member_id]', { index: 2 }); await page.fill('#tf [name=due_date]', '2026-11-01');
  await page.click('#tf button[type=submit]'); await page.waitForSelector('td:has-text("Send invitations")');
  assert.ok(await page.locator('tr:has-text("Send invitations") .b-bad:has-text("Overdue")').count()); ok('task added and shown as Overdue (past due date)');
  await page.click('button[data-toggle]'); await page.waitForSelector('tr:has-text("Send invitations") .b-ok'); ok('task marked complete');
  assert.equal(await page.locator('.notes-view b').count(), 0); ok('HTML typed in notes is not executed');
  await shot('05-notes-tasks-mobile');
  // members
  await page.goto(base + '/#/member/new'); await page.waitForSelector('#mf');
  await page.fill('#f-full_name', 'E2E New Member'); await page.fill('#f-email', 'not-an-email'); await page.click('#mf button[type=submit]');
  await page.waitForSelector('#e-email:not(:empty)'); ok('invalid email rejected with a helpful message');
  await page.fill('#f-email', 'e2e@example.org'); await page.click('#mf button[type=submit]'); await page.waitForSelector('h1:has-text("E2E New Member")'); ok('member added');
  page.once('dialog', () => {});
  await page.click('#toggle'); await page.waitForSelector('dialog[open]'); await shot('06-confirm-dialog-mobile');
  await page.click('dialog [data-r=yes]'); await page.waitForSelector('.badge:has-text("Inactive"), .badge:has-text("Inactive")'); ok('deactivation asks for confirmation first');
  assert.equal(await page.locator('#remove').count(), 0); ok('secretary cannot see "Remove personal data"');
  // reports
  await page.goto(base + '/#/reports?from=2026-10-01&to=2026-11-10'); await page.waitForSelector('text=Member participation');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("Export CSV")')]);
  const csvText = fs.readFileSync(await dl.path(), 'utf8'); assert.match(csvText, /MEMBER PARTICIPATION/); ok('report renders and CSV exports');
  await shot('07-report-mobile');
  // club leader records attendance
  await page.click('#logout'); await page.waitForSelector('#login');
  await page.fill('[name=username]', 'demo-leader'); await page.fill('[name=password]', 'DemoLeader-2026!'); await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("Dashboard")'); ok('club leader signs in');
  assert.equal(await page.locator('a:has-text("+ New activity")').count(), 0); ok('leader has no "New activity" button');
  await page.goto(base + '/#/members'); await page.waitForSelector('table'); assert.equal(await page.locator('a:has-text("+ Add member")').count(), 0); ok('leader cannot add members');
  await page.click('nav.main a:has-text("Attendance")'); await page.waitForSelector('h2:has-text("Waiting for attendance")');
  await shot('11-attendance-home-mobile');
  assert.ok(await page.locator('a.btn.primary:has-text("Take attendance")').count()); ok('leader finds "Take attendance" in the Attendance menu');
  await page.locator('li:has-text("E2E Planning Meeting") a.btn').click(); await page.waitForSelector('#att-list');
  await page.click('#all-present');
  await page.locator('.att-row').nth(1).locator('label:has-text("Absent")').click();
  await page.locator('.att-row').nth(2).locator('label:has-text("Late")').click();
  await page.locator('.att-row').nth(3).locator('label:has-text("Excused")').click();
  await shot('04-attendance-mobile');
  await page.click('#save-att'); await page.waitForFunction(() => /Attendance saved/.test(document.getElementById('toast').textContent)); ok('leader saves attendance');
  await page.reload(); await page.waitForSelector('#att-list');
  assert.ok(await page.locator('.att-row').nth(1).locator('input[value=absent]').isChecked());
  assert.ok(await page.locator('.att-row').nth(2).locator('input[value=late]').isChecked()); ok('attendance persists after reload');
  await page.locator('.att-row').nth(1).locator('label:has-text("Excused")').click(); await page.click('#save-att');
  await page.waitForFunction(() => /Attendance saved \(1 updated\)/.test(document.getElementById('toast').textContent)); ok('attendance correction saved');
  await page.click('[data-tab=notes]'); await page.waitForSelector('h2:has-text("Meeting notes")');
  assert.equal(await page.locator('#nf').count(), 0); assert.equal(await page.locator('#tf').count(), 0); ok('leader sees notes and tasks read-only');
  await page.goto(base + '/#/reports?from=2026-10-01&to=2026-11-10'); await page.waitForSelector('text=Member participation'); ok('leader can open reports');
  // offline banner
  await ctx.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  assert.ok(await page.locator('#offline').isVisible());
  assert.match(await page.textContent('#offline'), /does not keep data on your device/); ok('offline banner explains what will not work');
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); assert.ok(!(await page.locator('#offline').isVisible()));
  await page.click('#logout'); await page.waitForSelector('#login'); ok('sign out');
  // direct API access after logout
  assert.equal((await page.evaluate(async () => (await fetch('/api/members')).status)), 401); ok('API refuses requests after sign-out');

  // admin on desktop
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const dp = await dctx.newPage();
  dp.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('desktop: ' + m.text()); }); dp.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
  await dp.goto(base); await dp.fill('[name=username]', 'demo-admin'); await dp.fill('[name=password]', 'DemoAdmin-2026!'); await dp.click('button[type=submit]');
  await dp.waitForSelector('h1:has-text("Dashboard")'); await dp.screenshot({ path: path.join(SHOTS, '08-dashboard-desktop.png') });
  await dp.click('nav a:has-text("Audit history")'); await dp.waitForSelector('td:has-text("Corrected attendance")');
  assert.ok(await dp.locator('tr:has-text("Corrected attendance"):has-text("demo-leader"):has-text("absent → excused")').count()); ok('admin sees audit trail: who corrected attendance, from → to');
  await dp.screenshot({ path: path.join(SHOTS, '09-audit-desktop.png') });
  await dp.click('nav a:has-text("Users")'); await dp.waitForSelector('h1:has-text("Users")');
  await dp.fill('#uf [name=display_name]', 'E2E Leader'); await dp.fill('#uf [name=username]', 'e2e.leader'); await dp.fill('#uf [name=password]', 'short'); await dp.click('#uf button[type=submit]');
  await dp.waitForSelector('#e-password:not(:empty)'); ok('weak temporary password rejected');
  await dp.selectOption('#uf [name=role]', 'secretary'); await dp.fill('#uf [name=password]', 'Temporary-1234'); await dp.click('#uf button[type=submit]'); await dp.waitForSelector('td:has-text("e2e.leader")'); ok('admin creates a user');
  await dp.goto(base + '/#/activities'); await dp.waitForSelector('table'); await dp.screenshot({ path: path.join(SHOTS, '10-activities-desktop.png') });
  const [bk] = await Promise.all([dp.waitForEvent('download'), (async () => { await dp.goto(base + '/#/users'); await dp.waitForSelector('a:has-text("Download backup file")'); await dp.click('a:has-text("Download backup file")'); })()]);
  assert.equal(fs.readFileSync(await bk.path()).subarray(0, 15).toString(), 'SQLite format 3'); ok('admin downloads a valid backup');

  // forced password change for the new user
  const nctx = await browser.newContext(); const np = await nctx.newPage();
  await np.goto(base); await np.fill('[name=username]', 'e2e.leader'); await np.fill('[name=password]', 'Temporary-1234'); await np.click('button[type=submit]');
  await np.waitForSelector('h1:has-text("Choose a new password")'); ok('new user is forced to choose their own password');
  await np.fill('#f-current_password', 'Temporary-1234'); await np.fill('#f-new_password', 'MyOwn-Password-7'); await np.click('#pw button[type=submit]');
  await np.waitForSelector('h1:has-text("Dashboard")'); ok('after changing password the new user reaches the dashboard');

  // installable app (PWA)
  const man = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  assert.equal(man.display, 'standalone'); assert.ok(man.icons.some((i) => i.sizes === '512x512')); ok('web app manifest is valid');
  await page.goto(base); await page.waitForSelector('#login');
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }); assert.ok(sw); ok('service worker active (app can be installed)');
  assert.deepEqual(errors, [], 'browser console errors / CSP violations: ' + errors.join(' | ')); ok('no console errors or CSP violations');
  await browser.close(); app.close(); console.log(`\nE2E passed (${n} checks). Screenshots in ${SHOTS}`);
})().catch((e) => { console.error('\nE2E FAILED:', e.message); process.exit(1); });
