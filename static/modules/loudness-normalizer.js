'use strict';

import { inlinePanel } from '../core/module_ui.js';

const MODES = {
  natural: { label: '自然', threshold: -18, knee: 18, ratio: 2.5, attack: 0.02, release: 0.25 },
  clear: { label: 'くっきり', threshold: -25, knee: 14, ratio: 4, attack: 0.012, release: 0.2 },
  strong: { label: '強め', threshold: -34, knee: 10, ratio: 7, attack: 0.008, release: 0.16 },
};

export default {
  id: 'loudness-normalizer',
  name: '音量の均一化',
  description: '小さい音と大きい音の差を抑え、聞き取りやすくします。',
  version: '1.0.0',
  enabledByDefault: false,

  activate(ctx) {
    const audioContext = ctx.audioEngine.ensure();
    const compressor = audioContext.createDynamicsCompressor();
    const unregister = ctx.audioEngine.registerEffect(
      'module.loudness-normalizer',
      compressor,
      150,
    );
    ctx.onCleanup(unregister);

    const group = ctx.ui.createControlGroup('均一化');
    inlinePanel(ctx, group, '音量の均一化', '小さい音と大きい音の差を抑えます。');
    const select = document.createElement('select');
    select.className = 'module-select';
    select.setAttribute('aria-label', '音量均一化の強さ');
    for (const [value, mode] of Object.entries(MODES)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = mode.label;
      select.append(option);
    }

    const apply = async (modeId) => {
      const mode = MODES[modeId] || MODES.natural;
      const now = audioContext.currentTime;
      compressor.threshold.setTargetAtTime(mode.threshold, now, 0.02);
      compressor.knee.setTargetAtTime(mode.knee, now, 0.02);
      compressor.ratio.setTargetAtTime(mode.ratio, now, 0.02);
      compressor.attack.setTargetAtTime(mode.attack, now, 0.02);
      compressor.release.setTargetAtTime(mode.release, now, 0.02);
      select.value = MODES[modeId] ? modeId : 'natural';
      ctx.storage.set('mode', select.value);
      if (!ctx.audio.paused) await ctx.audioEngine.resume().catch(() => {});
    };

    select.addEventListener('change', () => apply(select.value));
    ctx.registerControl('mode', apply);
    group.append(select);
    apply(String(ctx.storage.get('mode', 'natural')));
  },
};
