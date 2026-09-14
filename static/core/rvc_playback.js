// The original media element owns time/seek/queue. Only its PCM is replaced.
export class RVCPlayback {
  constructor(ctx, correction, getChunk, status, onState = () => {}) {
    this.ctx = ctx; this.audio = ctx.audio; this.ac = ctx.audioEngine.ensure();
    this.correction = correction; this.getChunk = getChunk; this.status = status;
    this.onState = onState; this.lastState = ''; this.held = false;
    this.active = false; this.epoch = 0; this.cache = new Map(); this.pending = new Map();
    this.prefetched = new Set(); this.scheduled = new Map(); this.waiting = null;
    this.input = this.ac.createGain(); this.output = this.ac.createGain();
    this.voiceGain = this.ac.createGain(); this.backgroundGain = this.ac.createGain();
    this.wet = this.ac.createGain(); this.wet.gain.value = 0;
    this.input.connect(this.output);
    this.voiceGain.connect(correction); this.backgroundGain.connect(correction);
    correction.output.connect(this.wet); this.wet.connect(this.output);
    this.unregister = ctx.audioEngine.registerEffect('module.rvc', this.input, 25, this.output);
    const listen = (target, event, callback) => {
      target.addEventListener(event, callback);
      ctx.onCleanup(() => target.removeEventListener(event, callback));
    };
    for (const event of ['pause', 'waiting', 'ended']) listen(this.audio, event, () => this.clearSound());
    for (const event of ['seekflush', 'seeking', 'emptied']) listen(this.audio, event, () => this.invalidate());
    for (const event of ['playing', 'timeupdate', 'seeked']) listen(this.audio, event, () => this.tick());
    listen(this.audio, 'ratechange', () => { this.clearSound(); this.tick(); });
    listen(ctx.events, 'player:baserate', () => { this.clearSound(); this.tick(); });
    listen(this.audio, 'volumechange', () => { this.volume(); if (this.audio.muted) this.clearSound(); });
    listen(ctx.events, 'player:videochange', () => this.stop('動画が変わりました。「声を変えて再生」で新しい動画を準備できます。'));
    listen(ctx.events, 'player:voice-replacement', event => {
      if (event.detail?.owner !== 'rvc') this.stop('別の声変換・吹替を開始したためRVCを停止しました。');
    });
    this.timer = setInterval(() => this.tick(), 80);
    ctx.onCleanup(() => this.destroy());
  }

  clearSound() {
    this.wet.gain.value = 0;
    for (const entry of this.scheduled.values()) for (const node of entry.nodes) {
      try { node.stop(); } catch {}
      node.disconnect();
    }
    if (this.scheduled.size) this.ctx.events.dispatchEvent(new CustomEvent('player:replacementhold'));
    this.scheduled.clear();
    if (!this.held) this.correction.port.postMessage('hold');
    this.held = true; this.notify();
  }

  notify() {
    const state = `${this.active}:${!!this.waiting}:${this.audio.paused}`;
    if (state !== this.lastState) { this.lastState = state; this.onState(); }
  }

  invalidate() {
    this.epoch++; this.waiting = null;
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear(); this.prefetched.clear(); this.clearSound();
  }

  stop(message = 'RVCを停止しました。再生ボタンで原音を再生できます。') {
    const wasActive = this.active;
    this.active = false; this.invalidate(); this.cache.clear(); this.input.gain.value = 1;
    if (wasActive) this.audio.pause();
    this.status(message);
  }

  async start() {
    this.stop('現在位置の人声とBGMを準備しています…');
    if (!this.ctx.getCurrentVideo()) throw new Error('先に動画を選んでください。');
    this.ctx.events.dispatchEvent(new CustomEvent('player:voice-replacement', { detail: { owner: 'rvc' } }));
    this.audio.pause(); this.audio.dispatchEvent(new Event('seekflush'));
    this.active = true; this.input.gain.value = 0;
    await this.waitForChunk(this.bootstrap(this.audio.currentTime));
  }

  at(position, collection = this.cache) {
    for (const entry of collection.values()) {
      const item = entry.window || entry;
      if (position >= item.start && position < item.start + (item.duration ?? item.seconds)) return item;
    }
    return null;
  }

  window(start, seconds, nextSeconds = 20) {
    const duration = this.ctx.getCurrentVideo()?.duration;
    return { start, seconds: Math.max(0.2, Math.min(seconds, duration > start ? duration - start : seconds)), nextSeconds };
  }

  bootstrap(position) {
    // An uncached seek starts at the target, not the beginning of a 20-second block.
    // Discard the old plan so overlapping ranges cannot replace one another midway.
    this.invalidate(); this.cache.clear();
    return this.window(Math.floor(position * 1000) / 1000, 4, 8);
  }

