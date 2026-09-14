const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const rate = 24000, frames = rate * 2, wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(), errors = [], requests = [];
    let available = false, finished = true, cancelled = 0;
    let settings = { voicevoxPort: 50025, whisperModel: 'small' };
    const settingRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ json: { items: [], count: 0 } }));
    await page.route('**/api/dubbing/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/settings')) {
        if (route.request().method() === 'POST') { const patch = route.request().postDataJSON(); settingRequests.push(patch); settings = { ...settings, ...patch }; }
        return route.fulfill({ json: { settings } });
      }
      if (path.endsWith('/voices')) return route.fulfill({ json: { voices: [{ id: 1, name: 'Fixture', style: 'Normal' }] } });
      if (path.endsWith('/subtitles')) return route.fulfill({ status: 503, json: { error: { message: '字幕なし' } } });
      if (path.endsWith('/asr-status')) return route.fulfill({ json: { available, installation: 'requirements-voice.txt を導入してください' } });
      if (path.endsWith('/transcribe/cancel')) { cancelled++; return route.fulfill({ json: { cancelled: true } }); }
      if (path.endsWith('/transcribe')) { requests.push(route.request().postDataJSON()); return route.fulfill({ json: { jobId: 'a'.repeat(32) } }); }
      if (path.endsWith('/transcription')) return route.fulfill({ json: { status: finished ? 'done' : 'running', stage: '音声認識中', start: 0, end: 300, cues: [{ start: 0, end: 5, text: 'テスト音声' }, { start: 5, end: 10, text: '次の音声' }] } });
      if (path.endsWith('/synthesize')) return route.fulfill({ contentType: 'audio/wav', body: wav });
      return route.fulfill({ json: {} });
    });
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    await page.evaluate(async () => {
      const module = (await import('/modules/voice-dubbing.js')).default;
      const cleanup = [], ac = new AudioContext({ sinkId: { type: 'none' } });
      const Original = window.Audio;
      window.Audio = class extends Original { constructor(...args) { super(...args); window.testSpeech = this; } };
      const master = Object.assign(new EventTarget(), { currentTime: 0, paused: true, seeking: false, readyState: 4, volume: 0, playbackRate: 1,
        pause() { this.paused = true; this.dispatchEvent(new Event('pause')); } });
      window.fixture = { master, events: new EventTarget(), video: { id: 'abcdefghijk' }, cleanup: () => { cleanup.reverse().forEach(fn => fn()); ac.close(); } };
      module.activate({ audio: master, events: fixture.events, getCurrentVideo: () => fixture.video,
        audioEngine: { ensure: () => ac, registerEffect: (_id, node) => { fixture.gain = node; return () => {}; } },
        ui: { createControlGroup: () => { const group = document.createElement('div'); document.querySelector('main').append(group); return group; } },
        storage: { get: (_key, value) => value, set: () => {} }, registerControl: () => {}, onCleanup: fn => cleanup.push(fn) });
    });
    await page.getByRole('button', { name: 'VOICEVOX 吹替', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'VOICEVOX 吹替' });
    const port = dialog.getByRole('spinbutton', { name: 'VOICEVOXエンジンのポート' });
    assert.equal(await port.isVisible(), false);
    await dialog.getByText('詳細：VOICEVOXの接続先', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="VOICEVOXエンジンのポート"]').value === '50025');
    await port.fill('50026');
    await dialog.getByRole('button', { name: '接続先を保存', exact: true }).click();
    await dialog.getByText('保存しました。吹替機能の設定だけを変更しました。', { exact: true }).waitFor();
    assert.deepEqual(settingRequests[0], { voicevoxPort: 50026 });
    assert.equal(settings.whisperModel, 'small');
    await dialog.getByText('字幕がない場合：文字起こし', { exact: true }).click();
    assert.equal(await dialog.getByRole('combobox', { name: '文字起こしモデル', exact: true }).inputValue(), 'small');
    await dialog.getByRole('combobox', { name: '文字起こしモデル', exact: true }).selectOption('tiny');
    const modelSaved = page.waitForResponse(r => r.url().endsWith('/api/dubbing/settings') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'モデル設定を保存', exact: true }).click();
    await modelSaved;
    assert.deepEqual(settingRequests[1], { whisperModel: 'tiny' });
    assert.equal(requests.length, 0); // Saving a model must never start recognition or download it.
    await dialog.getByRole('button', { name: '話者一覧を取得', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('select[aria-label="吹替の声"]').value === '1');
    const start = dialog.getByRole('button', { name: '字幕なし：現在位置から5分を文字起こし', exact: true });
    await start.click();
    await dialog.getByRole('status').filter({ hasText: 'requirements-voice' }).waitFor();
    available = true;
    await dialog.getByRole('button', { name: 'この動画から吹替を準備（ファイル不要）', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '文字起こしが完了' }).waitFor();
    assert.equal(requests[0].downloadModel, false);
    await dialog.getByRole('button', { name: '吹替を開始', exact: true }).click();
    await page.waitForFunction(() => fixture.gain.gain.value === 0);
    await page.evaluate(() => { fixture.master.paused = false; });
    await page.waitForFunction(() => testSpeech.currentTime > 0.1);
    await page.evaluate(() => fixture.master.pause());
    assert.equal(await page.evaluate(() => testSpeech.paused), true);
    const portSaved = page.waitForResponse(r => r.url().endsWith('/api/dubbing/settings') && r.request().method() === 'POST');
    await port.fill('50027');
    await dialog.getByRole('button', { name: '接続先を保存', exact: true }).click();
    await portSaved;
    await page.waitForFunction(() => fixture.gain.gain.value === 1);
    assert.equal(await page.evaluate(() => testSpeech.paused), true);
    assert.equal(await dialog.getByRole('combobox', { name: '吹替の声', exact: true }).inputValue(), '');
    await dialog.getByRole('button', { name: '吹替を停止・元の音声に戻す', exact: true }).click();
    assert.equal(await page.evaluate(() => fixture.gain.gain.value), 1);
    finished = false;
    await dialog.getByRole('checkbox').check();
    await start.click();
    await dialog.getByRole('status').filter({ hasText: '音声認識中' }).waitFor();
    assert.equal(requests[1].downloadModel, true);
    await page.evaluate(() => { fixture.video = { id: 'lmnopqrstuv' }; fixture.events.dispatchEvent(new Event('player:videochange')); });
    await dialog.getByRole('status').filter({ hasText: '動画が変わりました' }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(cancelled, 1);
    await page.evaluate(() => fixture.cleanup());
    assert.deepEqual(errors, []);
    console.log('PASS: module-only settings, hidden port, saved config migration, no implicit model download, ASR to TTS, pause/restore/cancellation/cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
