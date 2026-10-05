import { AudioFrameReader } from '../../../container/audio-wire.mjs';
import { safePlaybackState } from '../../../container/playback-state.mjs';

type AudioStage = 'worklet' | 'request' | 'response' | 'read' | 'decode';
export interface AudioFailure { errorCode: string; stage: AudioStage; httpStatus?: number }
export interface AudioTiming {
  transport: 'pcm-v1'; revision: 'live-audio-2'; bufferMs: number; underruns: number; droppedFrames: number;
  connection: 'connecting' | 'connected' | 'reconnecting' | 'failed'; reconnects: number; receivedBytes: number;
  audioContextState: string; errorCode?: string; stage?: AudioStage; httpStatus?: number;
}
class LiveAudioError extends Error {
  constructor(public detail: AudioFailure, public retryable = false) { super(detail.errorCode); }
}
export class LowLatencyAudio {
  private context = new AudioContext({ latencyHint: 'interactive' });
  private node?: AudioWorkletNode;
  private lifetime = new AbortController();
  private request?: AbortController;
  private started = false;
  private floor = 0;
  private muted = false;
  private closed = false;
  private failed = false;
  private timing: AudioTiming = { transport: 'pcm-v1', revision: 'live-audio-2', bufferMs: 0, underruns: 0,
    droppedFrames: 0, connection: 'connecting', reconnects: 0, receivedBytes: 0, audioContextState: 'suspended' };
  constructor(private onState: (state: Spotify.PlaybackState | null) => void, private onTiming: (timing: AudioTiming) => void,
    private onError: (failure: AudioFailure) => void) {}
  private publish(update: Partial<AudioTiming> = {}) {
    this.timing = { ...this.timing, ...update, audioContextState: this.context.state }; this.onTiming({ ...this.timing });
  }
  private fail(error: LiveAudioError) {
    if (this.closed || this.failed) return;
    this.failed = true; this.request?.abort(); this.reset();
    this.publish({ ...error.detail, connection: 'failed' }); this.onError(error.detail);
  }
  connect(url: string) {
    if (this.started || this.closed) return; this.started = true;
    void this.open(url).catch(error => this.fail(error instanceof LiveAudioError ? error :
      new LiveAudioError({ errorCode: 'audio_worklet_failed', stage: 'worklet' })));
  }
  private async open(url: string) {
    this.publish();
    await this.context.audioWorklet.addModule('/assets/cloud-audio-worklet.js?v=2');
    if (this.closed) return;
    const node = this.node = new AudioWorkletNode(this.context, 'spotify-cloud-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.onprocessorerror = () => this.fail(new LiveAudioError({ errorCode: 'audio_worklet_failed', stage: 'worklet' }));
    node.port.onmessage = ({ data }) => {
      if (this.closed || this.failed || this.muted) return;
      this.onState(data.state); this.publish({ bufferMs: data.bufferMs, underruns: data.underruns, droppedFrames: data.droppedFrames });
    };
    node.connect(this.context.destination); this.reset();
    let failures = 0;
    while (!this.closed && !this.failed) {
      const attempt = { healthySince: 0, healthyFor: 0 };
      try { await this.readStream(url, node, attempt); }
      catch (error) {
        if (this.closed || this.failed) return;
        const failure = error instanceof LiveAudioError ? error : new LiveAudioError({ errorCode: 'audio_network_error', stage: 'read' }, true);
        // A recovered stream gets a fresh budget after 15 seconds of frames.
        if (attempt.healthyFor >= 15000) failures = 0;
        if (!failure.retryable || failures >= 3) { this.fail(failure); return; }
        this.reset(); this.publish({ ...failure.detail, connection: 'reconnecting', reconnects: this.timing.reconnects + 1 });
        const delay = [500, 1500, 3000][failures++];
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, delay); this.lifetime.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  private async readStream(url: string, node: AudioWorkletNode, attempt: { healthySince: number; healthyFor: number }) {
    const abort = this.request = new AbortController();
    let stage: AudioStage = 'request', timedOut = false;
    let timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 20000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      stage = 'response';
      if (!response.ok) throw new LiveAudioError({ errorCode: 'audio_http_error', stage, httpStatus: response.status },
        [408, 409, 425, 429].includes(response.status) || response.status >= 500);
      if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-spotify-pcm' || !response.body)
        throw new LiveAudioError({ errorCode: 'audio_invalid_response', stage, httpStatus: response.status });
      reader = response.body.getReader(); const frames = new AudioFrameReader();
      let metadata: { epoch: number; state: Spotify.PlaybackState | null } | undefined, samplesSinceMetadata = 0;
      while (!this.closed && !this.failed) {
        stage = 'read'; clearTimeout(timeout);
        timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 15000);
        const chunk = await reader.read();
        if (chunk.done) throw new LiveAudioError({ errorCode: 'audio_stream_ended', stage }, true);
        stage = 'decode';
        frames.push(chunk.value, (type: number, bytes: Uint8Array) => {
          if (type === 0) {
            const value = JSON.parse(new TextDecoder().decode(bytes));
            if (value.version !== 1 || value.rate !== 48000 || value.channels !== 2 || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || value.epoch > 0xffffffff)
              throw new LiveAudioError({ errorCode: 'audio_invalid_frame', stage: 'decode' });
            if (value.epoch < this.floor) return;
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
          if (!attempt.healthySince) attempt.healthySince = Date.now();
          attempt.healthyFor = Date.now() - attempt.healthySince;
        });
        this.publish({ connection: 'connected', receivedBytes: this.timing.receivedBytes + chunk.value.byteLength });
      }
    } catch (error) {
      if (error instanceof LiveAudioError) throw error;
      throw new LiveAudioError({ errorCode: timedOut ? 'audio_stream_timeout' : stage === 'decode' ? 'audio_invalid_frame' : 'audio_network_error', stage }, stage !== 'decode');
    } finally {
      clearTimeout(timeout); abort.abort();
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (this.request === abort) this.request = undefined;
    }
  }
  play() { if (this.closed || this.failed) return Promise.resolve(); return this.context.resume(); }
  pause() { this.reset(true); }
  reset(muted = this.muted, epoch = this.floor) {
    this.muted = muted; this.floor = Math.max(this.floor, epoch);
    this.node?.port.postMessage({ control: true, muted, epoch: this.floor });
  }
  begin() { this.reset(true); }
  complete(epoch: number, paused: boolean) { this.reset(paused, epoch); }
  dispose() {
    this.closed = true; this.lifetime.abort(); this.request?.abort(); this.node?.disconnect(); this.node?.port.close();
    void this.context.close().catch(() => {});
  }
}
export const supportsLiveAudio = () => typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
