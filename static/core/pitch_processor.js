import { SoundTouchProcessor } from './soundtouch_processor.js';

// WSOLA waveform alignment with Lanczos interpolation; retain the app contract.
class ClipNestPitch extends SoundTouchProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' },
      { name: 'sourceRate', defaultValue: 1, minValue: 0.5, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    // FIFO avoids the circular adapter retaining copied pre-seek stretch samples.
    super({ processorOptions: { sampleBufferType: 'fifo', interpolationStrategy: 'lanczos' } });
    this.running = true;
    this.holding = false;
    this.primeBlocks = 2;
    this.bypassed = false;
    this.parametersBridge = {
      pitch: new Float32Array([1]),
      pitchSemitones: new Float32Array(1),
      playbackRate: new Float32Array([1]),
    };

    // Keep the legacy profile for pitch-only processing so this revision changes
    // tempo processing only. Tempo changes switch to the quality-first profile
    // dynamically in updateTempoStretchQuality().
    this._tempoStretchProfile = '';
    this._applyStretchProfile('pitch-only');

    const receive = this.port.onmessage;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.running = false;
        this._pipe.clear();
      } else if (event.data === 'reset' || event.data === 'hold' || event.data === 'resume') {
        if (event.data === 'resume' && !this.holding) return;
        if (event.data === 'hold') this.holding = true;
        if (event.data === 'resume') this.holding = false;
        this._pipe.clear();
        this._samples.fill(0);
        this._outputSamples.fill(0);
        this.primeBlocks = 2;
      } else {
        receive?.(event);
      }
    };
  }

  /**
   * Switch WSOLA parameters only when the active use-case changes.
   *
   * pitch-only:
   *   Preserve the original 40/15/8 ms + quick seek behaviour.
   *
   * tempo-hq:
   *   sequenceMs/seekWindowMs = 0 enables SoundTouch's built-in tempo-adaptive
   *   window sizing. quickSeek=false evaluates the entire seek window instead
   *   of the coarse multi-pass approximation, prioritising waveform continuity.
   */
  _applyStretchProfile(profile) {
    if (profile === this._tempoStretchProfile) return;

    if (profile === 'tempo-hq') {
      this._pipe.setStretchParameters({
        sequenceMs: 0,
        seekWindowMs: 0,
        overlapMs: 8,
        quickSeek: false,
      });
    } else {
      this._pipe.setStretchParameters({
        sequenceMs: 40,
        seekWindowMs: 15,
        overlapMs: 8,
        quickSeek: true,
      });
    }

    this._tempoStretchProfile = profile;
  }

  /**
   * Apply high-quality WSOLA only while tempo is actually being changed.
   * This deliberately leaves pitch-only processing behaviour unchanged.
   */
  _updateTempoStretchQuality(sourceRate) {
    const tempoChanged = Math.abs(sourceRate - 1) >= 0.00001;
    this._applyStretchProfile(tempoChanged ? 'tempo-hq' : 'pitch-only');
  }

  extractSamples(left, right, frames, available, parameters) {
    // WSOLA emits chunks, not one render quantum at a time. Starting extraction
    // on the first available sample occasionally underruns at chunk boundaries.
    // Leave two render quanta (~5–6ms) of headroom; reset it on a decoder flush.
    if (this.primeBlocks > 0) {
      if (available > 0) this.primeBlocks--;
      left.fill(0);
      right.fill(0);
      return { outputRms: 0, outputPeak: 0 };
    }
    return super.extractSamples(left, right, frames, available, parameters);
  }

  process(inputs, outputs, parameters) {
    if (!this.running) return false;
    if (this.holding) {
      for (const output of outputs[0]) output.fill(0);
      return true;
    }

    const semitones = parameters.semitones[0];
    const sourceRate = parameters.sourceRate?.[0] || 1;

    // Tempo-only quality enhancement: do not alter the pitch-only DSP profile.
    this._updateTempoStretchQuality(sourceRate);

    const effectivePitch = Math.pow(2, semitones / 12) / sourceRate;

    if (Math.abs(effectivePitch - 1) < 0.00001) {
      if (!this.bypassed) {
        this._pipe.clear();
        this.primeBlocks = 2;
        this.bypassed = true;
      }
      for (let channel = 0; channel < outputs[0].length; channel++) {
        const source = inputs[0]?.[channel] || inputs[0]?.[0];
        if (source) outputs[0][channel].set(source);
        else outputs[0][channel].fill(0);
      }
      return true;
    }

    this.bypassed = false;
    this.parametersBridge.pitchSemitones[0] = semitones;
    this.parametersBridge.playbackRate[0] = sourceRate;
    super.process(inputs, outputs, this.parametersBridge);
    return true;
  }
}

registerProcessor('clipnest-pitch', ClipNestPitch);