  ensure(window) {
    const { start, seconds, nextSeconds } = window;
    if (this.cache.has(start)) return Promise.resolve(this.cache.get(start));
    if (this.pending.has(start)) return this.pending.get(start).promise;
    const controller = new AbortController(), epoch = this.epoch;
    const promise = this.getChunk(start, controller.signal, seconds).then(chunk => {
      if (!this.active || epoch !== this.epoch || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!(chunk.duration > 0) || Math.abs(chunk.voice.duration - chunk.duration) > 0.03 || Math.abs(chunk.background.duration - chunk.duration) > 0.03) {
        throw new Error('変換音声の長さが一致しません。');
      }
      if (chunk.duration < seconds - 0.5 || chunk.duration > seconds + 0.03) throw new Error('変換音声の区間が一致しません。原音の読み込みを確認して再試行してください。');
      this.cache.set(start, { ...chunk, start, nextSeconds });
      const current = this.at(this.audio.currentTime)?.start;
      for (const key of this.cache.keys()) {
        if (this.cache.size <= 4) break;
        if (key !== current && key !== start && !this.scheduled.has(key)) this.cache.delete(key);
      }
      return this.cache.get(start);
    }).finally(() => { if (this.pending.get(start)?.controller === controller) this.pending.delete(start); });
    this.pending.set(start, { controller, promise, window });
    return promise;
  }

  async waitForChunk(window) {
    const { start } = window;
    if (!this.active || this.waiting?.start === start) return;
    this.clearSound(); this.audio.pause();
    const marker = { start, epoch: this.epoch }; this.waiting = marker;
    this.status('人声を分離して変換しています。準備ができると再生します。「中止して原音を再生」でいつでも戻せます。');
    try {
      await this.ensure(window);
      if (!this.active || this.waiting !== marker || marker.epoch !== this.epoch) return;
      this.waiting = null;
      await this.ctx.audioEngine.resume();
      this.status('RVC ON：変換した声＋分離したBGM。次の区間を先読みします。');
      try { await this.audio.play(); }
      catch { this.status('変換の準備ができました。プレイヤーの再生ボタンを押してください。'); }
    } catch (error) {
      if (this.active && marker.epoch === this.epoch && error.name !== 'AbortError') this.stop(error.message);
    }
  }

  volume() {
    this.wet.gain.value = this.active && !this.audio.muted && !this.audio.paused && this.scheduled.size ? this.audio.volume : 0;
  }

  schedule(chunk, when, offset = 0) {
    const nodes = [];
    for (const [buffer, target] of [[chunk.voice, this.voiceGain], [chunk.background, this.backgroundGain]]) {
      const node = this.ac.createBufferSource(); node.buffer = buffer;
      node.playbackRate.value = this.audio.playbackRate;
      node.connect(target); node.start(when, offset, chunk.duration - offset); nodes.push(node);
    }
    this.scheduled.set(chunk.start, { nodes, time: when, mediaTime: chunk.start + offset, rate: this.audio.playbackRate });
  }

  tick() {
    this.notify();
    if (!this.active) return;
    if (this.audio.paused || this.audio.seeking || this.audio.muted || this.audio.readyState < 3) { this.clearSound(); return; }
    const position = this.audio.currentTime;
    if (this.audio.ended || position >= (this.ctx.getCurrentVideo()?.duration || Infinity)) { this.clearSound(); return; }
    const chunk = this.at(position);
    if (!chunk) { void this.waitForChunk(this.at(position, this.pending) || this.bootstrap(position)); return; }
    const start = chunk.start;
    const sourceRate = this.audio.preservesPitch === false ? 1 : this.audio.playbackRate;
    // Switching the main pitch module's mode may not emit a native ratechange.
    if (sourceRate !== this.sourceRate) { this.clearSound(); this.sourceRate = sourceRate; }
    let current = this.scheduled.get(start);
    if (current && (Math.abs(current.mediaTime + (this.ac.currentTime - current.time) * current.rate - position) > 0.12
        || current.rate !== this.audio.playbackRate)) { this.clearSound(); current = null; }
    if (!current) {
      this.clearSound();
      // AudioBufferSource changes pitch with speed. Compensate here only if the main pitch module does not.
      this.correction.parameters.get('sourceRate').setValueAtTime(sourceRate, this.ac.currentTime);
      this.correction.port.postMessage('resume');
      this.held = false;
      this.ctx.events.dispatchEvent(new CustomEvent('player:replacementresume'));
      this.schedule(chunk, this.ac.currentTime, Math.max(0, position - start));
      current = this.scheduled.get(start);
    }
    for (const [key, entry] of this.scheduled) if (key < start) {
      for (const node of entry.nodes) node.disconnect();
      this.scheduled.delete(key);
    }
    this.volume();
    const next = start + chunk.duration;
    if (next >= (this.ctx.getCurrentVideo()?.duration || Infinity) - 0.01) return;
    if (!this.prefetched.has(next)) {
      this.prefetched.add(next);
      this.ensure(this.window(next, chunk.nextSeconds)).catch(error => {
        if (this.active && error.name !== 'AbortError') this.status('次の区間は再生位置が到達した時に再試行します。');
      });
    }
    if (this.cache.has(next) && !this.scheduled.has(next)) {
      this.schedule(this.cache.get(next), current.time + (next - current.mediaTime) / current.rate);
    }
  }

  destroy() {
    this.stop(); clearInterval(this.timer); this.unregister();
    this.correction.port.postMessage('stop'); this.correction.port.close();
    this.correction.disconnect(); this.correction.output.disconnect();
    for (const node of [this.input, this.output, this.voiceGain, this.backgroundGain, this.wet]) node.disconnect();
  }
}
