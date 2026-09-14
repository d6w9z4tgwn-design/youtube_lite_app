const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function processor(filename, sampleRate = 48000) {
  let Class;
  const context = vm.createContext({ sampleRate, Math,
    AudioWorkletProcessor: class { constructor() { this.messages = []; this.port = { postMessage: m => this.messages.push(m) }; } },
    registerProcessor: (_name, value) => { Class = value; },
  });
  if (filename === 'pitch_processor.js') {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/core/soundtouch_processor.js'), 'utf8').replace('export { SoundTouchProcessor };', ''), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/core', filename), 'utf8').replace(/^import .*;\n/, ''), context);
  return new Class();
}
function pitchSignal(semitones, sourceRate = 1) {
  const node = processor('pitch_processor.js'), result = [];
  for (let block = 0; block < 500; block++) {
    const input = Float32Array.from({ length: 128 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 440 * sourceRate * (block * 128 + i) / 48000));
    const output = [new Float32Array(128), new Float32Array(128)];
    node.process([[input, input]], [output], { semitones: [semitones], sourceRate: [sourceRate] });
    assert.ok(output[0].every(Number.isFinite));
    if (block >= 450) result.push(...output[0]);
    if (semitones === 0 && sourceRate === 1) assert.deepEqual(output[0], input);
  }
  return result;
}
function strongestFrequency(samples, min, max) {
  let strongest = 0, peak = 0;
  for (let hz = min; hz <= max; hz++) {
    let re = 0, im = 0;
    for (let i = 0; i < samples.length; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (samples.length - 1));
      re += samples[i] * w * Math.cos(2 * Math.PI * hz * i / 48000);
      im += samples[i] * w * Math.sin(2 * Math.PI * hz * i / 48000);
    }
    if (re * re + im * im > peak) { peak = re * re + im * im; strongest = hz; }
  }
  return strongest;
}
pitchSignal(0);
for (const sourceRate of [0.5, 0.75, 1.25, 1.5, 2, 3]) {
  const hz = strongestFrequency(pitchSignal(0, sourceRate), 410, 470);
  assert.ok(Math.abs(hz - 440) < 10, `Tempo ${sourceRate}: ${hz}Hz`);
  for (const semitones of [-12, 0, 12]) {
    const node = processor('pitch_processor.js');
    const input = new Float32Array(128).fill(0.1), output = [new Float32Array(128), new Float32Array(128)];
    for (let block = 0; block < 2000; block++) {
      node.process([[input, input]], [output], { semitones: [semitones], sourceRate: [sourceRate] });
      if (block > 250) assert.ok(output.every(channel => channel.every(value => value > 0.05 && value < 0.15)), `Tempo gap: ${sourceRate} / ${semitones} / ${block}`);
    }
  }
}
assert.ok(Math.abs(strongestFrequency(pitchSignal(12, 2), 850, 910) - 880) < 10);
assert.ok(Math.abs(strongestFrequency(pitchSignal(-12, 2), 190, 250) - 220) < 10);
console.log('PASS: 0.5–3x SoundTouch rate compensation, combined tempo/pitch and continuous output');
// A positive DC signal cannot legitimately contain zero-valued output gaps.
// Check partial-quantum underruns as well as completely silent blocks.
for (const sampleRate of [44100, 48000, 96000]) {
  for (const semitones of [-12, -7, -1, 1, 7, 12]) {
    const node = processor('pitch_processor.js', sampleRate);
    const input = new Float32Array(128).fill(0.1);
    const output = [new Float32Array(128), new Float32Array(128)];
    for (let block = 0; block < 3000; block++) {
      node.process([[input, input]], [output], { semitones: [semitones] });
      if (block > 250) assert.ok(output.every(channel => channel.every(value => value > 0.05 && value < 0.15)), `Pitch gap: ${sampleRate}Hz / ${semitones} / block ${block}`);
    }
    node.port.onmessage({ data: 'hold' });
    node.process([[input, input]], [output], { semitones: [semitones] });
    assert.ok(output.every(channel => channel.every(value => value === 0)));
    node.port.onmessage({ data: 'resume' });
    const silence = new Float32Array(128);
    for (let block = 0; block < 250; block++) {
      node.process([[silence, silence]], [output], { semitones: [semitones] });
      assert.ok(output.every(channel => channel.every(value => value === 0)), 'Old samples survived seek flush');
    }
  }
}
console.log('PASS: continuous pitch output at 44.1/48/96kHz, ±1/7/12 semitones, seek flush');
const up = strongestFrequency(pitchSignal(12), 800, 960);
const down = strongestFrequency(pitchSignal(-12), 180, 260);
assert.ok(Math.abs(up - 880) < 15, `Up octave: ${up}`);
assert.ok(Math.abs(down - 220) < 15, `Down octave: ${down}`);
const meter = processor('meter_processor.js');
meter.port.onmessage({ data: { active: true } });
for (let block = 0; block < 1600; block++) {
  const input = Float32Array.from({ length: 128 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 997 * (block * 128 + i) / 48000));
  meter.process([[input, input]]);
}
const reading = meter.messages.at(-1);
assert.ok(Math.abs(reading.peak + 20) < 0.1);
assert.ok(Math.abs(reading.rms + 23.01) < 0.1);
assert.ok(Math.abs(reading.integrated + 20) < 1, JSON.stringify(reading));
assert.ok(Number.isFinite(reading.short));
const count = meter.messages.length;
meter.port.onmessage({ data: { active: false } });
meter.process([[new Float32Array(128), new Float32Array(128)]]);
assert.equal(meter.messages.length, count);
meter.port.onmessage({ data: 'reset' });
assert.equal(meter.hold, 0);
console.log(`PASS: pitch bypass, +12=${up}Hz, -12=${down}Hz, meter peak/RMS/LUFS, pause/reset`);
