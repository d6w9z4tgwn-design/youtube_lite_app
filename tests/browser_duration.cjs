// Fixture-only playback: no user history changes or external media requests.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = process.env.WEBKIT ? await webkit.launch() : await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('PAGE', error.message));
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = async function () {};
      HTMLMediaElement.prototype.load = function () {};
      HTMLMediaElement.prototype.canPlayType = () => 'probably';
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get() { return this.dataset.testSrc || ''; },
        set(value) { this.dataset.testSrc = value; },
      });
    });
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/status' || path === '/api/modules') return route.continue();
      if (path.startsWith('/api/media/')) return route.abort();
      return route.fulfill({ json: { items: [{ id: 'abcdefghijk', title: 'Duration fixture', channel: 'Test', duration: 120 }], count: 1 } });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    const cases = await page.evaluate(async () => {
      const { playerDuration: d, hasDurationMismatch: mismatch } = await import('/core/media_duration.js');
      if (!mismatch({ duration: 198 }, 394.50557823129253)) throw new Error('Safari doubled timeline not detected');
      if (mismatch({ duration: 198 }, 197.276735) || mismatch({ duration: 198, isLive: true }, 394) || mismatch({ duration: null }, 394)) throw new Error('False duration mismatch');
      return [d({ duration: 120 }, 240), d({ duration: null }, 240), d({ duration: 120, isLive: true }, Infinity), d(null, 240), d({ duration: -1 }, NaN)];
    });
    assert.deepEqual(cases, [120, 240, null, null, null]);
    await page.locator('.card-media').first().click();
    assert.equal(await page.locator('#duration').textContent(), '2:00');
    const rate = await page.locator('audio').evaluate(audio => {
      Object.defineProperty(audio, 'duration', { configurable: true, value: 240 });
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 60 });
      audio.dispatchEvent(new Event('durationchange'));
      audio.dispatchEvent(new Event('timeupdate'));
      return audio.playbackRate;
    });
    assert.equal(await page.locator('#duration').textContent(), '2:00');
    assert.equal(await page.locator('#seek').inputValue(), '500');
    await page.locator('#seek').evaluate(seek => { seek.value = '750'; seek.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('audio').evaluate(audio => audio.currentTime), 60);
    await page.locator('#seek').evaluate(seek => seek.dispatchEvent(new Event('change', { bubbles: true })));
    assert.equal(await page.locator('audio').evaluate(audio => audio.currentTime), 90);
    assert.equal(await page.locator('audio').evaluate(audio => audio.playbackRate), rate);
    const recovery = await page.locator('audio').evaluate(audio => {
      audio.canPlayType = () => 'probably';
      audio.load = () => audio.dispatchEvent(new Event('emptied'));
      Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 4 });
      Object.defineProperty(audio, 'duration', { configurable: true, get: () => /format=(webm|m4a-safe)/.test(audio.src) ? 120 : 240 });
      audio.dispatchEvent(new Event('loadedmetadata'));
      const switched = /format=(webm|m4a-safe)/.test(audio.src);
      audio.dispatchEvent(new Event('loadedmetadata'));
      return { switched, duration: audio.duration, rate: audio.playbackRate };
    });
    if (!recovery.switched) {
      await page.locator('#statusButton').click();
      console.error(await page.locator('#playbackDiagnostics').textContent());
    }
    assert.deepEqual(recovery, { switched: true, duration: 120, rate });
    console.log('PASS: doubled native duration triggers actual source-format recovery');
    console.log('Duration mismatch, fallback, live, progress, seek and unchanged rate: PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
