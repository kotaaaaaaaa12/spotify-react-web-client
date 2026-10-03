import { AudioFrameReader } from '../../../container/audio-wire.mjs';
import { safePlaybackState } from '../../../container/playback-state.mjs';

export interface AudioTiming { transport: 'pcm-v1'; bufferMs: number; underruns: number; droppedFrames: number }
export class LowLatencyAudio {
  private context = new AudioContext({ latencyHint: 'interactive' });
  private node?: AudioWorkletNode;
  private abort = new AbortController();
  private setup?: Promise<void>;
  private floor = 0;
  private muted = false;
  private closed = false;
  constructor(private onState: (state: Spotify.PlaybackState | null) => void, private onTiming: (timing: AudioTiming) => void, private onError: () => void) {}
  connect(url: string) {
    this.setup = this.open(url); void this.setup.catch(() => { if (!this.closed) this.onError(); });
  }
  private async open(url: string) {
    await this.context.audioWorklet.addModule('/assets/cloud-audio-worklet.js?v=1');
    if (this.closed) return;
    const node = this.node = new AudioWorkletNode(this.context, 'spotify-cloud-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = ({ data }) => {
      if (this.closed || this.muted) return;
      this.onState(data.state); this.onTiming({ transport: 'pcm-v1', bufferMs: data.bufferMs, underruns: data.underruns, droppedFrames: data.droppedFrames });
    };
    node.connect(this.context.destination); this.reset(this.muted, this.floor);
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal });
    if (!response.ok || response.headers.get('Content-Type') !== 'application/x-spotify-pcm' || !response.body) throw new Error('Live audio unavailable.');
    const reader = response.body.getReader(); const frames = new AudioFrameReader();
    let metadata: { epoch: number; state: Spotify.PlaybackState | null } | undefined, samplesSinceMetadata = 0;
    while (!this.closed) {
      const chunk = await reader.read(); if (chunk.done) throw new Error('Live audio ended.');
      frames.push(chunk.value, (type: number, bytes: Uint8Array) => {
        if (type === 0) {
          const value = JSON.parse(new TextDecoder().decode(bytes));
          if (value.version !== 1 || value.rate !== 48000 || value.channels !== 2 || !Number.isSafeInteger(value.epoch) || value.epoch < this.floor || value.epoch > 0xffffffff) return;
          const next = { epoch: value.epoch, state: safePlaybackState(value.state) as unknown as Spotify.PlaybackState | null };
          metadata = next; samplesSinceMetadata = 0;
          if (next.state?.paused && !this.muted) { this.reset(false, value.epoch); this.onState(next.state); }
        } else {
          const epoch = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
          if (!metadata || metadata.epoch !== epoch || epoch < this.floor) return;
          const state = metadata.state ? { ...metadata.state, position: Math.min(metadata.state.duration, metadata.state.position + samplesSinceMetadata * 1000 / 48000) } : null;
          samplesSinceMetadata += (bytes.length - 4) / 4;
          const samples = bytes.slice(4).buffer;
          if (!this.muted && this.context.state === 'running' && !state?.paused) node.port.postMessage({ samples, state, epoch, rate: 48000 }, [samples]);
        }
      });
    }
  }
  play() { if (this.closed) return Promise.resolve(); return this.context.resume(); }
  pause() { this.reset(true); }
  reset(muted = this.muted, epoch = this.floor) {
    this.muted = muted; this.floor = Math.max(this.floor, epoch);
    this.node?.port.postMessage({ control: true, muted, epoch: this.floor });
  }
  begin() { this.reset(true); }
  complete(epoch: number, paused: boolean) { this.reset(paused, epoch); }
  dispose() {
    this.closed = true; this.abort.abort(); this.node?.disconnect(); this.node?.port.close();
    void this.context.close().catch(() => {});
  }
}
export const supportsLiveAudio = () => typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
