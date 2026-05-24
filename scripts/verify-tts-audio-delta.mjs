/**
 * verify-tts-audio-delta.mjs
 *
 * Half-automated verification: checks that participant audio deltas
 * actually flow through to the ModernAudioPlayer instead of being skipped.
 *
 * Usage:
 *   node scripts/verify-tts-audio-delta.mjs
 *
 * The script will:
 *   1. Load the extension and open a YouTube video
 *   2. Inject a listener for 'sokuji:participant-audio-delta' events
 *   3. Prompt you to manually start a session in the side panel
 *   4. Wait 30 seconds, then check the count
 *   5. Exit 0 if count > 0 (audio delta received), exit 1 if count = 0 (still blocked)
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../extension/dist');
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const WAIT_SECONDS = 30;

console.log('Loading extension from:', EXT_PATH);

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

// Open YouTube video
const page = await ctx.newPage();
await page.goto(YOUTUBE_URL);
await page.waitForTimeout(2000);

// Inject counter for participant audio delta events
await page.evaluate(() => {
  window.__sokujiAudioDeltaCount = 0;
  window.addEventListener('sokuji:participant-audio-delta', () => {
    window.__sokujiAudioDeltaCount++;
  });
});

console.log('');
console.log('=== 手动步骤 ===');
console.log('1. 点击浏览器工具栏的扩展图标，打开 Sokuji side panel');
console.log('2. 在 side panel 中配置好 API key (豆包 AST 2.0 或其他支持 TTS 的 provider)');
console.log('3. 点击"开始翻译"按钮启动会话');
console.log('4. 让 YouTube 视频播放，等音频进来');
console.log(`脚本将在 ${WAIT_SECONDS} 秒后自动取计数...`);
console.log('');

// Wait for user to manually start the session
await page.waitForTimeout(WAIT_SECONDS * 1000);

// Read the count
const count = await page.evaluate(() => window.__sokujiAudioDeltaCount ?? 0);

console.log('');
console.log(`=== 结果 ===`);
console.log(`sokuji:participant-audio-delta 事件计数: ${count}`);

if (count > 0) {
  console.log('PASS: audio delta 已流入 player，TTS 配音通道正常');
} else {
  console.log('FAIL: 未收到 audio delta，请检查:');
  console.log('  - 是否正确启动了会话?');
  console.log('  - textOnly 是否已改为 false?');
  console.log('  - audio delta 早退是否已删除?');
}

await ctx.close();
process.exit(count > 0 ? 0 : 1);
