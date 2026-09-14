// Stop the decoder and both output paths until the latest seek completes.
export class SeekGuard {
  constructor(audio, gate, { reloadBeforeSeek = () => false } = {}) {
    this.audio = audio;
    this.gate = gate;
    this.reloadBeforeSeek = reloadBeforeSeek;
    this.reloadPending = false;
    this.reloadSource = null;
    this.target = null;
    this.active = false;
    this.resumeAfterSeek = false;
    this.completed = false;
    this.scrubbing = false;
    this.completionTimer = null;
    this.trace = [];
    for (const name of ['seeking', 'seeked', 'waiting', 'canplay', 'play', 'playing', 'pause', 'emptied', 'error']) {
      audio.addEventListener(name, () => this.record(name));
    }
    audio.addEventListener('seeking', () => {
      if (!this.active) { this.target = audio.currentTime; this.block(); }
    });
    audio.addEventListener('seeked', () => {
      this.verifyCompletion(performance.now() + 1000);
    });
    audio.addEventListener('canplay', () => this.finish());
    audio.addEventListener('play', () => {
      if (this.active) { this.resumeAfterSeek = true; audio.pause(); }
    });
    // Old-source events must not leave the next source permanently silent.
    audio.addEventListener('emptied', () => {
      if (!this.reloadPending || audio.src !== this.reloadSource) this.reset();
    });
    audio.addEventListener('loadedmetadata', () => {
      if (!this.reloadPending) return;
      this.reloadPending = false;
      if (audio.src !== this.reloadSource) { this.reset(); return; }
      this.record('decoder-reloaded');
      try {
        audio.currentTime = this.target;
        if (!audio.seeking && audio.currentTime === this.target) {
          this.completed = true;
          this.finish();
        }
      }
      catch (error) { this.reset(); throw error; }
    });
    audio.addEventListener('ended', () => this.reset());
    audio.addEventListener('error', () => { if (this.active) this.gate(true); });
  }
  block() {
    if (!this.active) {
      this.resumeAfterSeek = !this.audio.paused;
      this.savedMuted = this.audio.muted;
    }
    this.active = true;
    this.audio.muted = true;
    this.gate(true);
    this.audio.pause();
    this.record('blocked');
  }
  verifyCompletion(deadline) {
    clearTimeout(this.completionTimer);
    if (!this.active || this.reloadPending || this.target === null) return;
    if (!this.audio.seeking && Math.abs(this.audio.currentTime - this.target) < 0.05) {
      this.completed = true;
      this.finish();
    } else if (performance.now() < deadline) {
      this.completionTimer = setTimeout(() => this.verifyCompletion(deadline), 16);
    }
  }
  beginScrub() {
    this.scrubbing = true;
    this.block();
  }
  endScrub(time) {
    this.scrubbing = false;
    if (!this.audio.seeking && time === this.audio.currentTime) {
      this.completed = true;
      this.finish();
    } else this.seek(time);
  }
  record(event) {
    this.trace.push({ event, at: Math.round(performance.now()), time: this.audio.currentTime,
      target: this.target, paused: this.audio.paused, muted: this.audio.muted,
      seeking: this.audio.seeking, ready: this.audio.readyState, active: this.active, reloadPending: this.reloadPending });
    if (this.trace.length > 32) this.trace.shift();
  }
  togglePlayback() {
    if (!this.active) return false;
    this.resumeAfterSeek = !this.resumeAfterSeek;
    return true;
  }
  finish() {
    if (!this.active || this.reloadPending || this.scrubbing || !this.completed || this.audio.seeking || this.audio.readyState < 3) return;
    const resume = this.resumeAfterSeek;
    this.record('resume-ready');
    this.reset();
    if (resume) this.audio.play().catch(() => {});
  }
  reset() {
    clearTimeout(this.completionTimer);
    this.scrubbing = false;
    this.reloadPending = false;
    this.reloadSource = null;
    this.target = null;
    if (this.active) { this.gate(false); this.audio.muted = this.savedMuted; }
    this.active = false;
    this.completed = false;
    this.resumeAfterSeek = false;
  }
  seek(time) {
    if (!Number.isFinite(time)) return;
    const target = Math.max(0, Number.isFinite(this.audio.duration) ? Math.min(time, this.audio.duration) : time);
    if (this.active && target === this.target) return;
    if (!this.active && target === this.audio.currentTime) return;
    this.target = target;
    clearTimeout(this.completionTimer);
    this.record('seek-request');
    this.completed = false;
    this.block();
    try {
      // Safari can retain pre-seek samples in MediaElementAudioSourceNode even
      // after seeked. Reset its decoder before applying the new timestamp.
      if (this.reloadPending) return; // Keep only the latest target while loading.
      if (this.reloadBeforeSeek()) {
        this.reloadPending = true;
        this.reloadSource = this.audio.src;
        this.audio.defaultPlaybackRate = this.audio.playbackRate;
        this.audio.load();
        this.audio.dispatchEvent(new Event('seekflush'));
        this.record('decoder-reload');
      } else this.audio.currentTime = target;
    }
    catch (error) { this.reset(); throw error; }
  }
}
