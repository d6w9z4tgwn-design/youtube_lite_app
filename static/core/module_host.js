'use strict';
import { SeekGuard } from '/core/seek_guard.js';
import abRepeat from '/core/player_ab-loop.js';
import boost from '/core/player_audio-boost.js';
import queue from '/core/player_playback-queue.js';

export class AudioEngine {
  constructor(audio) {
    this.audio = audio;
    this.context = null;
    this.source = null;
    this.effects = new Map();
    this.taps = new Set();
    this.worklets = new Map();
  }

  ensure() {
    if (this.context) return this.context;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('このブラウザはWeb Audio APIに対応していません。');
    this.context = new AudioContextClass();
    this.source = this.context.createMediaElementSource(this.audio);
    this.output = this.context.createGain();
    this.output.connect(this.context.destination);
    this._rebuild();
    return this.context;
  }

  async resume() {
    if (!this.context) return;
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setSeekMuted(muted) {
    // Native pause/mute is sufficient without effects. Do not introduce a new
    // MediaElementSource halfway through playback just to perform a seek.
    if (!this.context || !this.output) return;
    try {
      const context = this.context;
      // Disconnect the hardware output too: gain automation alone depends on
      // the audio render clock advancing, which may stall during a Safari seek.
      if (muted && !this.seekDisconnected) {
        this.output.disconnect(context.destination);
        this.seekDisconnected = true;
      } else if (!muted && this.seekDisconnected) {
        this.output.connect(context.destination);
        this.seekDisconnected = false;
      }
      this.output.gain.cancelScheduledValues(context.currentTime);
      this.output.gain.setValueAtTime(muted ? 0 : 1, context.currentTime);
      if (!this.audio.paused) this.resume().catch(() => {});
    } catch {
      // Native audio fallback when Web Audio is unavailable.
      if (muted && this.savedSeekMute === undefined) this.savedSeekMute = this.audio.muted;
      if (muted) this.audio.muted = true;
      else if (this.savedSeekMute !== undefined) {
        this.audio.muted = this.savedSeekMute;
        this.savedSeekMute = undefined;
      }
    }
  }

  loadWorklet(url) {
    const context = this.ensure();
    if (!context.audioWorklet) return Promise.reject(new Error('このブラウザはAudioWorkletに対応していません。'));
    if (!this.worklets.has(url)) {
      this.worklets.set(url, context.audioWorklet.addModule(url).catch((error) => {
        this.worklets.delete(url);
        throw error;
      }));
    }
    return this.worklets.get(url);
  }

  tap(node, position = 'output') {
    this.ensure();
    const tap = { node, position };
    this.taps.add(tap);
    (position === 'input' ? this.source : this.output).connect(node);
    return () => {
      this.taps.delete(tap);
      try { (position === 'input' ? this.source : this.output).disconnect(node); } catch {}
    };
  }

  registerEffect(id, inputNode, order = 100, outputNode = inputNode) {
    this.ensure();
    if (!id || !inputNode || !outputNode) throw new Error('エフェクトIDとAudioNodeが必要です。');
    if (this.effects.has(id)) throw new Error(`エフェクトIDが重複しています: ${id}`);
    this.effects.set(id, { inputNode, outputNode, order });
    this._rebuild();
    return () => {
      const effect = this.effects.get(id);
      if (!effect) return;
      try { effect.outputNode.disconnect(); } catch {}
      this.effects.delete(id);
      this._rebuild();
    };
  }

  _rebuild() {
    if (!this.context || !this.source) return;
    const chain = [...this.effects.values()].sort((a, b) => a.order - b.order);
    try { this.source.disconnect(); } catch {}
    for (const effect of chain) {
      try { effect.outputNode.disconnect(); } catch {}
    }
    let cursor = this.source;
    for (const effect of chain) {
      cursor.connect(effect.inputNode);
      cursor = effect.outputNode;
    }
    cursor.connect(this.output);
    for (const tap of this.taps) {
      if (tap.position === 'input') this.source.connect(tap.node);
    }
    if (!this.audio.paused) this.resume().catch(() => {});
  }
}

export class ModuleHost {
  constructor({ audio, rack, standardRack, dialogList, notify, getCurrentVideo, playVideo, getRelatedVideos }) {
    this.audio = audio;
    this.rack = rack;
    this.standardRack = standardRack || rack;
    this.standardCleanups = null;
    this.dialogList = dialogList;
    this.notify = notify;
    this.getCurrentVideo = getCurrentVideo;
    this.playVideo = playVideo;
    this.getRelatedVideos = getRelatedVideos || (async () => []);
    this.baseRate = audio.playbackRate;
    this.rateFactors = new Map();
    this.tempoProcessor = null;
    this.controls = new Map();
    this.queueHandler = null;
    this.lastVideoId = undefined;
    this.events = new EventTarget();
    this.audioEngine = new AudioEngine(audio);
    this.seekGuard = new SeekGuard(audio, muted => this.audioEngine.setSeekMuted(muted), {
      reloadBeforeSeek: () => Boolean(this.audioEngine.context)
        && /AppleWebKit/.test(navigator.userAgent)
        && !/(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)
        && audio.src.includes('format=m4a-safe'),
    });
    this.discovered = [];
    this.instances = new Map();
    this.storagePrefix = 'clipnest.module.';

    audio.addEventListener('play', () => {
      this.audioEngine.resume().catch(() => {});
      this.events.dispatchEvent(new CustomEvent('player:play'));
    });
    audio.addEventListener('pause', () => this.events.dispatchEvent(new CustomEvent('player:pause')));
    audio.addEventListener('timeupdate', () => this.events.dispatchEvent(new CustomEvent('player:timeupdate', {
      detail: { currentTime: audio.currentTime, duration: audio.duration },
    })));
    audio.addEventListener('loadedmetadata', () => this.events.dispatchEvent(new CustomEvent('player:loadedmetadata', {
      detail: { currentTime: audio.currentTime, duration: audio.duration },
    })));
    audio.addEventListener('ratechange', () => this.events.dispatchEvent(new CustomEvent('player:ratechange', {
      detail: { playbackRate: audio.playbackRate },
    })));
    audio.addEventListener('volumechange', () => this.events.dispatchEvent(new CustomEvent('player:volumechange', {
      detail: { volume: audio.volume, muted: audio.muted },
    })));
    audio.addEventListener('ended', () => this.events.dispatchEvent(new CustomEvent('player:ended')));
  }

