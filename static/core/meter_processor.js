// Streaming stereo K-weighted loudness estimate. No true-peak oversampling.
function coefficients(type, frequency, q, gain = 0) {
  const w = 2 * Math.PI * frequency / sampleRate, c = Math.cos(w), s = Math.sin(w);
  const a = 10 ** (gain / 40), alpha = s / (2 * q), root = 2 * Math.sqrt(a) * alpha;
  let b0, b1, b2, a0, a1, a2;
  if (type === 'shelf') {
    b0 = a * ((a + 1) + (a - 1) * c + root); b1 = -2 * a * ((a - 1) + (a + 1) * c); b2 = a * ((a + 1) + (a - 1) * c - root);
    a0 = (a + 1) - (a - 1) * c + root; a1 = 2 * ((a - 1) - (a + 1) * c); a2 = (a + 1) - (a - 1) * c - root;
  } else {
    b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filter(c, state, x) {
  const y = c[0] * x + state[0];
  state[0] = c[1] * x - c[3] * y + state[1]; state[1] = c[2] * x - c[4] * y;
  return y;
}
const lufs = (power) => power > 1e-12 ? -0.691 + 10 * Math.log10(power) : -Infinity;
class ClipNestMeter extends AudioWorkletProcessor {
  constructor() {
    super(); this.active = false; this.running = true;
    this.shelf = coefficients('shelf', 1500, Math.SQRT1_2, 4);
    this.highpass = coefficients('highpass', 38, 0.5);
    this.reset();
    this.port.onmessage = ({ data }) => {
      if (data === 'reset') this.reset();
      else if (data === 'stop') this.running = false;
      else this.active = Boolean(data.active);
    };
  }
  reset() {
    this.states = Array.from({ length: 2 }, () => [new Float64Array(2), new Float64Array(2)]);
    this.history = []; this.histogram = new Float64Array(1200); this.counts = new Uint32Array(1200);
    this.sum = 0; this.count = 0; this.peak = 0; this.hold = 0; this.raw = 0;
  }
  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!this.active || !input.length) return true;
    for (let i = 0; i < input[0].length; i++) {
      for (let ch = 0; ch < Math.min(2, input.length); ch++) {
        const value = input[ch][i]; this.raw += value * value; this.peak = Math.max(this.peak, Math.abs(value));
        const y = filter(this.highpass, this.states[ch][1], filter(this.shelf, this.states[ch][0], value)); this.sum += y * y;
      }
      this.count++;
      if (this.count >= Math.round(sampleRate * 0.1)) {
        this.history.push(this.sum / this.count); if (this.history.length > 30) this.history.shift();
        const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;
        const m = this.history.length >= 4 ? average(this.history.slice(-4)) : 0;
        const momentary = lufs(m);
        if (momentary > -70) {
          const index = Math.max(0, Math.min(1199, Math.floor((momentary + 100) * 10)));
          this.histogram[index] += m; this.counts[index]++;
        }
        let energy = 0, count = 0;
        for (let j = 0; j < 1200; j++) { energy += this.histogram[j]; count += this.counts[j]; }
        const gate = Math.max(-70, lufs(energy / Math.max(1, count)) - 10);
        energy = 0; count = 0;
        for (let j = 0; j < 1200; j++) if (j / 10 - 100 + 0.05 >= gate) { energy += this.histogram[j]; count += this.counts[j]; }
        this.hold = Math.max(this.hold, this.peak);
        this.port.postMessage({ momentary, short: this.history.length >= 30 ? lufs(average(this.history)) : -Infinity,
          integrated: lufs(energy / Math.max(1, count)), peak: 20 * Math.log10(this.peak || 1e-12), hold: 20 * Math.log10(this.hold || 1e-12),
          rms: 10 * Math.log10(this.raw / (this.count * input.length) || 1e-12) });
        this.sum = 0; this.count = 0; this.peak = 0; this.raw = 0;
      }
    }
    return true;
  }
}
registerProcessor('clipnest-meter', ClipNestMeter);
