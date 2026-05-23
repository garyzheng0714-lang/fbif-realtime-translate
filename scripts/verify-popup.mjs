import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../extension/dist');

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
  ],
});

const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
console.log('Extension ID:', extId);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push({ type: 'pageerror', msg: e.message, stack: e.stack }));
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    errors.push({ type: msg.type(), text: msg.text() });
  }
});

await page.goto(`chrome-extension://${extId}/popup.html`);
await page.waitForTimeout(2000);

const bodyText = await page.evaluate(() => document.body.innerText.trim());
const contentInner = await page.evaluate(() => document.getElementById('content')?.innerHTML || '<MISSING>');

console.log('--- popup body text ---');
console.log(bodyText || '<EMPTY>');
console.log('--- #content innerHTML ---');
console.log(contentInner);
console.log('--- errors ---');
console.log(JSON.stringify(errors, null, 2));

await ctx.close();
process.exit(errors.length > 0 ? 1 : 0);
