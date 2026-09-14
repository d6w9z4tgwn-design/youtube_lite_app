// Run with PLAYWRIGHT_PATH pointing to an installed playwright package.
// All content and history requests are fixtures; no user's library is mutated.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.CLIPNEST_URL || 'http://127.0.0.1:8000';
const videos = ['abcdefghijk', 'lmnopqrstuv'].map((id, i) => ({ id, title: `Fixture ${i + 1}`, channel: 'Test', duration: 20 }));
const rate = 48000, frames = rate * 20;
const wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
(async () => {
  const browser = await (process.env.WEBKIT ? webkit.launch() : chromium.launch({ channel: 'chrome', headless: true }));
  try {
    const page = await browser.newPage(); const errors = [];
    await page.addInitScript(() => {
      for (const id of ['ab-loop', 'audio-boost', 'playback-queue']) localStorage.setItem(`clipnest.module.${id}.enabled`, 'false');
      localStorage.setItem('clipnest.module.audio-boost.setting.gain', '1.15');
      const Original = window.AudioContext;
      window.__audioContexts = [];
      window.AudioContext = class extends Original { constructor(options = {}) { super({ ...options, sinkId: { type: 'none' } }); window.__audioContexts.push(this); } };
    });
    page.on('pageerror', e => { errors.push(e.message); console.error('PAGE', e.message); });
    page.on('console', msg => { if (msg.type() === 'error') console.error('BROWSER', msg.text()); });
    page.on('console', msg => { if (msg.type() === 'error' && /モジュール|AudioWorklet|processor/i.test(msg.text())) errors.push(msg.text()); });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/modules' || path === '/api/status') return route.continue();
      if (path.startsWith('/api/media/')) {
        const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
        const first = range ? Number(range[1]) : 0, last = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(first, last + 1),
          headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${wav.length}` } : {}) } });
      }
      return route.fulfill({ json: { items: videos, count: videos.length } });
    });
    await page.goto(base);
    await page.locator('.card-media').first().click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2, null, { timeout: 10000 }).catch(async e => {
      console.error(await page.locator('audio').evaluate(a => ({ src: a.currentSrc, time: a.currentTime, duration: a.duration, paused: a.paused, ready: a.readyState, error: a.error?.message, contexts: window.__audioContexts.map(c => ({ state: c.state, time: c.currentTime })) })));
      throw e;
    });
    const immediateSeek = await page.evaluate(() => {
      document.querySelector('#forward5').click();
      const audio = document.querySelector('audio');
      return { paused: audio.paused, muted: audio.muted };
    });
    assert.deepEqual(immediateSeek, { paused: true, muted: true });
    await page.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return !audio.paused && !audio.muted && !audio.seeking && audio.currentTime >= 5;
    });
    await page.locator('audio').evaluate(audio => audio.pause());
    await page.locator('#back5').click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return !audio.seeking && !audio.muted;
    });
    assert.equal(await page.locator('audio').evaluate(audio => audio.paused), true);
    await page.locator('audio').evaluate(audio => audio.play());
    console.log('PASS: native pause/mute before seek, resume after seek, paused seek stays paused');
    await page.locator('#modulesButton').click();
    const names = await page.locator('.module-manager-copy strong').allTextContents();
    assert.equal(names.length, 11);
    for (const removed of ['A-Bリピート', '音量ブースト', 'Playback Queue', 'Voice Enhancer', 'Stereo Width', 'Smart Speed', 'Loudness Meter', 'Headphone Crossfeed']) assert.ok(!names.includes(removed));
    assert.equal(await page.locator('#standardPlayerTools [data-module-id]').count(), 2);
    assert.equal(await page.getByRole('slider', { name: '音量ブースト', exact: true }).count(), 0);
    const volume = page.getByRole('slider', { name: '音量', exact: true });
    assert.equal(await volume.count(), 1);
    assert.equal(await volume.inputValue(), '0.92'); // old 80% * 115%
    await volume.fill('2');
    assert.equal(await page.locator('audio').evaluate(a => a.volume), 1);
    assert.equal(await page.locator('#volumeValue').textContent(), '200%（ブースト）');
    await volume.fill('0');
    assert.equal(await page.locator('audio').evaluate(a => a.volume), 0);
    await volume.fill('0.8');
    for (const name of names) {
      const row = page.locator('.module-manager-row').filter({ has: page.locator('strong', { hasText: name }) });
      if (!(await row.locator('input').isChecked())) {
        console.log('Enabling', name);
        await row.locator('input').check();
        await page.waitForFunction((name) => localStorage.getItem(`clipnest.module.${name}.enabled`) === 'true', {
          '3D Audio / HRTF': 'spatial-audio', 'Audio Lab': 'audio-lab', 'Headphone Crossfeed': 'crossfeed',
          'VOICEVOX 吹替': 'voice-dubbing', 'RVC 声変換': 'rvc-conversion',
          'Loudness Meter': 'loudness-meter', 'Pitch / Tempo Control': 'pitch-tempo', 'Smart Speed': 'smart-speed',
          'Spectrum Analyzer': 'spectrum-analyzer', 'Stereo Width': 'stereo-width', 'Voice Enhancer': 'voice-enhancer',
          '音量の均一化': 'loudness-normalizer', 'スリープタイマー': 'sleep-timer',
        }[name]);
      }
    }
    await page.locator('#closeModules').click();
    await page.locator('[data-module-id="audio-lab"] button').click();
    const lab = page.getByRole('dialog', { name: 'Audio Lab', exact: true });
    await lab.getByRole('button', { name: '会話をクリアに', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('clipnest.module.equalizer.setting.preset') === '"voice"');
    await lab.getByRole('combobox', { name: 'Audio Lab EQプリセット' }).selectOption('bass');
    await lab.locator('label').filter({ has: page.getByRole('combobox', { name: 'Audio Lab EQプリセット' }) }).getByRole('button', { name: '適用', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('clipnest.module.equalizer.setting.preset') === '"bass"');
    await lab.getByRole('button', { name: '閉じる' }).click();
    await page.locator('[data-module-id="pitch-tempo"] button').click();
    const pitch = page.getByRole('dialog', { name: 'Pitch / Tempo Control', exact: true });
    assert.equal(await pitch.getByRole('combobox', { name: '速度変更の方式' }).inputValue(), 'signalsmith');
    await pitch.getByRole('slider', { name: '音程', exact: true }).fill('5');
    await pitch.getByRole('slider', { name: '基本テンポ', exact: true }).fill('1.5');
    assert.equal(await page.locator('audio').evaluate(a => a.playbackRate), 1.5);
    assert.equal(await page.locator('audio').evaluate(a => a.preservesPitch), false);
    await pitch.getByRole('combobox', { name: '速度変更の方式' }).selectOption('browser');
    assert.equal(await page.locator('audio').evaluate(a => a.preservesPitch), true);
    await pitch.getByRole('combobox', { name: '速度変更の方式' }).selectOption('soundtouch');
    assert.equal(await page.locator('audio').evaluate(a => a.preservesPitch), false);
    await pitch.getByRole('combobox', { name: '速度変更の方式' }).selectOption('signalsmith');
    assert.equal(await page.locator('audio').evaluate(a => a.preservesPitch), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('clipnest.module.pitch-tempo.setting.qualityTempoMode'))), 'signalsmith');
    await pitch.getByRole('button', { name: '閉じる' }).click();
    await page.locator('[data-module-id="playback-bookmark"] button').click();
    const bookmarks = page.getByRole('dialog', { name: 'Playback Bookmark', exact: true });
    await bookmarks.getByRole('textbox').fill('Remember this');
    await bookmarks.getByRole('button', { name: '現在位置を保存' }).click();
    assert.equal(await bookmarks.locator('li').count(), 1);
    await bookmarks.getByRole('button', { name: '閉じる' }).click();
    await page.locator('.queue-add').nth(1).click();
    await page.locator('[data-module-id="playback-queue"] button').click();
    const queue = page.getByRole('dialog', { name: 'Playback Queue', exact: true });
    await queue.getByRole('button', { name: '次を再生', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentSrc.includes('lmnopqrstuv'));
    await queue.getByRole('button', { name: '閉じる' }).click();
    await page.locator('[data-module-id="playback-bookmark"] button').click();
    await bookmarks.getByRole('button', { name: /Remember this/ }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentSrc.includes('abcdefghijk') && document.querySelector('audio').currentTime > 1);
    await bookmarks.getByRole('button', { name: '閉じる' }).click();
    // Queue advances on the real ended event, not only via its Next button.
    await page.locator('.queue-add').nth(1).click();
    await page.locator('audio').evaluate(a => { a.currentTime = a.duration - 0.2; });
    await page.waitForFunction(() => document.querySelector('audio').currentSrc.includes('lmnopqrstuv'));
    console.log('PASS: automatic queue advance');
    await page.locator('#modulesButton').click();
    for (const name of names) {
      const row = page.locator('.module-manager-row').filter({ has: page.locator('strong', { hasText: name }) });
      await row.locator('input').uncheck();
    }
    await page.locator('#closeModules').click();
    assert.equal(await page.locator('.audio-panel').count(), 1); // Built-in queue remains.
    assert.equal(await page.locator('audio').evaluate(a => a.preservesPitch), true);
    assert.equal(await page.locator('#standardPlayerTools [data-module-id]').count(), 2);
    const before = await page.locator('audio').evaluate(a => a.currentTime);
    await page.waitForTimeout(1000);
    const final = await page.locator('audio').evaluate(a => ({ time: a.currentTime, paused: a.paused, ended: a.ended, ready: a.readyState, duration: a.duration, error: a.error?.message }));
    assert.ok(final.time > before, JSON.stringify({ before, final }));
    assert.deepEqual(errors, []);
    console.log('PASS: 11 optional modules, 3 always-on built-ins, Audio Lab, pitch/tempo, queue, bookmarks, cleanup, continuous playback');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
