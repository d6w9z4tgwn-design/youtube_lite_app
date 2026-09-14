const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('static/core/player_audio-boost.js', 'utf8').replace('export default', 'globalThis.feature =');
function setup(saved = {}, unavailable = false) {
  const listeners = new Map(), cleanups = [];
  const slider = { value: '0.8', max: '3', setAttribute() {},
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const label = {};
  const gain = { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; } } };
  const ac = { currentTime: 0, createGain: () => gain };
  const audio = { volume: 1, muted: true };
  const storage = new Map(Object.entries(saved));
  const sandbox = { document: { querySelector: id => id === '#volume' ? slider : label } };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  sandbox.feature.activate({ audio,
    audioEngine: { ensure() { if (unavailable) throw Error('Unavailable'); return ac; },
      registerEffect: () => () => {}, resume: async () => {} },
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, v) => storage.set(key, v) },
    notify() {}, onCleanup: fn => cleanups.push(fn),
  });
  return { slider, gain, audio, storage, label, cleanups, listeners,
    set(v) { slider.value = String(v); listeners.get('input')(); } };
}
const control = setup({ gain: 1.15 });
assert.ok(Math.abs(control.audio.volume - 0.92) < 1e-12);
for (const volume of [0, 0.5, 1, 1.01, 2, 3, 0.8]) {
  control.set(volume);
  assert.equal(control.audio.volume * control.gain.gain.value, volume);
  assert.ok(control.audio.volume <= 1);
  assert.equal(control.audio.muted, true, 'Do not unmute a seek');
  assert.equal(control.storage.get('volume'), volume);
  const restored = setup(Object.fromEntries(control.storage));
  assert.equal(restored.audio.volume * restored.gain.gain.value, volume);
}
assert.equal(setup({ gain: 3, volume: 0 }).audio.volume, 0);
const fallback = setup({ volume: 2 }, true);
assert.equal(fallback.slider.max, '1');
assert.equal(fallback.audio.volume, 1);
fallback.set(0.5); assert.equal(fallback.audio.volume, 0.5);
control.cleanups.reverse().forEach(fn => fn());
assert.equal(control.listeners.size, 0);
console.log('PASS: unified 0–300% volume, gain product, migration/persistence, seek mute, native fallback, cleanup');
