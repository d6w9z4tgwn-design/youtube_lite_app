import SignalsmithStretch from './signalsmith_stretch.js';

// Keep the media element as the playback clock. It supplies rate-resampled PCM;
// one (and only one) DSP restores pitch, so duration/seek remain native.
export async function createQualityPitch(ac, engine) {
  SignalsmithStretch.moduleUrl = '/core/signalsmith_stretch.js';
  await engine.loadWorklet('/core/pitch_processor.js');
  const stretch = await SignalsmithStretch(ac, {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit',
  });
  // 120 ms analysis / 15 ms hop: denser overlap than the default quarter-window.
  // Split FFT work across callbacks to avoid periodic real-time CPU spikes.
  await stretch.configure({ blockMs: 120, intervalMs: 15, splitComputation: true });
  await stretch.start();
  const legacy = new AudioWorkletNode(ac, 'clipnest-pitch', {
    outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  const input = ac.createGain(), output = ac.createGain();
  const hqGain = ac.createGain(), legacyGain = ac.createGain();
  input.connect(stretch); stretch.connect(hqGain); hqGain.connect(output);
  input.connect(legacy); legacy.connect(legacyGain); legacyGain.connect(output);
  let mode = 'signalsmith', semitones = 0, sourceRate = 1, holding = false, bypass;
  let closed = false;
  const sync = (reset = false) => {
    if (closed) return;
    const hq = mode === 'signalsmith';
    hqGain.gain.value = hq ? 1 : 0;
    legacyGain.gain.value = hq ? 0 : 1;
    legacy.parameters.get('semitones').value = hq ? 0 : semitones;
    legacy.parameters.get('sourceRate').value = hq ? 1 : sourceRate;
    // Do not compensate formants: rate resampling has moved them too, and the
    // inverse pitch shift must put them back rather than preserve the wrong ones.
    const correction = semitones - 12 * Math.log2(sourceRate);
    stretch.schedule({ semitones: correction, tonalityHz: ac.sampleRate / 2,
      formantCompensation: false, formantSemitones: 0 });
    const nextBypass = Math.abs(correction) < 0.00001;
    if (reset || nextBypass !== bypass) {
      bypass = nextBypass;
      stretch.clipnestControl(holding || !hq ? 'hold' : 'resume', bypass);
      legacy.port.postMessage(holding || hq ? 'hold' : 'resume');
      if (!holding && !hq) legacy.port.postMessage('reset');
    }
  };
  const control = action => {
    if (closed) return;
    if (action === 'hold') holding = true;
    if (action === 'resume') { if (!holding) return; holding = false; }
    sync(true);
  };
  for (const node of [stretch, legacy]) node.addEventListener('processorerror', () => input.dispatchEvent(new Event('processorerror')));
  input.parameters = new Map([
    ['semitones', { setValueAtTime(value) { semitones = value; sync(); } }],
    ['sourceRate', { setValueAtTime(value) { sourceRate = value; sync(); } }],
  ]);
  input.setMode = value => { mode = value; sync(true); };
  input.output = output;
  input.latency = await stretch.latency();
  input.port = {
    postMessage(action) {
      if (action === 'stop') {
        if (closed) return;
        stretch.clipnestControl('stop'); legacy.port.postMessage('stop');
        closed = true;
        for (const node of [input, stretch, legacy, hqGain, legacyGain, output]) node.disconnect();
      } else control(action);
    },
    close() { stretch.port.close(); legacy.port.close(); },
  };
  sync(true);
  return input;
}
