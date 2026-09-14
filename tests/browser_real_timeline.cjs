// Opt-in network regression. Library/history APIs are fixtures; only media is real.
// CLIPNEST_VIDEO_ID=Wz9h9zijFIs CLIPNEST_DURATION=198 PLAYWRIGHT_PATH=... node tests/browser_real_timeline.cjs
const { webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const id = process.env.CLIPNEST_VIDEO_ID;
const expected = Number(process.env.CLIPNEST_DURATION);
if (!/^[\w-]{11}$/.test(id || '') || !Number.isFinite(expected) || expected <= 0) {
  throw new Error('Specify CLIPNEST_VIDEO_ID and CLIPNEST_DURATION to opt into media requests.');
}
(async () => {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/media/')) return route.continue();
      if (path === '/api/home') return route.fulfill({ json: { items: [{ id, title: 'Timeline regression', channel: 'Fixture', duration: expected }], count: 1 } });
      return route.fulfill({ json: { items: [], count: 0 } });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.locator('audio').evaluate(audio => { audio.muted = true; });
    await page.locator('.card-media').first().click();
    await page.waitForFunction(expected => {
      const audio = document.querySelector('audio');
      return audio.src.includes('format=m4a-safe') && Math.abs(audio.duration - expected) < 2 && audio.readyState >= 3;
    }, expected, { timeout: 60000 });
    await page.locator('#forward5').click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return !audio.seeking && audio.currentTime >= 5;
    });
    await page.locator('#seek').scrollIntoViewIfNeeded();
    const box = await page.locator('#seek').boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    const beforeDrag = await page.locator('audio').evaluate(audio => audio.currentTime);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 });
    const dragging = await page.locator('audio').evaluate(audio => ({ paused: audio.paused, time: audio.currentTime }));
    assert.equal(dragging.paused, true);
    assert.ok(Math.abs(dragging.time - beforeDrag) < 0.05);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return !audio.seeking && audio.currentTime > 100;
    });
    await page.locator('#statusButton').click();
    const diagnostics = JSON.parse(await page.locator('#playbackDiagnostics').textContent());
    assert.equal(diagnostics.mediaFormat, 'm4a-safe');
    assert.ok(diagnostics.durationRecoveries.some(entry => entry.format === 'm4a' && entry.duration > expected * 1.8));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', duration: diagnostics.mediaDuration, recoveries: diagnostics.durationRecoveries }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
