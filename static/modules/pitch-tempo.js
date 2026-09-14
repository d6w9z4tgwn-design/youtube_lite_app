import { panel, slider, button, listen, text } from '/core/module_ui.js';
import { createQualityPitch } from '/core/quality_pitch.js';
export default {
  id: 'pitch-tempo', name: 'Pitch / Tempo Control', version: '3.0.0', enabledByDefault: false,
  description: 'Signalsmith Stretchによる音質優先の音程・速度補正。',
  async activate(ctx) {
    const ac = ctx.audioEngine.ensure();
    const node = await createQualityPitch(ac, ctx.audioEngine);
    const unregister = ctx.audioEngine.registerEffect('module.pitch-tempo', node, 50, node.output);
    listen(ctx, ctx.audio, 'seekflush', () => node.port.postMessage('hold'));
    listen(ctx, ctx.audio, 'seeking', () => node.port.postMessage('hold'));
    listen(ctx, ctx.audio, 'emptied', () => node.port.postMessage('hold'));
    listen(ctx, ctx.audio, 'playing', () => node.port.postMessage('resume'));
    listen(ctx, ctx.events, 'player:replacementhold', () => node.port.postMessage('hold'));
    listen(ctx, ctx.events, 'player:replacementresume', () => node.port.postMessage('resume'));
    ctx.onCleanup(() => { unregister(); node.port.postMessage('stop'); node.disconnect(); node.port.close(); });
    const { body } = panel(ctx, 'Pitch / Tempo Control', '音程：±12半音。音質優先モードはSignalsmith Stretch（WASM）で周波数成分を処理します。120msの解析窓と細かい重ね合わせを使用。大幅な低速化では音のにじみが残る場合があります。');
    const modeRow = document.createElement('label'); modeRow.className = 'audio-slider';
    text(modeRow, '速度変更の方式', 'span');
    const mode = document.createElement('select'); mode.className = 'module-select'; mode.setAttribute('aria-label', '速度変更の方式');
    let failed = false;
    mode.add(new Option('音質優先：Signalsmith Stretch', 'signalsmith'));
    mode.add(new Option('SoundTouch：速度と音程をまとめて補正', 'soundtouch'));
    mode.add(new Option('ブラウザ標準：従来の方式', 'browser'));
    // Separate preference migrates existing WSOLA users to the new quality mode
    // once, while preserving comparisons explicitly chosen after this upgrade.
    const savedMode = ctx.storage.get('qualityTempoMode', 'signalsmith');
    mode.value = ['signalsmith', 'soundtouch', 'browser'].includes(savedMode) ? savedMode : 'signalsmith';
    modeRow.append(mode); body.append(modeRow);
    text(body, `音質優先の処理遅延：約${Math.round(node.latency * 1000)}ms。ブラウザの音程保持との二重処理は行いません。旧方式と比較できます。VOICEVOXの吹替音声には適用されません。`).className = 'module-note';
    text(body, 'Safari系は2倍以下を推奨します。3倍からの再生開始では、従来方式でも元音声が無音になるケースを確認しています。').className = 'module-note';
    const updateSourceRate = rate => node.parameters.get('sourceRate').setValueAtTime(rate, ac.currentTime);
    const applyMode = () => {
      if (failed) return;
      node.setMode(mode.value);
      node.port.postMessage('reset');
      if (mode.value !== 'browser') ctx.player.setTempoProcessor(updateSourceRate);
      else { updateSourceRate(1); ctx.player.setTempoProcessor(null); }
      ctx.storage.set('qualityTempoMode', mode.value);
    };
    listen(ctx, mode, 'change', applyMode);
    // Native reload/ratechange events must agree with the current decoder rate.
    listen(ctx, ctx.audio, 'ratechange', () => { if (mode.value !== 'browser') updateSourceRate(ctx.audio.playbackRate); });
    listen(ctx, node, 'processorerror', () => {
      failed = true; mode.value = 'browser'; mode.disabled = true;
      updateSourceRate(1); ctx.player.setTempoProcessor(null); unregister();
      ctx.notify('音声処理が停止したためブラウザ標準へ戻しました。モジュールをOFF→ONで再起動できます。', 'error');
    });
    ctx.onCleanup(() => { updateSourceRate(1); ctx.player.setTempoProcessor(null); });
    applyMode();
    const pitch = slider(ctx, body, 'pitch', '音程', -12, 12, 1, 0, (v) => node.parameters.get('semitones').setValueAtTime(v, ac.currentTime), ' 半音');
    // The shared player owns tempo; enabling this module must not restore a stale rate.
    ctx.storage.set('tempo', ctx.player.getRate());
    const tempo = slider(ctx, body, 'tempo', '基本テンポ', 0.5, 3, 0.05, 1, (v) => ctx.player.setRate(v), '×');
    const status = text(body, '');
    const refresh = () => { tempo.input.value = String(ctx.player.getRate()); tempo.input.previousElementSibling.textContent = `${ctx.player.getRate().toFixed(2)}×`; status.textContent = `実際の再生速度 ${ctx.audio.playbackRate.toFixed(2)}×`; };
    listen(ctx, ctx.events, 'player:baserate', refresh); refresh();
    button(body, '音程・テンポをリセット', () => { pitch.set(0); tempo.set(1); });
  },
};
