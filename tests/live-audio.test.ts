import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { audioFrame, AudioFrameReader } from '../container/audio-wire.mjs';

function processor(outputRate = 48000) {
  let Processor: any; const messages: any[] = [];
  runInNewContext(readFileSync('public/assets/cloud-audio-worklet.js', 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (data: any) => messages.push(data), onmessage: null }; },
    registerProcessor: (_: string, implementation: any) => { Processor = implementation; }, sampleRate: outputRate,
  });
  const player = new Processor();
  const send = (name: string, epoch = 0, count = 4800) => player.port.onmessage({ data: { epoch, rate: 48000,
    samples: new Int16Array(count * 2).fill(name === 'first' ? 8000 : 16000).buffer,
    state: { paused: false, position: 0, duration: 180000, track_window: { current_track: { uri: 'spotify:track:' + name } } },
  } });
  const output = () => { const channels = [new Float32Array(128), new Float32Array(128)]; player.process([], [channels]); return channels; };
  return { player, send, output, messages };
}
describe('Live PCM transport and audible playback state', () => {
  it('parses fragmented and coalesced frames without accepting oversized or misaligned PCM', () => {
    const reader = new AudioFrameReader(), received: any[] = [];
    const a = audioFrame(0, new TextEncoder().encode('{"epoch":1}')), b = audioFrame(1, new Uint8Array(8));
    const bytes = new Uint8Array(a.length + b.length); bytes.set(a); bytes.set(b, a.length);
    for (let i = 0; i < bytes.length; i += 3) reader.push(bytes.slice(i, i + 3), (type: number, data: Uint8Array) => received.push({ type, data }));
    expect(received.map(frame => frame.type)).toEqual([0, 1]);
    expect(() => reader.push(audioFrame(1, new Uint8Array(7)), () => {})).toThrow('Invalid audio frame');
    expect(() => new AudioFrameReader().push(new Uint8Array(1024 * 1024 + 1), () => {})).toThrow('limit');
  });
  it('changes the displayed track when that track reaches audio output, not when it is queued', () => {
    const { send, output, messages } = processor(); send('first'); send('first'); send('second');
    output(); expect(messages.at(-1).state.track_window.current_track.uri).toBe('spotify:track:first');
    expect(messages.some(message => message.state?.track_window.current_track.uri.endsWith('second'))).toBe(false);
    for (let i = 0; i < 76; i++) output();
    expect(messages.some(message => message.state?.track_window.current_track.uri.endsWith('second'))).toBe(true);
  });
  it('bounds latency after a burst and silences output immediately while rejecting old control epochs', () => {
    const { player, send, output } = processor(); for (let i = 0; i < 30; i++) send('first');
    expect(player.frames).toBeLessThanOrEqual(48000 * 0.6); expect(player.droppedFrames).toBeGreaterThan(0);
    player.port.onmessage({ data: { control: true, muted: true, epoch: 2 } });
    expect([...output()[0]].every(sample => sample === 0)).toBe(true); expect(player.frames).toBe(0);
    player.port.onmessage({ data: { control: true, muted: false, epoch: 2 } }); send('first', 1); expect(player.frames).toBe(0);
    send('second', 2); send('second', 2); expect(output()[0][0]).toBeCloseTo(16000 / 32768);
  });
  it('resamples to the device audio rate with the correct sample count', () => {
    const { send, output, player } = processor(44100); send('first'); send('first');
    const initial = player.frames; for (let i = 0; i < 5; i++) output();
    expect(initial - player.frames).toBeCloseTo(5 * 128 * 48000 / 44100, 1);
  });
});
