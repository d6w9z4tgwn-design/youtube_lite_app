'use strict';

import { inlinePanel } from '../core/module_ui.js';

export default {
  id: 'sleep-timer',
  name: 'スリープタイマー',
  description: '指定時間が経過したら再生を自動で一時停止します。',
  version: '1.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const group = ctx.ui.createControlGroup('Timer');
    inlinePanel(ctx, group, 'スリープタイマー', '指定時間が経過すると再生を一時停止します。');
    const select = document.createElement('select');
    select.className = 'module-select';
    select.setAttribute('aria-label', 'スリープタイマー時間');
    for (const minutes of [5, 15, 30, 45, 60, 90]) {
      const option = document.createElement('option');
      option.value = String(minutes);
      option.textContent = `${minutes}分`;
      select.append(option);
    }
    const savedMinutes = String(ctx.storage.get('minutes', 30));
    select.value = [...select.options].some((option) => option.value === savedMinutes)
      ? savedMinutes
      : '30';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost module-button';
    let deadline = null;
    let timer = null;

    const cancel = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      deadline = null;
      button.textContent = '開始';
      button.dataset.active = 'false';
    };

    const refresh = () => {
      if (deadline === null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        ctx.audio.pause();
        cancel();
        ctx.notify('スリープタイマーで再生を停止しました。', 'info');
        return;
      }
      button.textContent = `残り${Math.ceil(remaining / 60000)}分`;
    };

    button.addEventListener('click', () => {
      if (deadline !== null) {
        cancel();
        ctx.notify('スリープタイマーを解除しました。', 'info');
        return;
      }
      const minutes = Number(select.value);
      ctx.storage.set('minutes', minutes);
      deadline = Date.now() + minutes * 60000;
      button.dataset.active = 'true';
      timer = window.setInterval(refresh, 1000);
      refresh();
      ctx.notify(`${minutes}分後に再生を停止します。`, 'info');
    });
    select.addEventListener('change', () => ctx.storage.set('minutes', Number(select.value)));
    ctx.onCleanup(cancel);

    group.append(select, button);
    cancel();
  },
};
