// Dev helper: dump the structure of a Connect page so selectors can be chosen.
// Usage: node scripts/probe.js [url]
import { launch, CONNECT_URL } from '../src/browser.js';

const url = process.argv[2] || CONNECT_URL;
const ctx = await launch({ headless: true });
const page = ctx.pages()[0] || (await ctx.newPage());
const requests = [];
page.on('request', (r) => {
  if (['xhr', 'fetch', 'websocket'].includes(r.resourceType())) requests.push(`${r.method()} ${r.url()}`);
});
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());
const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('a, button, [role=button], [data-testid]')];
  return els.slice(0, 150).map((e) => ({
    tag: e.tagName,
    text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    href: e.getAttribute('href'),
    testid: e.getAttribute('data-testid'),
    aria: e.getAttribute('aria-label'),
  }));
});
console.log(JSON.stringify(info, null, 1));
console.log('XTERM:', await page.locator('.xterm').count());
console.log('REQUESTS:\n' + [...new Set(requests)].join('\n'));
await page.screenshot({ path: process.env.SHOT || 'probe.png', fullPage: true });
await ctx.close();
