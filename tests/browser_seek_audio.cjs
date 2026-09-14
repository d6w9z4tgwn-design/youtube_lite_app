// Verify actual post-seek PCM in WebKit, not only HTMLMediaElement timestamps.
const { webkit } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-seek-test-'));
  const fixture = path.join(directory, 'tones.m4a');
  let browser;
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,8)\\,sin(2*PI*220*t)\\,sin(2*PI*1760*t)):s=44100:d=20', '-c:a', 'aac', '-movflags', '+faststart', fixture]);
    browser = await webkit.launch();
    const page = await browser.newPage();
    await page.route('**/api/**', route => route.fulfill({ json: { items: [], count: 0 } }));
    await page.route('**/seek-fixture.m4a', route => route.fulfill({ path: fixture, contentType: 'audio/mp4' }));
    await page.goto(process.env.CLIPNEST_URL || 'http://127.0.0.1:8000');
    const rate = Number(process.env.TEMPO_RATE || 1), semitones = Number(process.env.PITCH_SEMITONES || 12);
    const quality = process.env.QUALITY_PITCH === '1';
    const result = await page.evaluate(async ({ rate, semitones, quality }) => {
      const { SeekGuard } = await import('/core/seek_guard.js');
      const audio = new Audio('/seek-fixture.m4a');
      audio.preservesPitch = false;
      audio.defaultPlaybackRate = rate; audio.playbackRate = rate;
      const ac = new AudioContext();
      let pitch;
      if (quality) {
        const { createQualityPitch } = await import('/core/quality_pitch.js');
        pitch = await createQualityPitch(ac, { loadWorklet: url => ac.audioWorklet.addModule(url) });
      } else {
        await ac.audioWorklet.addModule('/core/pitch_processor.js');
        pitch = new AudioWorkletNode(ac, 'clipnest-pitch', { outputChannelCount: [2] });
      }
      pitch.parameters.get('semitones').setValueAtTime(semitones, ac.currentTime);
      pitch.parameters.get('sourceRate').setValueAtTime(rate, ac.currentTime);
      audio.addEventListener('seekflush', () => pitch.port.postMessage('hold'));
      audio.addEventListener('playing', () => pitch.port.postMessage('resume'));
      const source = ac.createMediaElementSource(audio);
      const rawAnalyser = ac.createAnalyser(); rawAnalyser.fftSize = 4096; rawAnalyser.smoothingTimeConstant = 0;
      source.connect(rawAnalyser);
      let metrics = null;
      pitch.port.onmessage = event => { metrics = event.data; };
      const gate = ac.createGain(), silent = ac.createGain();
      let analyser = ac.createAnalyser();
      analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
      silent.gain.value = 0; // All test sound stays inaudible.
      source.connect(pitch);
      (pitch.output || pitch).connect(gate).connect(analyser).connect(silent).connect(ac.destination);
      const guard = new SeekGuard(audio, blocked => { gate.gain.value = blocked ? 0 : 1; }, { reloadBeforeSeek: () => true });
      const samples = new Float32Array(analyser.frequencyBinCount);
      const peak = () => {
        analyser.getFloatFrequencyData(samples);
        let index = 0;
        for (let i = 1; i < samples.length; i++) if (samples[i] > samples[index]) index = i;
        return { hz: index * ac.sampleRate / analyser.fftSize, db: samples[index] };
      };
      await ac.resume(); await audio.play();
      await new Promise(resolve => setTimeout(resolve, 1600));
      const before = peak();
      const raw = new Float32Array(rawAnalyser.frequencyBinCount); rawAnalyser.getFloatFrequencyData(raw);
      const beforeRawDb = Math.max(...raw), beforeMetrics = metrics;
      guard.seek(12);
      // A new analyser has no pre-seek FFT window; otherwise its previous 93ms
      // would be mistaken for newly emitted stale audio.
      gate.disconnect(analyser); analyser.disconnect();
      analyser = ac.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0;
      gate.connect(analyser).connect(silent);
      const after = [];
      for (let i = 0; i < 25; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        after.push({ ...peak(), active: guard.active });
      }
      audio.pause(); await ac.close();
      return { before, beforeRawDb, beforeMetrics, after, trace: guard.trace, finalRate: audio.playbackRate, duration: audio.duration };
    }, { rate, semitones, quality });
    const expected = 220 * 2 ** (semitones / 12);
    assert.ok(Math.abs(result.before.hz - expected) < Math.max(15, expected * 0.05), JSON.stringify(result));
    assert.equal(result.finalRate, rate);
    assert.ok(Math.abs(result.duration - 20) < 0.1);
    const audible = result.after.filter(sample => sample.db > -45);
    assert.ok(audible.length >= 5, JSON.stringify(result));
    assert.ok(audible.every(sample => Math.abs(sample.hz - expected * 8) < expected * 0.8), JSON.stringify(result));
    console.log(`PASS: WebKit ${quality ? 'Signalsmith' : 'SoundTouch'} ${rate}x / ${semitones} semitones, correct pitch/duration, new segment after seek without old tone`);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
