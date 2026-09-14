// Real WASM DSP, deterministic offline PCM; no media/history/library writes.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/api/**', r => r.fulfill({ json: { items: [] } }));
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    for (const sampleRate of [44100, 48000, 96000]) {
      for (const [rate, semitones] of [[0.5, 0], [0.65, 0], [0.75, 0], [0.5, -12], [0.5, 12], [1, 0]]) {
        const result = await page.evaluate(async ({ rate, semitones, sampleRate }) => {
          const { createQualityPitch } = await import('/core/quality_pitch.js');
          const ac = new OfflineAudioContext(2, sampleRate * 3, sampleRate);
          const node = await createQualityPitch(ac, { loadWorklet: u => ac.audioWorklet.addModule(u) });
          node.parameters.get('sourceRate').setValueAtTime(rate, 0);
          node.parameters.get('semitones').setValueAtTime(semitones, 0);
          const buffer = ac.createBuffer(2, ac.length, sampleRate);
          for (let c = 0; c < 2; c++) {
            const samples = buffer.getChannelData(c), hz = c ? 660 : 440;
            for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin(2 * Math.PI * hz * rate * i / sampleRate);
          }
          const source = new AudioBufferSourceNode(ac, { buffer });
          source.connect(node); node.output.connect(ac.destination); source.start();
          const rendered = await ac.startRendering();
          const channels = [0, 1].map(c => {
            const samples = rendered.getChannelData(c).slice(sampleRate);
            let minRms = Infinity, maxRms = 0, crossings = 0;
            for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
            for (let i = 0; i + 512 <= samples.length; i += 512) {
              let sum = 0;
              for (let j = i; j < i + 512; j++) sum += samples[j] ** 2;
              const rms = Math.sqrt(sum / 512);
              minRms = Math.min(minRms, rms); maxRms = Math.max(maxRms, rms);
            }
            return { hz: crossings / 2, minRms, maxRms, finite: samples.every(Number.isFinite) };
          });
          let bypassError = 0;
          if (rate === 1 && semitones === 0) {
            const dry = buffer.getChannelData(0), wet = rendered.getChannelData(0);
            for (let i = 0; i < dry.length; i++) bypassError = Math.max(bypassError, Math.abs(dry[i] - wet[i]));
          }
          node.port.postMessage('stop'); node.port.close();
          return { channels, bypassError };
        }, { rate, semitones, sampleRate });
        result.channels.forEach((channel, c) => {
          assert.ok(channel.finite);
          assert.ok(channel.minRms > 0.07, JSON.stringify(result));
          assert.ok(channel.maxRms < 0.3, JSON.stringify(result));
          assert.ok(Math.abs(channel.hz - (c ? 660 : 440) * 2 ** (semitones / 12)) < 3, JSON.stringify(result));
        });
        assert.equal(result.bypassError, 0);
        console.log(`PASS: ${sampleRate} Hz, ${rate}x / ${semitones} st: stereo pitch, continuous finite PCM, unity bypass`);
      }
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