  async discover() {
    const response = await fetch('/api/modules');
    if (!response.ok) throw new Error(`モジュール一覧を取得できませんでした: HTTP ${response.status}`);
    const data = await response.json();
    this.discovered = Array.isArray(data.items) ? data.items : [];
    return this.discovered;
  }

  isEnabled(id, defaultValue = true) {
    const raw = localStorage.getItem(`${this.storagePrefix}${id}.enabled`);
    if (raw === null) return defaultValue;
    return raw === 'true';
  }

  setEnabledPreference(id, enabled) {
    localStorage.setItem(`${this.storagePrefix}${id}.enabled`, enabled ? 'true' : 'false');
  }

  moduleStorage(id) {
    const prefix = `${this.storagePrefix}${id}.setting.`;
    return {
      get(key, fallback = null) {
        const raw = localStorage.getItem(prefix + key);
        if (raw === null) return fallback;
        try { return JSON.parse(raw); } catch { return raw; }
      },
      set(key, value) {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      },
      remove(key) {
        localStorage.removeItem(prefix + key);
      },
    };
  }

  createControlGroup(moduleId, title) {
    const group = document.createElement('div');
    group.className = 'module-control-group';
    group.dataset.moduleId = moduleId;
    if (title) {
      const label = document.createElement('span');
      label.className = 'module-control-title';
      label.textContent = title;
      group.append(label);
    }
    this.rack.append(group);
    return group;
  }

  setBaseRate(rate) {
    this.baseRate = Math.max(0.5, Math.min(3, Number(rate) || 1));
    this.applyRate();
  }

