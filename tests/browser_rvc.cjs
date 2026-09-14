// Real audio graph/worklets; fixture HTTP only. Never touches the user's history/models.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.CLIPNEST_URL || 'http://127.0.0.1:8000';
const videos = ['abcdefghijk', 'lmnopqrstuv'].map((id, i) => ({ id, title: `声変換テスト ${i + 1}`, channel: 'Fixture', duration: 60 }));
const preset = { id: 'a'.repeat(32), name: 'ずんだもん（zundamon-1・個人用）', hasIndex: true, personalOnly: true };
function wav(seconds, frequency = 220) {
  const rate = 16000, frames = Math.round(seconds * rate), data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return data;
}
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(), errors = [], calls = [], jobs = new Map(), starts = [], cancelled = [], uploads = [];
    let models = [preset], slow = false, delayedStart, releaseStart;
    const original = wav(60);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const Original = window.AudioContext;
      window.__rvcSources = [];
      window.AudioContext = class extends Original {
        constructor(options = {}) { super({ ...options, sinkId: { type: 'none' } }); }
        createBufferSource() {
          const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node);
          const entry = { stopped: false, node }; window.__rvcSources.push(entry);
          node.start = (...args) => { entry.started = true; return start(...args); };
          node.stop = (...args) => { entry.stopped = true; return stop(...args); };
          node.addEventListener('ended', () => { entry.stopped = true; });
          return node;
        }
      };
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname; calls.push(path);
      if (path === '/api/modules') return route.continue();
      if (path === '/api/settings') return route.fulfill({ json: { settings: { defaultRate: 1 } } });
      if (path === '/api/rvc/status') return route.fulfill({ json: { available: true, models, message: '利用できます。' } });
      if (path === '/api/rvc/start') {
        const payload = route.request().postDataJSON(); starts.push(payload);
        const jobId = String(starts.length).padStart(32, '0');
        const job = { jobId, state: 'running', stage: '人声とBGMを分離中', duration: payload.seconds, processingSeconds: 1.2 };
        jobs.set(jobId, { ...job, state: slow ? 'running' : 'done' });
        if (delayedStart) { const wait = delayedStart; delayedStart = null; await wait; }
        return route.fulfill({ json: job });
      }
      if (path === '/api/rvc/job') return route.fulfill({ json: jobs.get(url.searchParams.get('jobId')) });
      if (path === '/api/rvc/cancel') {
        const { jobId } = route.request().postDataJSON(); cancelled.push(jobId);
        if (jobs.has(jobId)) jobs.get(jobId).state = 'cancelled';
        return route.fulfill({ json: { cancelled: true } });
      }
      if (path === '/api/rvc/audio') return route.fulfill({ contentType: 'audio/wav', body: wav(jobs.get(url.searchParams.get('jobId')).duration, url.searchParams.get('stem') === 'voice' ? 330 : 110) });
      if (path === '/api/rvc/import' || path === '/api/rvc/import-index') {
        uploads.push({ path, headers: route.request().headers(), body: route.request().postDataBuffer() });
        const imported = { id: 'b'.repeat(32), name: url.searchParams.get('name') || '自分の声', hasIndex: path.endsWith('import-index') };
        models = [preset, imported]; return route.fulfill({ json: { modelId: imported.id, models } });
      }
      if (path.startsWith('/api/media/')) {
        const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
        const first = range ? Number(range[1]) : 0, last = range?.[2] ? Math.min(Number(range[2]), original.length - 1) : original.length - 1;
        return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: original.subarray(first, last + 1),
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${original.length}` } : {}) } });
      }
      return route.fulfill({ json: { items: videos, count: videos.length } });
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelectorAll('.module-manager-row').length === 11);
    assert.equal(calls.filter(path => path.startsWith('/api/rvc/')).length, 0);
    await page.locator('#modulesButton').click();
    const row = page.locator('.module-manager-row').filter({ has: page.getByText('RVC 声変換', { exact: true }) });
    await row.getByRole('checkbox').check();
    await row.getByRole('button', { name: 'RVC 声変換の設定を開く', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'RVC 声変換', exact: true });
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'ready');
    assert.equal(await panel.getByRole('combobox', { name: '変換後の声', exact: true }).inputValue(), preset.id);
    assert.equal(await panel.getByRole('button', { name: '声を変えて再生', exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('slider', { name: '変換する声の高さ', exact: true }).isVisible(), false);
    await panel.getByText('詳細調整', { exact: true }).click();
    await panel.getByRole('combobox', { name: '処理デバイス', exact: true }).selectOption('cpu');
    await panel.getByText('詳細調整', { exact: true }).click();
    await panel.getByRole('button', { name: '高速化を有効にする（GPU自動選択）', exact: true }).click();
    assert.equal(await panel.locator('[aria-label="処理デバイス"]').inputValue(), 'auto');
    assert.equal(await panel.getByRole('button', { name: '高速化を有効にする（GPU自動選択）', exact: true }).isVisible(), false);
    await panel.getByRole('button', { name: '声を中心に', exact: true }).click();
    assert.equal(await panel.getByRole('slider', { name: 'BGM', exact: true }).inputValue(), '0.45');
    await panel.getByRole('button', { name: '標準', exact: true }).click();
    await panel.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.locator('.card-media').first().click();
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 0.1);
    await page.locator('#audio').evaluate(audio => { window.__originalAudio = audio; });
    await page.locator('[data-module-id="rvc-conversion"] button').click();
    await page.screenshot({ path: '/tmp/clipnest-rvc-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await panel.evaluate(d => d.scrollWidth <= d.clientWidth));
    await page.screenshot({ path: '/tmp/clipnest-rvc-mobile.png' });
    await panel.getByRole('button', { name: '声を変えて再生', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'loading');
    assert.equal(await page.locator('#audio').evaluate(a => a.paused), true);
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'playing');
    await page.waitForFunction(() => window.__rvcSources.filter(s => s.started && !s.stopped).length >= 2);
    assert.equal(starts[0].modelId, preset.id);
    assert.equal(starts[0].device, 'auto');
    assert.equal(starts[0].seconds, 4);
    assert.equal(await page.locator('#audio').evaluate(a => a === window.__originalAudio && a.duration === 60), true);
    // The existing tempo/pitch module still owns speed; RVC schedules at the same rate.
    const pitchRow = page.locator('.module-manager-row').filter({ has: page.locator('strong', { hasText: 'Pitch / Tempo Control' }) });
    await pitchRow.locator('input[type="checkbox"]').evaluate(input => input.click());
    await page.waitForFunction(() => localStorage.getItem('clipnest.module.pitch-tempo.enabled') === 'true');
    const pitchPanel = page.locator('dialog[aria-label="Pitch / Tempo Control"]');
    await pitchPanel.locator('[aria-label="基本テンポ"]').evaluate(input => { input.value = '0.75'; input.dispatchEvent(new Event('input')); });
    await pitchPanel.locator('[aria-label="音程"]').evaluate(input => { input.value = '3'; input.dispatchEvent(new Event('input')); });
    await page.waitForFunction(() => window.__rvcSources.some(s => s.started && !s.stopped && s.node.playbackRate.value === 0.75));
    assert.equal(await page.locator('#audio').evaluate(a => a.duration === 60 && a.preservesPitch === false), true);
    await pitchPanel.locator('[aria-label="速度変更の方式"]').evaluate(input => { input.value = 'browser'; input.dispatchEvent(new Event('change')); });
    assert.equal(await page.locator('#audio').evaluate(a => a.preservesPitch), true);
    await pitchRow.locator('input[type="checkbox"]').evaluate(input => input.click());
    // Pausing and seeking must stop every scheduled replacement source synchronously.
    await page.locator('#audio').evaluate(a => a.pause());
    await page.waitForFunction(() => window.__rvcSources.every(s => !s.started || s.stopped));
    assert.equal(await panel.getByRole('button', { name: '声変換を使用中', exact: true }).isDisabled(), true);
    await page.locator('#audio').evaluate(a => a.play());
    await page.waitForFunction(() => window.__rvcSources.some(s => s.started && !s.stopped));
    slow = true;
    await page.evaluate(() => {
      const a = document.querySelector('#audio'); a.dispatchEvent(new Event('seekflush')); a.currentTime = 45;
    });
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'loading');
    assert.equal(await page.evaluate(() => window.__rvcSources.every(s => !s.started || s.stopped)), true);
    await panel.getByRole('button', { name: '中止して原音を再生', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'ready' && !document.querySelector('#audio').paused);
    await page.waitForTimeout(500);
    assert.ok(cancelled.length > 0);
    assert.equal(await page.evaluate(() => window.__rvcSources.every(s => !s.started || s.stopped)), true);
    // Binary import: readable form, autofill, trust check, new voice auto-selected.
    await panel.getByText('別の声を追加（モデルのインポート）', { exact: true }).click();
    await panel.getByLabel('RVCモデルファイル', { exact: true }).setInputFiles({ name: '自分の声.pth', mimeType: 'application/octet-stream', buffer: Buffer.from('fixture-weights') });
    assert.equal(await panel.getByLabel('モデルの表示名', { exact: true }).inputValue(), '自分の声');
    await panel.getByLabel('RVC indexファイル（任意）', { exact: true }).setInputFiles({ name: '自分の声.index', mimeType: 'application/octet-stream', buffer: Buffer.from('fixture-index') });
    await panel.getByRole('button', { name: 'モデルをインポート', exact: true }).click();
    assert.equal(uploads.length, 0);
    await panel.getByRole('checkbox', { name: '信頼できる配布元のモデルで、利用条件を確認しました', exact: true }).check();
    await panel.getByRole('button', { name: 'モデルをインポート', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="変換後の声"]').value === 'b'.repeat(32));
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].body.toString(), 'fixture-weights');
    assert.equal(uploads[0].headers['content-type'], 'application/octet-stream');
    // Disable while /start has not yet returned: late job IDs still get cancelled, no auto-resume.
    delayedStart = new Promise(resolve => { releaseStart = resolve; });
    const before = starts.length;
    await panel.getByRole('button', { name: '声を変えて再生', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.rvc-panel').dataset.phase === 'loading');
    for (let i = 0; i < 50 && starts.length === before; i++) await page.waitForTimeout(30);
    assert.ok(starts.length > before);
    await row.locator('input[type="checkbox"]').evaluate(input => input.click());
    await panel.waitFor({ state: 'detached' });
    releaseStart();
    await page.waitForTimeout(500);
    assert.ok(cancelled.includes(String(starts.length).padStart(32, '0')));
    assert.equal(await page.locator('#audio').evaluate(a => a.paused && a === window.__originalAudio && a.duration === 60), true);
    assert.equal(await page.locator('#volume').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: RVC preset, no-file start, progress, mobile, mix presets, original media/duration, pitch/tempo coexistence, pause/seek/cancel, binary import, late-job cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
