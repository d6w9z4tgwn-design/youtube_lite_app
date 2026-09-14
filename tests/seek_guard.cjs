const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../static/core/seek_guard.js'), 'utf8');
  const { SeekGuard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  class Media extends EventTarget {
    constructor() { super(); this.currentTime = 10; this.duration = 120; this.readyState = 4; this.seeking = false; this.paused = false; this.volume = 0.7; this.muted = false; }
    pause() { this.paused = true; }
    async play() { this.paused = false; }
  }
  const audio = new Media();
  const gates = [];
  const guard = new SeekGuard(audio, muted => gates.push({ muted, time: audio.currentTime }));
  guard.seek(90);
  assert.deepEqual(gates[0], { muted: true, time: 10 }); // Before native seek.
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, true);
  audio.dispatchEvent(new Event('canplay')); // An old-source ready event is insufficient.
  audio.dispatchEvent(new Event('playing'));
  assert.equal(guard.active, true);
  audio.seeking = true;
  audio.readyState = 2;
  audio.dispatchEvent(new Event('seeking'));
  audio.dispatchEvent(new Event('canplay'));
  assert.equal(guard.active, true);
  guard.seek(30); // Rapid backward seek must replace the retry target.
  assert.equal(guard.target, 30);
  audio.seeking = false;
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(guard.active, true); // Metadata alone is not enough.
  audio.readyState = 3;
  audio.dispatchEvent(new Event('canplay'));
  assert.equal(guard.active, false);
  assert.equal(gates.at(-1).muted, false);
  assert.equal(audio.paused, false);
  assert.equal(audio.volume, 0.7);
  assert.equal(audio.muted, false);
  guard.beginScrub();
  audio.dispatchEvent(new Event('canplay'));
  assert.equal(audio.paused, true);
  guard.endScrub(66.528);
  audio.currentTime = 66.726; // Actual stale event from the user's Safari trace.
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(guard.active, true);
  assert.equal(audio.paused, true);
  audio.currentTime = 66.528;
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(guard.active, false);
  assert.equal(audio.paused, false);
  audio.paused = true;
  guard.seek(45);
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(audio.paused, true);
  audio.paused = false;
  guard.seek(70);
  guard.togglePlayback(); // A user pause while loading cancels automatic resume.
  audio.dispatchEvent(new Event('seeked'));
  assert.equal(audio.paused, true);
  guard.seek(100);
  audio.dispatchEvent(new Event('error'));
  assert.equal(guard.active, true);
  audio.dispatchEvent(new Event('emptied'));
  assert.equal(guard.active, false);
  Object.defineProperty(audio, 'currentTime', { get: () => 0, set: () => { throw new Error('not seekable'); } });
  assert.throws(() => guard.seek(10));
  assert.equal(guard.active, false);
  console.log('Seek gate ordering, delayed readiness, rapid seeks, pause, source reset and errors: PASS');
  const reloadAudio = new Media();
  reloadAudio.src = '/api/media/abcdefghijk?format=m4a-safe';
  reloadAudio.playbackRate = 1.5;
  let reloads = 0;
  reloadAudio.load = () => {
    reloads++;
    reloadAudio.currentTime = 0;
    reloadAudio.readyState = 0;
    reloadAudio.dispatchEvent(new Event('emptied'));
  };
  const reloader = new SeekGuard(reloadAudio, () => {}, { reloadBeforeSeek: () => true });
  reloader.seek(80);
  assert.equal(reloader.active, true);
  assert.equal(reloader.reloadPending, true);
  assert.equal(reloadAudio.defaultPlaybackRate, 1.5);
  reloader.seek(35);
  assert.equal(reloads, 1);
  reloadAudio.readyState = 1;
  reloadAudio.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(reloadAudio.currentTime, 35);
  assert.equal(reloadAudio.paused, true);
  reloadAudio.readyState = 4;
  reloadAudio.dispatchEvent(new Event('canplay'));
  assert.equal(reloadAudio.paused, false);
  reloader.seek(50);
  reloadAudio.src = '/api/media/lmnopqrstuv?format=m4a-safe';
  reloadAudio.dispatchEvent(new Event('emptied'));
  assert.equal(reloader.reloadPending, false);
  assert.equal(reloadAudio.muted, false);
  console.log('Decoder reload, coalesced target, preserved speed and source change: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
