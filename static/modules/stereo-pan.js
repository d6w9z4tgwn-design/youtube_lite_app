'use strict';

import { inlinePanel } from '../core/module_ui.js';

export default {
  id: 'stereo-pan',
  name: '左右バランス',
  description: '音声を左・中央・右へパンします。',
  version: '1.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const audioContext = ctx.audioEngine.ensure();
    if (typeof audioContext.createStereoPanner !== 'function') {
      throw new Error('このブラウザではStereoPannerNodeを利用できません。');
    }
    const panner = audioContext.createStereoPanner();
    const saved = Number(ctx.storage.get('pan', 0));
    panner.pan.value = Number.isFinite(saved) ? Math.min(1, Math.max(-1, saved)) : 0;
    const unregister = ctx.audioEngine.registerEffect('module.stereo-pan', panner, 300);
    ctx.onCleanup(unregister);

    const group = ctx.ui.createControlGroup('Balance');
    inlinePanel(ctx, group, '左右バランス', '中央を基準に、左右の音量バランスを調整します。');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '-1';
    slider.max = '1';
    slider.step = '0.05';
    slider.value = String(panner.pan.value);
    slider.setAttribute('aria-label', '左右バランス');
    const value = document.createElement('span');
    value.className = 'module-value';

    const refresh = () => {
      const pan = Number(slider.value);
      if (Math.abs(pan) < 0.025) value.textContent = 'C';
      else value.textContent = pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`;
    };
    slider.addEventListener('input', async () => {
      await ctx.audioEngine.resume().catch(() => {});
      const next = Number(slider.value);
      panner.pan.setTargetAtTime(next, audioContext.currentTime, 0.01);
      ctx.storage.set('pan', next);
      refresh();
    });
    group.append(slider, value);
    refresh();
  },
};
