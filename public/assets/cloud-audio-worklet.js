// Absorb normal delivery bursts without skipping live audio.
class CloudAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.frames = 0; this.rate = 48000; this.priming = true;
    this.targetFrames = this.rate * 0.4; this.maxFrames = this.rate * 2.4;
    this.muted = false; this.floor = 0; this.active = null; this.position = 0;
    this.ticks = 0; this.underruns = 0; this.droppedFrames = 0;
    this.gain = 0; this.last = [0, 0];
    this.port.onmessage = ({ data }) => {
      if (data.control) {
        this.queue = []; this.frames = 0; this.priming = true; this.gain = 0; this.last = [0, 0];
        this.floor = Math.max(this.floor, data.epoch || 0); this.muted = !!data.muted;
        return;
      }
      if (data.epoch < this.floor || this.muted || !data.samples) return;
      const samples = new Int16Array(data.samples);
      const count = samples.length / 2;
      if (!Number.isInteger(count) || !count || count > 16384 || data.rate !== 48000) return;
      this.queue.push({ samples, offset: 0, state: data.state, started: false }); this.frames += count;
      // Only discard after a prolonged backlog, never for a routine network burst.
      if (this.frames > this.maxFrames) {
        const keep = this.targetFrames + this.rate * 0.2;
        while (this.queue.length > 1 && this.frames > keep) {
          const entry = this.queue.shift(), skipped = entry.samples.length / 2 - entry.offset;
          this.frames -= skipped; this.droppedFrames += Math.ceil(skipped);
        }
        this.priming = true; this.gain = 0;
      }
    };
  }
  publish() {
    this.port.postMessage({ state: this.active ? { ...this.active, position: Math.round(this.position) } : null,
      bufferMs: Math.round(this.frames * 1000 / this.rate), targetBufferMs: Math.round(this.targetFrames * 1000 / this.rate),
      buffering: this.priming && !this.muted, underruns: this.underruns, droppedFrames: this.droppedFrames });
  }
  starved() {
    if (this.priming) return;
    this.priming = true; this.underruns++;
    this.targetFrames = Math.min(this.rate * 1.2, this.targetFrames + this.rate * 0.2);
    this.publish();
  }
  process(inputs, outputs) {
    const output = outputs[0]; if (!output?.length) return true;
    for (const channel of output) channel.fill(0);
    if (this.muted) return true;
    if (!this.queue.length) this.starved();
    if (this.priming && this.frames >= this.targetFrames) this.priming = false;
    const step = this.rate / sampleRate, ramp = 1 / (sampleRate * 0.005);
    for (let i = 0; i < output[0].length; i++) {
      const entry = this.priming ? undefined : this.queue[0];
      if (!entry) {
        this.starved();
        // A short fade prevents abrupt sample-to-zero clicks at an underrun.
        this.gain = Math.max(0, this.gain - ramp);
        for (let channel = 0; channel < output.length; channel++) output[channel][i] = this.last[Math.min(channel, 1)] * this.gain;
        continue;
      }
      if (!entry.started) {
        entry.started = true; const changed = this.active?.track_window?.current_track?.uri !== entry.state?.track_window?.current_track?.uri;
        this.active = entry.state; this.position = (entry.state?.position || 0) + entry.offset * 1000 / this.rate;
        if (changed) this.publish();
      }
      const frame = Math.floor(entry.offset), next = Math.min(frame + 1, entry.samples.length / 2 - 1), mix = entry.offset - frame;
      this.gain = Math.min(1, this.gain + ramp);
      for (let channel = 0; channel < output.length; channel++) {
        const c = Math.min(channel, 1);
        this.last[c] = (entry.samples[frame * 2 + c] * (1 - mix) + entry.samples[next * 2 + c] * mix) / 32768;
        output[channel][i] = this.last[c] * this.gain;
      }
      entry.offset += step; this.frames = Math.max(0, this.frames - step);
      if (this.active && !this.active.paused) this.position = Math.min(this.active.duration, this.position + 1000 / sampleRate);
      if (entry.offset >= entry.samples.length / 2) {
        const excess = entry.offset - entry.samples.length / 2; this.queue.shift();
        if (this.queue[0]) this.queue[0].offset = excess;
      }
    }
    this.ticks += output[0].length;
    if (this.ticks >= sampleRate / 10) { this.ticks = 0; this.publish(); }
    return true;
  }
}
registerProcessor('spotify-cloud-audio', CloudAudioProcessor);
