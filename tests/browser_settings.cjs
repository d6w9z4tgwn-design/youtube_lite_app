// Uses an isolated browser; runtime settings are mocked, no user's data is changed.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    let settings = { defaultRate: 1 };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/modules') return route.continue();
      if (path === '/api/settings') {
        if (route.request().method() === 'POST') settings = route.request().postDataJSON();
        return route.fulfill({ json: { settings, dataDirectory: '/test/ClipNest', canQuit: true } });
      }
      if (path === '/api/diagnostics') return route.fulfill({ json: {
        appVersion: '2.5.0', platform: 'darwin', architecture: 'arm64', ytDlp: { currentVersion: '2026.08.19' },
        ffmpeg: true, notes: [],
      } });
      if ((path === '/api/ytdlp/update' || path === '/api/ytdlp/reset') && route.request().method() === 'POST') {
        return route.fulfill({ status: 503, json: { error: { message: '更新処理に接続できませんでした。' } } });
      }
      if (path === '/api/ytdlp/update') return route.fulfill({ json: { state: 'idle', message: '更新は自動実行しません。' } });
      return route.fulfill({ json: { items: [], count: 0 } });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.locator('#settingsButton').click();
    await page.waitForFunction(() => !document.querySelector('#settingsSave').disabled);
    assert.equal(await page.locator('#settingsDialog').getByText(/VOICEVOX|Whisper/).count(), 0);
    await page.locator('#defaultRate').selectOption('0.75');
    await page.locator('#settingsSave').click();
    await page.waitForFunction(() => document.querySelector('#settingsMessage').textContent.includes('保存しました'));
    assert.deepEqual(settings, { defaultRate: 0.75 });
    assert.equal(await page.locator('#rate').inputValue(), '0.75');
    await page.locator('#checkDependencies').click();
    await page.waitForFunction(() => document.querySelector('#dependencyResult').textContent.includes('FFmpeg：検出'));
    for (const button of ['#updateYtdlp', '#resetYtdlp']) {
      await page.locator('#ytdlpUpdateMessage').evaluate(message => { message.textContent = ''; });
      await page.locator(button).click();
      await page.waitForFunction(() => document.querySelector('#ytdlpUpdateMessage').textContent === '更新処理に接続できませんでした。');
      assert.ok((await page.locator('#settingsMessage').textContent()).includes('保存しました'));
    }
    const downloaded = page.waitForEvent('download');
    await page.locator('#saveDiagnostics').click();
    assert.equal((await downloaded).suggestedFilename(), 'clipnest-diagnostics.json');
    await page.screenshot({ path: '/tmp/clipnest-settings-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#settingsDialog').evaluate(d => d.scrollWidth <= d.clientWidth));
    await page.screenshot({ path: '/tmp/clipnest-settings-mobile.png' });
    await page.locator('#closeSettings').click();
    assert.equal(await page.locator('#audio').count(), 1);
    assert.equal(await page.locator('#volume').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: settings/save, current rate, dependencies, safe download, mobile and unchanged player nodes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
