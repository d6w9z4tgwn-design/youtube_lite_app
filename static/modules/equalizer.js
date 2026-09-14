'use strict';

import { inlinePanel } from '../core/module_ui.js';

const PRESETS = {
  flat: { label: 'フラット', low: 0, mid: 0, high: 0 },
  bass: { label: '低音強調', low: 7, mid: -1, high: 1 },
  voice: { label: '声を明瞭に', low: -2, mid: 5, high: 3 },
  bright: { label: '高音強調', low: -1, mid: 1, high: 7 },
  night: { label: '夜向け', low: 3, mid: 2, high: -3 },
};

export default {
  id: 'equalizer',
  name: 'イコライザー',
  description: '再生中の音質を用途別の5種類から選べます。',
  version: '1.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const audioContext = ctx.audioEngine.ensure();
    const low = audioContext.createBiquadFilter();
    const mid = audioContext.createBiquadFilter();
    const high = audioContext.createBiquadFilter();

    low.type = 'lowshelf';
    low.frequency.value = 180;
    mid.type = 'peaking';
    mid.frequency.value = 1200;
    mid.Q.value = 0.8;
    high.type = 'highshelf';
    high.frequency.value = 4800;
    low.connect(mid);
    mid.connect(high);

    const unregister = ctx.audioEngine.registerEffect(
      'module.equalizer',
      low,
      100,
      high,
    );
    ctx.onCleanup(() => {
      unregister();
      try { low.disconnect(); } catch {}
      try { mid.disconnect(); } catch {}
      try { high.disconnect(); } catch {}
    });

    const group = ctx.ui.createControlGroup('EQ');
    inlinePanel(ctx, group, 'イコライザー', '再生中の音質を用途に合わせて選べます。');
    const select = document.createElement('select');
    select.className = 'module-select';
    select.setAttribute('aria-label', 'イコライザー設定');
    for (const [value, preset] of Object.entries(PRESETS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = preset.label;
      select.append(option);
    }

    const apply = async (presetId, immediate = false) => {
      const preset = PRESETS[presetId] || PRESETS.flat;
      const time = audioContext.currentTime;
      const transition = immediate ? 0 : 0.025;
      low.gain.setTargetAtTime(preset.low, time, transition || 0.001);
      mid.gain.setTargetAtTime(preset.mid, time, transition || 0.001);
      high.gain.setTargetAtTime(preset.high, time, transition || 0.001);
      select.value = PRESETS[presetId] ? presetId : 'flat';
      ctx.storage.set('preset', select.value);
      if (!ctx.audio.paused) await ctx.audioEngine.resume().catch(() => {});
    };

    select.addEventListener('change', () => apply(select.value));
    ctx.registerControl('preset', apply);
    group.append(select);
    apply(String(ctx.storage.get('preset', 'flat')), true);
  },
};
