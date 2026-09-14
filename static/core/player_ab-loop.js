'use strict';

export default {
  builtIn: true,
  id: 'ab-loop',
  name: 'A-Bリピート',
  description: '任意の2点を指定して、その区間だけを繰り返します。',
  version: '1.0.0',
  enabledByDefault: true,

  activate(ctx) {
    const group = ctx.ui.createControlGroup('A-B');
    let pointA = null;
    let pointB = null;
    let active = false;

    const buttonA = document.createElement('button');
    const buttonB = document.createElement('button');
    const toggle = document.createElement('button');
    const clear = document.createElement('button');
    for (const button of [buttonA, buttonB, toggle, clear]) {
      button.type = 'button';
      button.className = 'ghost module-button';
    }

    const fmt = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };
    const refresh = () => {
      buttonA.textContent = pointA === null ? 'Aを設定' : `A ${fmt(pointA)}`;
      buttonB.textContent = pointB === null ? 'Bを設定' : `B ${fmt(pointB)}`;
      toggle.textContent = active ? '区間ON' : '区間OFF';
      toggle.dataset.active = active ? 'true' : 'false';
    };

    buttonA.addEventListener('click', () => {
      pointA = ctx.audio.currentTime;
      if (pointB !== null && pointA >= pointB) pointB = null;
      refresh();
    });
    buttonB.addEventListener('click', () => {
      pointB = ctx.audio.currentTime;
      if (pointA !== null && pointB <= pointA) pointA = null;
      refresh();
    });
    toggle.addEventListener('click', () => {
      if (pointA === null || pointB === null || pointB <= pointA) {
        ctx.notify('A点とB点を順番に設定してください。', 'info');
        return;
      }
      active = !active;
      refresh();
    });
    clear.addEventListener('click', () => {
      pointA = null;
      pointB = null;
      active = false;
      refresh();
    });
    clear.textContent = '解除';

    const onTime = () => {
      if (active && pointA !== null && pointB !== null && ctx.audio.currentTime >= pointB) {
        ctx.player.seek(pointA);
      }
    };
    const onVideo = () => {
      pointA = null;
      pointB = null;
      active = false;
      refresh();
    };
    ctx.audio.addEventListener('timeupdate', onTime);
    ctx.events.addEventListener('player:videochange', onVideo);
    ctx.onCleanup(() => ctx.audio.removeEventListener('timeupdate', onTime));
    ctx.onCleanup(() => ctx.events.removeEventListener('player:videochange', onVideo));

    group.append(buttonA, buttonB, toggle, clear);
    refresh();
  },
};