  applyRate() {
    let rate = this.baseRate;
    for (const factor of this.rateFactors.values()) rate *= factor;
    const next = Math.max(0.5, Math.min(4, rate));
    this.tempoProcessor?.update(next);
    this.audio.preservesPitch = !this.tempoProcessor;
    this.audio.playbackRate = next;
    this.events.dispatchEvent(new CustomEvent('player:baserate', { detail: { rate: this.baseRate } }));
  }

  async enqueue(video) {
    this.queueHandler?.(video);
  }

  async playList(videos) {
    if (!this.playListHandler) throw new Error('キューを準備中です。');
    return this.playListHandler(videos);
  }

  contextFor(module) {
    const cleanups = [];
    const context = {
      audio: this.audio,
      audioEngine: this.audioEngine,
      events: this.events,
      storage: this.moduleStorage(module.id),
      getCurrentVideo: this.getCurrentVideo,
      notify: this.notify,
      player: {
        play: (video) => this.playVideo(video),
        getRelatedVideos: (videoId) => this.getRelatedVideos(videoId),
        seek: (time) => {
          this.seekGuard.seek(Number(time));
        },
        getRate: () => this.baseRate,
        setRate: (rate) => this.setBaseRate(rate),
        setTempoProcessor: (update) => {
          if (update && this.tempoProcessor && this.tempoProcessor.owner !== module.id) throw new Error('別の速度補正が有効です。');
          if (update) this.tempoProcessor = { owner: module.id, update };
          else if (this.tempoProcessor?.owner === module.id) this.tempoProcessor = null;
          this.applyRate();
        },
        setRateFactor: (factor) => {
          this.rateFactors.set(module.id, Math.max(1, Math.min(4, Number(factor) || 1)));
          this.applyRate();
        },
        onEnqueue: (handler) => {
          this.queueHandler = handler;
          cleanups.push(() => { if (this.queueHandler === handler) this.queueHandler = null; });
        },
        onPlayList: (handler) => {
          this.playListHandler = handler;
          cleanups.push(() => { if (this.playListHandler === handler) this.playListHandler = null; });
        },
      },
      modules: {
        enable: (id) => this.enable(id),
        set: (id, key, value) => this.controls.get(`${id}.${key}`)?.(value),
      },
      registerControl: (key, setter) => {
        const id = `${module.id}.${key}`;
        this.controls.set(id, setter);
        cleanups.push(() => this.controls.delete(id));
      },
      ui: {
        createControlGroup: (title = module.name) => {
          const group = this.createControlGroup(module.id, title);
          if (module.builtIn) this.standardRack.append(group);
          cleanups.push(() => group.remove());
          return group;
        },
      },
      onCleanup(callback) {
        if (typeof callback === 'function') cleanups.push(callback);
      },
    };
    cleanups.push(() => {
      const ownedTempo = this.tempoProcessor?.owner === module.id;
      if (ownedTempo) this.tempoProcessor = null;
      const ownedFactor = this.rateFactors.delete(module.id);
      if (ownedTempo || ownedFactor) this.applyRate();
    });
    return { context, cleanups };
  }

  async loadAll() {
    if (!this.standardCleanups) {
      this.standardCleanups = [];
      for (const feature of [abRepeat, boost, queue]) {
        const { context, cleanups } = this.contextFor(feature);
        try { await feature.activate(context); this.standardCleanups.push(...cleanups); }
        catch (error) { for (const cleanup of cleanups.reverse()) cleanup(); this.notify(error.message, 'error'); }
      }
    }
    if (!this.discovered.length) await this.discover();
    for (const entry of this.discovered) {
      try {
        const imported = await import(entry.url);
        const module = imported.default;
        if (!module || typeof module.activate !== 'function' || !module.id) {
          throw new Error('default exportに id と activate() が必要です。');
        }
        const enabledByDefault = module.enabledByDefault !== false;
        const enabled = this.isEnabled(module.id, enabledByDefault);
        this.instances.set(module.id, {
          entry,
          module,
          enabled: false,
          cleanups: [],
        });
        if (enabled) await this.enable(module.id);
      } catch (error) {
        console.error(`モジュール読み込み失敗: ${entry.file}`, error);
        this.notify(`モジュール「${entry.file}」を読み込めませんでした。`, 'error');
      }
    }
    this.renderManager();
  }

