// Optional modules must not leak settings/checks into the standard experience.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(), errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      calls.push(path);
      if (path === '/api/modules') return route.continue();
      if (path === '/api/settings') return route.fulfill({ json: { settings: { defaultRate: 1 }, dataDirectory: '/test/ClipNest' } });
      if (path === '/api/dubbing/settings') return route.fulfill({ json: { settings: { voicevoxPort: 50025, whisperModel: 'small' } } });
      if (path === '/api/diagnostics') return route.fulfill({ json: { appVersion: '2.5.0', ffmpeg: true, notes: [], ytDlp: {} } });
      if (path === '/api/ytdlp/update') return route.fulfill({ json: { state: 'idle' } });
      return route.fulfill({ json: { items: [], count: 0 } });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.waitForFunction(() => document.querySelectorAll('.module-manager-row').length === 11);
    await page.locator('#settingsButton').click();
    await page.locator('#checkDependencies').click();
    await page.waitForFunction(() => document.querySelector('#dependencyResult').textContent.includes('FFmpeg：検出'));
    assert.equal(await page.locator('#settingsDialog').getByText(/VOICEVOX|Whisper|文字起こし/).count(), 0);
    assert.equal(calls.filter(path => path.startsWith('/api/dubbing/')).length, 0);
    await page.locator('#closeSettings').click();
    const row = page.locator('.module-manager-row').filter({ has: page.getByText('VOICEVOX 吹替', { exact: true }) });
    const dialog = page.getByRole('dialog', { name: 'VOICEVOX 吹替', exact: true });
    for (let pass = 0; pass < 2; pass++) {
      await page.locator('#modulesButton').click();
      await row.getByRole('checkbox').check();
      await row.getByRole('button', { name: 'VOICEVOX 吹替の設定を開く', exact: true }).click();
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#playerShell').isVisible(), false); // No video selected.
      const port = dialog.getByRole('spinbutton', { name: 'VOICEVOXエンジンのポート' });
      assert.equal(await port.isVisible(), false);
      await dialog.getByText('詳細：VOICEVOXの接続先', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('input[aria-label="VOICEVOXエンジンのポート"]').value === '50025');
      if (pass === 0) {
        await dialog.getByText('詳細：VOICEVOXの接続先', { exact: true }).click();
        await page.screenshot({ path: '/tmp/clipnest-feature-settings-desktop.png' });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await dialog.evaluate(d => d.scrollWidth <= d.clientWidth));
        await page.screenshot({ path: '/tmp/clipnest-feature-settings-mobile.png' });
      }
      await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
      await page.locator('#modulesButton').click();
      await row.getByRole('checkbox').uncheck();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await row.getByRole('button').count(), 0);
      await page.locator('#closeModules').click();
    }
    assert.equal(calls.filter(path => path === '/api/dubbing/voices' || path === '/api/dubbing/asr-status').length, 0);
    // Inline player controls must also be accessible before choosing a video.
    for (const [id, name, label, value] of [
      ['equalizer', 'イコライザー', 'イコライザー設定', 'voice'],
      ['stereo-pan', '左右バランス', '左右バランス', '0.4'],
      ['loudness-normalizer', '音量の均一化', '音量均一化の強さ', 'clear'],
      ['sleep-timer', 'スリープタイマー', 'スリープタイマー時間', '15'],
    ]) {
      const inlineRow = page.locator('.module-manager-row').filter({ has: page.getByText(name, { exact: true }) });
      const inlineDialog = page.getByRole('dialog', { name, exact: true });
      await page.locator('#modulesButton').click();
      await inlineRow.getByRole('checkbox').check();
      await inlineRow.getByRole('button', { name: `${name}の設定を開く`, exact: true }).click();
      await inlineDialog.waitFor({ state: 'visible' });
      const control = inlineDialog.getByLabel(label, { exact: true });
      if (id === 'stereo-pan') {
        await control.evaluate((input, next) => { input.value = next; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
      } else {
        await control.selectOption(value);
      }
      if (id === 'sleep-timer') await inlineDialog.getByRole('button', { name: '開始', exact: true }).click();
      assert.ok(await inlineDialog.evaluate(d => d.scrollWidth <= d.clientWidth));
      await inlineDialog.getByRole('button', { name: '閉じる', exact: true }).click();
      const playerControl = page.locator(`#moduleRack [data-module-id="${id}"]`);
      await playerControl.waitFor({ state: 'attached' });
      assert.equal(await playerControl.getByLabel(label, { exact: true }).inputValue(), value);
      if (id === 'sleep-timer') assert.equal(await playerControl.locator('button').getAttribute('data-active'), 'true');
      await page.locator('#modulesButton').click();
      await inlineRow.getByRole('button', { name: `${name}の設定を開く`, exact: true }).click();
      assert.equal(await inlineDialog.getByLabel(label, { exact: true }).inputValue(), value);
      assert.equal(await page.locator(`[data-module-id="${id}"]`).count(), 1);
      // Exercise disabling while the module's panel is open, including cleanup of borrowed controls.
      await inlineRow.locator('input[type="checkbox"]').evaluate(input => input.click());
      await inlineDialog.waitFor({ state: 'detached' });
      assert.equal(await page.locator(`[data-module-id="${id}"]`).count(), 0);
      await page.locator('#modulesButton').click();
      await inlineRow.getByRole('checkbox').check();
      await playerControl.waitFor({ state: 'attached' });
      assert.equal(await playerControl.getByLabel(label, { exact: true }).inputValue(), value);
      await page.locator('#closeModules').click();
    }
    assert.equal(await page.locator('#audio').count(), 1);
    assert.equal(await page.locator('#playerShell #audio').count(), 1);
    assert.equal(await page.locator('#volume').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: no optional checks when disabled, module settings without video, inline settings restore/persist, collapsed advanced controls, repeated enable/disable, mobile, single player/volume');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
