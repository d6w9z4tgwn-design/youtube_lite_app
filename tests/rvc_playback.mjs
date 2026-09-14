// Deterministic long-video/seek tests; no ML models, network or user data.
import assert from 'node:assert/strict';
import { RVCPlayback } from '../static/core/rvc_playback.js';

class Audio extends EventTarget {
  currentTime = 123.456; duration = 3600; paused = true; muted = false;
  readyState = 4; seeking = false; playbackRate = 1; preservesPitch = true; volume = .7;
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')); }
}
const audio = new Audio(), sources = [], requests = [], cleanups = [];
const gain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
const ac = {
  currentTime: 0, createGain: gain,
  createBufferSource() {
    const source = { playbackRate: { value: 1 }, connect() {}, disconnect() { this.disconnected = true; },
      start(when, offset, duration) { this.when = when; this.offset = offset; this.duration = duration; },
      stop() { this.stopped = true; } };
    sources.push(source); return source;
  },
};
const correction = { ...gain(), output: gain(), port: { postMessage() {}, close() {} },
  parameters: new Map([['sourceRate', { setValueAtTime() {} }]]) };
const ctx = { audio, events: new EventTarget(), getCurrentVideo: () => ({ id: 'abcdefghijk', duration: 3600 }),
  audioEngine: { ensure: () => ac, resume: async () => {}, registerEffect: () => () => {} }, onCleanup: fn => cleanups.push(fn) };
const getChunk = (start, signal, seconds) => new Promise((resolve, reject) => {
  const request = { start, seconds, signal, finish: () => resolve({ duration: seconds, voice: { duration: seconds }, background: { duration: seconds } }) };
  signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  requests.push(request);
});
const playback = new RVCPlayback(ctx, correction, getChunk, () => {});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const advance = async position => { ac.currentTime += (position - audio.currentTime) / audio.playbackRate; audio.currentTime = position; playback.tick(); await settle(); };
try {
  const start = playback.start();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].start, 123.456);
  assert.equal(requests[0].seconds, 4);
  assert.equal(audio.paused, true);
  requests[0].finish(); await start; await settle();
  assert.equal(audio.paused, false); // Starts while every later part of a 60-minute video is unconverted.
  assert.equal(audio.currentTime, 123.456);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].seconds, 8);
  assert.equal(requests[1].start, requests[0].start + 4);
  requests[1].finish(); await settle(); playback.tick();
  await advance(requests[1].start);
  assert.equal(requests[2].seconds, 20);
  assert.equal(requests[2].start, requests[1].start + 8);
  for (let i = 2; i < 10; i++) {
    requests[i].finish(); await settle(); playback.tick();
    await advance(requests[i].start);
    assert.equal(requests[i + 1].seconds, 20);
    assert.equal(requests[i + 1].start, requests[i].start + 20);
    assert.ok(playback.cache.size <= 4);
    assert.ok(playback.scheduled.size <= 2);
  }
  // Crossing into a not-yet-ready chunk stops the old PCM until it is ready.
  const delayed = requests.at(-1);
  await advance(delayed.start + .04);
  assert.equal(audio.paused, true);
  assert.ok(sources.every(source => source.stopped || source.disconnected));
  delayed.finish(); await settle();
  assert.equal(audio.paused, false);
  assert.ok(playback.at(audio.currentTime));
  // Paused seek to an already cached interval stays paused and does not re-convert it.
  audio.pause();
  const cached = [...playback.cache.values()][0];
  audio.dispatchEvent(new Event('seekflush')); audio.currentTime = cached.start + .5;
  audio.dispatchEvent(new Event('seeking')); audio.dispatchEvent(new Event('seeked'));
  await settle();
  const before = requests.length;
  assert.equal(audio.paused, true);
  await audio.play(); await settle();
  assert.equal(requests.length, before);
  // An uncached target at 35 minutes starts a new four-second head, never a whole-video conversion.
  audio.dispatchEvent(new Event('seekflush')); audio.currentTime = 2100.25;
  audio.dispatchEvent(new Event('seeking')); audio.dispatchEvent(new Event('seeked'));
  await settle();
  assert.equal(requests.at(-1).start, 2100.25);
  assert.equal(requests.at(-1).seconds, 4);
  assert.equal(audio.paused, true);
  const stale = requests.at(-1);
  playback.stop(); stale.finish(); await settle();
  assert.equal(audio.paused, true);
  assert.equal(playback.active, false);
  assert.ok(sources.every(source => source.stopped || source.disconnected));
  assert.equal(playback.audio, audio);
  assert.equal(audio.duration, 3600);
  console.log('PASS: 60-minute timeline, 4→8→20s progressive start, bounded buffers, starvation recovery, cached/uncached seek, stale cancellation');
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
}
