// A bounded queue keeps live playback close to the source after a network stall.
class CloudAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.frames = 0; this.rate = 48000; this.priming = true;
    this.muted = false; this.floor = 0; this.active = null; this.position = 0;
    this.ticks = 0; this.underruns = 0; this.droppedFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.control) {
        this.queue = []; this.frames = 0; this.priming = true;
        this.floor = Math.max(this.floor, data.epoch || 0); this.muted = !!data.muted;
        return;
      }
      if (data.epoch < this.floor || this.muted || !data.samples) return;
      const samples = new Int16Array(data.samples);
      const count = samples.length / 2;
      if (!count || count > 16384 || data.rate !== 48000) return;
      this.queue.push({ samples, offset: 0, state: data.state, started: false }); this.frames += count;
      if (this.frames > this.rate * 0.6) {
        while (this.queue.length > 1 && this.frames > this.rate * 0.18) {
          const entry = this.queue.shift(), skipped = entry.samples.length / 2 - entry.offset;
          this.frames -= skipped; this.droppedFrames += Math.ceil(skipped);
        }
        this.priming = true;
      }
    };
  }
  publish() {
    this.port.postMessage({ state: this.active ? { ...this.active, position: Math.round(this.position) } : null,
      bufferMs: Math.round(this.frames * 1000 / this.rate), underruns: this.underruns, droppedFrames: this.droppedFrames });
  }
  process(inputs, outputs) {
    const output = outputs[0]; if (!output?.length) return true;
    for (const channel of output) channel.fill(0);
    if (this.muted || !this.queue.length) return true;
    if (this.priming && this.frames < this.rate * 0.12) return true;
    this.priming = false; const step = this.rate / sampleRate;
    for (let i = 0; i < output[0].length; i++) {
      const entry = this.queue[0];
      if (!entry) { this.priming = true; this.underruns++; break; }
      if (!entry.started) {
        entry.started = true; const changed = this.active?.track_window?.current_track?.uri !== entry.state?.track_window?.current_track?.uri;
        this.active = entry.state; this.position = (entry.state?.position || 0) + entry.offset * 1000 / this.rate;
        if (changed) this.publish();
      }
      const frame = Math.floor(entry.offset), next = Math.min(frame + 1, entry.samples.length / 2 - 1), mix = entry.offset - frame;
      for (let channel = 0; channel < output.length; channel++) {
        const c = Math.min(channel, 1);
        output[channel][i] = (entry.samples[frame * 2 + c] * (1 - mix) + entry.samples[next * 2 + c] * mix) / 32768;
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
