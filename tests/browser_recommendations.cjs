// Fixture-only API traffic: does not change the user's library or contact YouTube.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const preferences = { region: '', language: '', regions: { '': '指定なし', JP: '日本', US: 'United States' }, languages: { '': '指定なし', ja: '日本語', en: 'English' } };
    let refreshes = 0;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/status' || path === '/api/modules') return route.continue();
      if (path === '/api/recommendations/preferences') Object.assign(preferences, route.request().postDataJSON());
      if (path === '/api/recommendations/refresh') {
        refreshes++;
        if (refreshes === 1) return route.fulfill({ status: 503, json: { error: { message: 'テスト取得失敗' } } });
        return route.fulfill({ json: { count: 12, query: '音楽 日本 日本語' } });
      }
      return route.fulfill({ json: { items: [], count: 0, preferences } });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.getByRole('button', { name: '地域・言語の設定', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'おすすめの地域・言語' });
    await dialog.getByLabel('国・地域').selectOption('JP');
    await dialog.getByLabel('優先する言語').selectOption('ja');
    await dialog.getByRole('button', { name: '保存して候補を補充', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '設定は保存済みです。テスト取得失敗' }).waitFor();
    await dialog.getByRole('button', { name: '保存して候補を補充', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '12件の候補を補充しました' }).waitFor();
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.getByRole('button', { name: '地域・言語の設定', exact: true }).click();
    assert.equal(await dialog.getByLabel('国・地域').inputValue(), 'JP');
    assert.equal(await dialog.getByLabel('優先する言語').inputValue(), 'ja');
    await page.keyboard.press('Escape');
    await page.locator('.recommendation-settings').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.recommendation-settings').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Recommendation settings, retry, persistence, mobile layout: PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
