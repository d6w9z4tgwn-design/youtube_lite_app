import { panel, slider, toggle, effect, smooth, listen } from '/core/module_ui.js';
export default {
  id: 'spatial-audio', name: '3D Audio / HRTF', version: '1.0.0', enabledByDefault: false,
  description: '音を仮想音源として配置。イヤホン向けの方向・高さ・自動回転。',
  activate(ctx) {
    const ac = ctx.audioEngine.ensure(); const panner = ac.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1;
    effect(ctx, 'module.spatial-audio', [panner], 400);
    const { body } = panel(ctx, '3D Audio / HRTF', '音源を一つの位置に配置します。個人の耳形状によって定位感は変わります。');
    let angle = 0, height = 0, distance = 1, orbit = false, speed = 15;
    const update = () => { const rad = angle * Math.PI / 180; smooth(panner.positionX, Math.sin(rad) * distance, ac); smooth(panner.positionZ, -Math.cos(rad) * distance, ac); smooth(panner.positionY, height, ac); };
    slider(ctx, body, 'angle', '方向（0°は正面）', -180, 180, 5, 0, (v) => { angle = v; update(); }, '°');
    slider(ctx, body, 'height', '高さ', -2, 2, 0.1, 0, (v) => { height = v; update(); }, ' m');
    slider(ctx, body, 'distance', '距離', 1, 5, 0.1, 1, (v) => { distance = v; update(); }, ' m');
    toggle(ctx, body, 'orbit', '音を自動回転させる', false, (v) => { orbit = v; });
    slider(ctx, body, 'orbitSpeed', '回転速度', 5, 60, 5, 15, (v) => { speed = v; }, '°/秒');
    const timer = setInterval(() => { if (orbit && !ctx.audio.paused) { angle = (angle + speed / 20) % 360; update(); } }, 50);
    ctx.onCleanup(() => clearInterval(timer));
  },
};
