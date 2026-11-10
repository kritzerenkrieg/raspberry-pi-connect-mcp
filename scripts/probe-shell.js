// Dev helper: open the Remote shell for a device (by name substring) and dump how it renders.
// Types nothing into the shell. Usage: node scripts/probe-shell.js "my-pi"
import { launch, CONNECT_URL } from '../src/browser.js';

const name = process.argv[2];
const out = process.env.OUT || '.';
const ctx = await launch();
const page = await ctx.newPage();
await page.goto(`${CONNECT_URL}/devices`, { waitUntil: 'networkidle' });
const row = page.locator('tr, li, [role=row]').filter({ has: page.getByRole('link', { name }) }).first();

const dd = row.locator('details:visible').first();
console.log('DROPDOWN:', (await dd.evaluate((e) => e.outerHTML)).replace(/<svg[\s\S]*?<\/svg>/g, ''));
await dd.locator('summary').click();
const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
await dd.getByRole('button', { name: 'Remote shell' }).or(dd.getByRole('link', { name: 'Remote shell' })).first().click();
const popup = await popupP;
const sh = popup || page;
console.log('POPUP:', !!popup, 'URL:', sh.url());
await sh.waitForLoadState('networkidle').catch(() => {});
await sh.waitForTimeout(8000);
console.log('SHELL URL:', sh.url(), 'TITLE:', await sh.title());
console.log('xterm:', await sh.locator('.xterm').count(), 'xterm-rows:', await sh.locator('.xterm-rows').count(),
  'canvas:', await sh.locator('canvas').count(), 'iframes:', sh.frames().length);
console.log('xterm-rows text:\n' + (await sh.locator('.xterm-rows').innerText().catch(() => '(none)')));
console.log('globals:', await sh.evaluate(() => Object.keys(window).filter((k) => /term|xterm|shell/i.test(k))));
await sh.screenshot({ path: `${out}/shell.png` });
await ctx.close();
