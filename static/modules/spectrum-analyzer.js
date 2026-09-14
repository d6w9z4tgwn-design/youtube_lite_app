import { panel, toggle, frameLoop, text } from '/core/module_ui.js';
export default {
  id: 'spectrum-analyzer', name: 'Spectrum Analyzer', version: '1.0.0', enabledByDefault: false,
  description: '処理後の周波数スペクトルと波形をリアルタイム表示。',
  activate(ctx) {
    const ac = ctx.audioEngine.ensure(), analyser = ac.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.7;
    const untap = ctx.audioEngine.tap(analyser);
    ctx.onCleanup(() => { untap(); analyser.disconnect(); });
    const { body, dialog } = panel(ctx, 'Spectrum Analyzer', '音声処理後・ブラウザ音量を含むデジタル信号を表示。表示中のみ描画します。');
    let frozen = false;
    toggle(ctx, body, 'freeze', '表示を固定', false, (v) => { frozen = v; });
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 300; canvas.setAttribute('aria-label', '上段：周波数スペクトル、下段：波形'); body.append(canvas);
    text(body, '20 Hz　　　　　　　　　1 kHz　　　　　　　　　20 kHz').className = 'module-note';
    const paint = canvas.getContext('2d'), bins = new Float32Array(analyser.frequencyBinCount), wave = new Float32Array(analyser.fftSize);
    frameLoop(ctx, () => {
      if (!dialog.open || frozen || document.hidden) return;
      analyser.getFloatFrequencyData(bins); analyser.getFloatTimeDomainData(wave);
      paint.fillStyle = '#10141f'; paint.fillRect(0, 0, 800, 300);
      for (let x = 0; x < 800; x += 5) {
        const hz = 20 * (Math.min(20000, ac.sampleRate / 2) / 20) ** (x / 800);
        const bin = Math.min(bins.length - 1, Math.round(hz * analyser.fftSize / ac.sampleRate));
        const height = Math.max(0, Math.min(160, (bins[bin] + 100) * 1.6));
        paint.fillStyle = '#6ad6d0'; paint.fillRect(x, 170 - height, 3, height);
      }
      paint.strokeStyle = '#c1a3ff'; paint.lineWidth = 1.5; paint.beginPath();
      for (let x = 0; x < 800; x++) { const y = 235 - wave[Math.floor(x * wave.length / 800)] * 55; if (x) paint.lineTo(x, y); else paint.moveTo(x, y); }
      paint.stroke();
    });
  },
};
