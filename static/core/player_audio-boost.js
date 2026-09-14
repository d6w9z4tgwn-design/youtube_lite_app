'use strict';

export default {
  builtIn: true,
  id: 'audio-boost',
  name: '音量',
  description: '通常音量と100%を超える増幅を1本のバーで調整します。',
  version: '2.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const slider = document.querySelector('#volume');
    const value = document.querySelector('#volumeValue');
    let audioContext, gain;
    try {
      audioContext = ctx.audioEngine.ensure();
      gain = audioContext.createGain();
      ctx.onCleanup(ctx.audioEngine.registerEffect('module.audio-boost', gain, 200));
    } catch {
      slider.max = '1';
      ctx.notify('この環境では増幅を利用できないため、音量は100%までです。', 'error');
    }
    // Migrate the old independent gain once, preserving its effective volume.
    const oldGain = Number(ctx.storage.get('gain', 1));
    const initial = Number(slider.value) * (Number.isFinite(oldGain) ? Math.min(3, Math.max(0, oldGain)) : 1);
    const saved = ctx.storage.get('volume', null);
    const parsed = saved === null ? initial : Number(saved);
    slider.value = String(Number.isFinite(parsed) ? Math.min(Number(slider.max), Math.max(0, parsed)) : 0.8);
    const apply = () => {
      const next = Math.min(Number(slider.max), Math.max(0, Number(slider.value) || 0));
      // Keep native volume within [0, 1]. Only the excess is amplified, rather
      // than multiplying two independent user controls. Never change muted:
      // SeekGuard owns that flag during seeks.
      if (gain) {
        gain.gain.cancelScheduledValues(audioContext.currentTime);
        gain.gain.setValueAtTime(Math.max(1, next), audioContext.currentTime);
      }
      ctx.audio.volume = Math.min(1, next);
      value.textContent = `${Math.round(next * 100)}%${next > 1 ? '（ブースト）' : ''}`;
      slider.setAttribute('aria-valuetext', value.textContent);
      slider.title = '100%を超えると増幅します。音割れや大きな音にご注意ください。';
      ctx.storage.set('volume', next);
    };
    const onInput = () => { apply(); ctx.audioEngine.resume().catch(() => {}); };
    slider.addEventListener('input', onInput);
    ctx.onCleanup(() => slider.removeEventListener('input', onInput));
    apply();
  },
};
