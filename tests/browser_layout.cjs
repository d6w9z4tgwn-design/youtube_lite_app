// Isolated responsive UI fixtures: no user library writes or remote thumbnails.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const titles = ['週末、知らない街を歩く。京都の小さな旅', '深夜の作業に。静かなピアノと雨の音', 'いつものコーヒーが変わる、朝の10分', '自分だけのデスクをつくる｜ルームツアー', 'はじめてのPython、ここから一緒に', '森の中の小さな家で過ごす休日'];
const items = titles.map((title, i) => ({ id: String(i).padStart(11, '0'), title, channel: ['旅の記録', 'Quiet Piano', '暮らしの時間'][i % 3], channelId: 'UCabcdefghijklmnopqrstuv', thumbnail: `https://i.ytimg.com/vi/${i}/hqdefault.jpg`, duration: 900 + i * 127, viewCount: 30000 + i * 6713 }));
items[0].duration = 30; // Match the real audio fixture, avoiding a false timeline warning.
const wav = Buffer.alloc(44 + 24000 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { const Original = window.AudioContext; window.AudioContext = class extends Original { constructor() { super({ sinkId: { type: 'none' } }); } }; });
    let query = '', relatedEmpty = true, relatedFailure = false;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/modules' || path === '/api/status') return route.continue();
      if (path === '/api/next') return relatedFailure
        ? route.fulfill({ status: 503, json: { error: { message: '関連候補の取得失敗' } } })
        : route.fulfill({ json: { items: relatedEmpty ? [] : [items[1]] } });
      if (path.startsWith('/api/media/')) return route.fulfill({ body: wav, contentType: 'audio/wav' });
      if (path === '/api/search') query = route.request().postDataJSON().query;
      return route.fulfill({ json: { items, count: items.length, channels: [], channelCount: 0, preferences: { region: '', language: '' } } });
    });
    await page.route('https://i.ytimg.com/**', route => {
      const index = Number(new URL(route.request().url()).pathname.split('/')[2]) || 0;
      const color = ['#536e59', '#3c4a60', '#8b7159', '#665e52', '#394e69', '#45615b'][index % 6];
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/><circle cx="480" cy="105" r="70" fill="#ffffff18"/><path d="M0 330 170 140 350 280 460 170 640 330v30H0" fill="#0003"/><text x="35" y="290" fill="white" font-size="35" font-family="sans-serif">${['WEEKEND JOURNAL', 'QUIET HOURS', 'SLOW MORNING', 'MY SPACE', 'LEARN SOMETHING', 'IN THE WOODS'][index % 6]}</text></svg>` });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('.card').count(), 6);
    assert.equal(await page.locator('.grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 3);
    await page.screenshot({ path: '/tmp/clipnest-ui-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'サイドバーを折りたたむ' }).click();
    assert.equal(await page.locator('#menuToggle').getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: 'サイドバーを広げる' }).click();
    await page.locator('.topic-chip[data-query="音楽"]').click();
    await page.waitForFunction(() => document.body.dataset.view === 'search');
    assert.equal(query, '音楽');
    assert.equal(await page.locator('.card').first().evaluate(node => getComputedStyle(node).display), 'grid');
    await page.screenshot({ path: '/tmp/clipnest-ui-search.png', fullPage: true });
    await page.locator('#allTopics').click();
    await page.waitForFunction(() => document.body.dataset.view === 'home');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/clipnest-ui-mobile.png' });
    await page.locator('.card-media').first().click();
    await page.locator('#playerShell').waitFor();
    assert.equal(await page.locator('#playerTools').isVisible(), false);
    await page.locator('#playerSettingsToggle').click();
    assert.equal(await page.locator('#playerTools').isVisible(), true);
    await page.locator('#playerSettingsToggle').click();
    const player = await page.locator('#playerShell').boundingBox(), nav = await page.locator('#libraryNav').boundingBox();
    assert.ok(player.y + player.height <= nav.y + 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/clipnest-ui-mobile-player.png' });
    await page.locator('#libraryNav [data-view="history"]').click();
    await page.waitForFunction(() => document.body.dataset.view === 'history');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#upNextButton').click();
    await page.locator('.up-next-empty').filter({ hasText: '補充しません' }).waitFor();
    relatedEmpty = false;
    await page.locator('#retryUpNext').click();
    await page.locator('.up-next-item').waitFor();
    assert.equal(await page.locator('.up-next-item').count(), 1);
    relatedFailure = true;
    await page.locator('#retryUpNext').click();
    await page.locator('.up-next-empty').filter({ hasText: '補充しません' }).waitFor();
    assert.equal(await page.locator('.up-next-item').count(), 0);
    await page.locator('#closeUpNext').click();
    for (const width of [320, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const search = await page.locator('#searchForm').boundingBox();
      assert.ok(search.x >= 0 && search.x + search.width <= width, `Search overflow at ${width}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log('PASS: desktop sidebar, 3-column feed, topic search, search list, mobile feed/navigation, compact/expanded player, no overflow');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
