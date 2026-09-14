const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const ids = ['abcdefghijk', 'lmnopqrstuv', '123456789ab', '987654321ab'];
const items = ids.map((id, i) => ({ id, title: `Auto ${i}`, channel: 'Test', duration: 8 }));
const sr = 24000, wav = Buffer.alloc(44 + sr * 8 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    let hold = false, release;
    await page.addInitScript(() => {
      const Original = window.AudioContext;
      window.AudioContext = class extends Original { constructor(options) { super({ ...options, sinkId: { type: 'none' } }); } };
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/modules') return route.fulfill({ json: { items: [] } });
      if (url.pathname.startsWith('/api/media/')) {
        const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
        const first = range ? Number(range[1]) : 0;
        const last = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(first, last + 1),
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${wav.length}` } : {}) } });
      }
      if (url.pathname === '/api/next') {
        const id = url.searchParams.get('videoId');
        if (hold && id === ids[0]) await new Promise(resolve => { release = resolve; });
        const next = id === ids[0] || id === ids[3] ? [items[1]] : id === ids[1] ? [items[0], items[2]] : [];
        return route.fulfill({ json: { items: next } });
      }
      return route.fulfill({ json: { items } });
    });
    const goto = () => page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    const playing = async id => {
      await page.waitForFunction(id => {
        const a = document.querySelector('audio');
        return a.currentSrc.includes(id) && !a.paused && a.currentTime > 0.05;
      }, id);
    };
    const finish = () => page.locator('audio').evaluate(a => { a.currentTime = a.duration - 0.1; });
    await goto();
    await page.locator('.card-media').first().click(); await playing(ids[0]);
    console.log('Playing initial fixture');
    await page.locator('.queue-add').nth(3).click();
    await finish(); await playing(ids[3]); // explicit queue beats related B
    await finish(); await playing(ids[1]); // now queue empty -> related B
    await finish(); await playing(ids[2]); // skip already played A -> C
    await finish();
    await page.waitForFunction(() => document.querySelector('audio').ended);
    await page.waitForTimeout(300);
    assert.ok(await page.locator('audio').evaluate(a => a.currentSrc.includes('123456789ab')));
    console.log('PASS: real ended event, queue priority, related continuation, session repeat avoidance, empty stops');
    await page.locator('#autoplayButton').click();
    await goto();
    assert.equal(await page.locator('#autoplayButton').getAttribute('aria-pressed'), 'false');
    await page.locator('.card-media').first().click(); await playing(ids[0]);
    await finish(); await page.waitForFunction(() => document.querySelector('audio').ended);
    await page.waitForTimeout(300);
    assert.ok(await page.locator('audio').evaluate(a => a.currentSrc.includes('abcdefghijk')));
    console.log('PASS: autoplay OFF and preference restoration');
    await page.locator('#autoplayButton').click();
    await goto();
    hold = true;
    await page.locator('.card-media').first().click(); await playing(ids[0]);
    await finish(); await page.waitForFunction(() => document.querySelector('audio').ended);
    await page.locator('#autoplayButton').click();
    assert.ok(release); release(); hold = false;
    await page.waitForFunction(() => !document.querySelector('#retryUpNext').disabled);
    await page.waitForTimeout(300);
    assert.ok(await page.locator('audio').evaluate(a => a.ended && a.currentSrc.includes('abcdefghijk')));
    console.log('PASS: turning OFF cancels a pending related request without restarting playback');
    await page.locator('#autoplayButton').click();
    await goto(); hold = true;
    await page.locator('.card-media').first().click(); await playing(ids[0]);
    await finish(); await page.waitForFunction(() => document.querySelector('audio').ended);
    await page.locator('.card-media').nth(3).click(); await playing(ids[3]);
    await finish(); await playing(ids[1]);
    release(); hold = false;
    await page.waitForTimeout(300);
    assert.ok(await page.locator('audio').evaluate(a => a.currentSrc.includes('lmnopqrstuv')));
    await page.locator('#loopButton').click();
    await finish(); await page.waitForTimeout(500);
    assert.ok(await page.locator('audio').evaluate(a => a.loop && a.currentSrc.includes('lmnopqrstuv')));
    console.log('PASS: stale request cannot interrupt manual selection or block its next autoplay; repeat takes priority');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
