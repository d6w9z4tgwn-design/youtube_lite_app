const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const items = Array.from({ length: 95 }, (_, i) => ({ id: String(i).padStart(11, '0'), title: `候補 ${i}`, channel: 'Fixture', duration: 60 }));
    let requests = 0, fail = false, delayed = false, release;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/modules') return route.fulfill({ json: { items: [] } });
      if (url.pathname === '/api/home') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (offset) {
          requests++;
          if (delayed) await new Promise(resolve => { release = resolve; });
          if (fail) return route.fulfill({ status: 503, json: { error: { message: 'fixture error' } } });
        }
        return route.fulfill({ json: { items: offset ? items.slice(47) : items.slice(0, 48), hasMore: !offset, nextOffset: offset ? 96 : 48 } });
      }
      return route.fulfill({ json: { items: [items[0]] } });
    });
    await page.route('https://i.ytimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>' }));
    const goto = async () => {
      await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
      await page.waitForFunction(() => document.querySelectorAll('.video-card').length === 48 || document.querySelectorAll('.card-media').length === 48);
    };
    const near = () => page.evaluate(() => {
      const top = document.querySelector('#homeMore').getBoundingClientRect().top + scrollY;
      scrollTo(0, top - innerHeight - 1000);
      return document.documentElement.scrollHeight - innerHeight - scrollY;
    });
    await goto();
    assert.ok(await near() > 500, 'Preload before reaching the bottom');
    await page.waitForFunction(() => document.querySelectorAll('.card-media').length === 95);
    assert.equal(requests, 1);
    assert.equal(await page.locator('#homeMore').isVisible(), false);
    console.log('PASS: early preload, append without duplicate, finite end');
    fail = true; await goto(); await near();
    await page.waitForFunction(() => document.querySelector('#homeMoreStatus').textContent.includes('再試行'));
    const previous = requests; await page.waitForTimeout(350); assert.equal(requests, previous);
    fail = false; await page.locator('#loadMoreHome').click();
    await page.waitForFunction(() => document.querySelectorAll('.card-media').length === 95);
    console.log('PASS: failure preserves feed, no retry loop, manual retry');
    await goto(); delayed = true; await near();
    await page.waitForFunction(() => document.querySelector('#loadMoreHome').disabled);
    await page.locator('[data-view="history"]').first().click();
    await page.waitForFunction(() => document.querySelector('#pageTitle').textContent === '視聴履歴');
    release(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.card-media').count(), 1);
    assert.equal(await page.locator('#homeMore').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: stale home response cannot enter another view');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
