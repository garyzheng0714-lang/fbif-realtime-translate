/**
 * Auxiliary verification for the YouTube timeline captions content script.
 *
 * Usage:
 *   node scripts/verify-youtube-timeline-captions.mjs https://www.youtube.com/watch?v=We7BZVKbCVw
 *
 * This is not final user acceptance. The final check should still happen in
 * the real Chrome extension environment with the user's existing browser state.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../extension/dist');
const DEFAULT_URL = 'https://www.youtube.com/watch?v=We7BZVKbCVw';
const targetUrl = process.argv[2] || DEFAULT_URL;

if (!fs.existsSync(path.join(EXT_PATH, 'manifest.json'))) {
  console.error(`Missing built extension at ${EXT_PATH}. Run npm run extension:build first.`);
  process.exit(1);
}

const userDataDir = await fs.promises.mkdtemp(
  path.join(os.tmpdir(), 'sokuji-youtube-captions-'),
);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
  ],
});

try {
  const serviceWorker =
    context.serviceWorkers()[0] ||
    await context.waitForEvent('serviceworker', { timeout: 15000 });

  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const result = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
    });
    const tab = tabs[tabs.length - 1];
    if (!tab?.id) {
      return { ok: false, error: { code: 'no_video', message: 'No YouTube tab found.' } };
    }
    return chrome.tabs.sendMessage(tab.id, {
      type: 'fbif:youtube-timeline:get-captions',
    });
  });

  if (!result?.ok) {
    console.error('FAIL:', JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    const tracks = result.payload?.tracks || [];
    const events = result.payload?.json3?.events || [];
    console.log('PASS: YouTube captions fetched');
    console.log(`Video: ${result.payload.videoId} - ${result.payload.title}`);
    console.log(`Selected language: ${result.payload.sourceLanguage}`);
    console.log(`Tracks: ${tracks.length}`);
    console.log(`JSON3 events: ${events.length}`);
  }
} finally {
  await context.close();
  await fs.promises.rm(userDataDir, { recursive: true, force: true });
}