  async enable(id) {
    const instance = this.instances.get(id);
    if (!instance || instance.enabled) return;
    if (instance.enabling) return instance.enabling;
    instance.enabling = this.activateInstance(instance);
    try { await instance.enabling; } finally { instance.enabling = null; }
  }

  async activateInstance(instance) {
    const id = instance.module.id;
    const { context, cleanups } = this.contextFor(instance.module);
    try {
      const result = await instance.module.activate(context);
      if (typeof result === 'function') cleanups.push(result);
      instance.cleanups = cleanups;
      instance.enabled = true;
      this.setEnabledPreference(id, true);
      this.events.dispatchEvent(new CustomEvent('module:statechange', {
        detail: { id, enabled: true },
      }));
      if (!this.audio.paused) await this.audioEngine.resume().catch(() => {});
      this.renderManager();
    } catch (error) {
      for (const cleanup of [...cleanups].reverse()) {
        try { await cleanup(); } catch {}
      }
      throw error;
    }
  }

  async disable(id) {
    const instance = this.instances.get(id);
    if (!instance || !instance.enabled) return;
    for (const cleanup of [...instance.cleanups].reverse()) {
      try { await cleanup(); } catch (error) { console.warn(`モジュール終了処理失敗: ${id}`, error); }
    }
    instance.cleanups = [];
    instance.enabled = false;
    this.setEnabledPreference(id, false);
    this.events.dispatchEvent(new CustomEvent('module:statechange', {
      detail: { id, enabled: false },
    }));
    if (!this.audio.paused) await this.audioEngine.resume().catch(() => {});
    this.renderManager();
  }

  async toggle(id, enabled) {
    if (enabled) await this.enable(id);
    else await this.disable(id);
  }

  videoChanged(video) {
    if (this.lastVideoId === (video?.id ?? null)) return;
    this.lastVideoId = video?.id ?? null;
    this.events.dispatchEvent(new CustomEvent('player:videochange', { detail: { video } }));
  }

  renderManager() {
    if (!this.dialogList) return;
    this.dialogList.replaceChildren();
    const instances = [...this.instances.values()].sort((a, b) =>
      String(a.module.name || a.module.id).localeCompare(String(b.module.name || b.module.id), 'ja')
    );
    if (!instances.length) {
      const empty = document.createElement('p');
      empty.className = 'module-empty';
      empty.textContent = '追加モジュールはありません。';
      this.dialogList.append(empty);
      return;
    }
    for (const instance of instances) {
      const row = document.createElement('div');
      row.className = 'module-manager-row';
      const label = document.createElement('label');
      label.className = 'module-manager-toggle';

      const copy = document.createElement('span');
      copy.className = 'module-manager-copy';
      const name = document.createElement('strong');
      name.textContent = instance.module.name || instance.module.id;
      const description = document.createElement('small');
      description.textContent = instance.module.description || instance.entry.file;
      copy.append(name, description);

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = instance.enabled;
      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        try {
          await this.toggle(instance.module.id, toggle.checked);
        } catch (error) {
          toggle.checked = !toggle.checked;
          this.notify(`${instance.module.name || instance.module.id}: ${error.message}`, 'error');
        } finally {
          toggle.disabled = false;
        }
      });

      label.append(copy, toggle);
      row.append(label);
      if (instance.enabled && this.controls.has(`${instance.module.id}.openPanel`)) {
        const settings = document.createElement('button');
        settings.type = 'button'; settings.className = 'ghost module-settings-button';
        settings.textContent = '設定を開く';
        settings.setAttribute('aria-label', `${instance.module.name || instance.module.id}の設定を開く`);
        settings.addEventListener('click', () => {
          this.dialogList.closest('dialog')?.close();
          this.controls.get(`${instance.module.id}.openPanel`)?.();
        });
        row.append(settings);
      }
      this.dialogList.append(row);
    }
  }
}
