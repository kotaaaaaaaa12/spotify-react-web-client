import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerPlayer, FFMPEG_ARGS } from '../container/player.mjs';
import { createPlayerServer } from '../container/server.mjs';

const players: any[] = [];
afterEach(async () => { for (const player of players.splice(0)) await player.dispose(); vi.useRealTimers(); });
function child() {
  const process = new EventEmitter() as any;
  Object.assign(process, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  process.kill = vi.fn(() => { if (process.exitCode === null) { process.exitCode = 0; process.emit('exit', 0); } });
  return process;
}
async function fixture() {
  const encoder = child(), native = child();
  const cacheDir = await mkdtemp(join(tmpdir(), 'spotify-player-test-'));
  const spawnProcess = vi.fn((name: string) => name === 'ffmpeg' ? encoder : native);
  const player = new ServerPlayer({ spawnProcess, cacheDir }); players.push(player);
  return { player, encoder, native, cacheDir, spawnProcess };
}
const config = { accessToken: 'private-access-token', name: 'Spotify Cloud Player 1234abcd' };
describe('Container audio process', () => {
  it('passes the token through environment, pipes PCM into the encoder, and broadcasts encoded bytes', async () => {
    const { player, native, encoder, spawnProcess } = await fixture();
    await player.start(config);
    const [, args, options] = spawnProcess.mock.calls.find(call => call[0] === 'librespot')! as any;
    expect(args.join(' ')).not.toContain(config.accessToken); expect(options.env.LIBRESPOT_ACCESS_TOKEN).toBe(config.accessToken);
    expect(args).toContain('--disable-discovery'); expect(args).not.toContain('--device');
    native.stderr.write('Authenticated as private-user\n'); expect(player.status().authentication).toBe('accepted');
    const client = new EventEmitter() as any; client.writableLength = 0; client.write = vi.fn(); client.destroy = vi.fn();
    expect(player.attach(client)).toBe(true);
    const input: Buffer[] = []; encoder.stdin.on('data', (chunk: Buffer) => input.push(chunk));
    native.stdout.write(Buffer.from([1, 2, 3, 4])); encoder.stdout.write(Buffer.from([255, 251, 5]));
    expect(Buffer.concat(input)).toEqual(Buffer.from([1, 2, 3, 4])); expect(client.write).toHaveBeenCalledWith(Buffer.from([255, 251, 5]));
    expect(player.status()).toMatchObject({ phase: 'streaming', pcmBytes: 4, audioBytes: 3, audio: 'received' });
    expect(JSON.stringify(player.status())).not.toMatch(/private-user|private-access/);
    await player.start(config); expect(spawnProcess).toHaveBeenCalledTimes(2);
    await player.stop(); expect(client.destroy).toHaveBeenCalled(); expect(player.status().phase).toBe('stopped');
    await expect(access(player.cacheDir)).rejects.toThrow();
  });
  it('distinguishes audio-key rejection from login failure without exposing raw stderr', async () => {
    const { player, native } = await fixture(); await player.start(config);
    native.stderr.write('Authenticated as secret-email\nError audio key for private-track\n');
    expect(player.status()).toMatchObject({ authentication: 'accepted', phase: 'failed', audio: 'failed', errorCode: 'spotify_audio_key_rejected' });
    expect(JSON.stringify(player.status())).not.toMatch(/secret-email|private-track/);
    await player.start(config);
    native.stderr.write('Authentication failed: private-access-token\n');
    expect(player.status()).toMatchObject({ authentication: 'rejected', errorCode: 'spotify_authentication_rejected' });
  });
  it('reports executable errors and ignores output from a stopped process generation', async () => {
    const { player, native, encoder } = await fixture(); await player.start(config);
    encoder.emit('error', Error('private runtime details')); expect(player.status().errorCode).toBe('encoder_unavailable');
    await player.stop(); native.stdout.emit('data', Buffer.from([1, 2])); encoder.stdout.emit('data', Buffer.from([1, 2]));
    expect(player.status()).toMatchObject({ phase: 'stopped', pcmBytes: 0, audioBytes: 0 });
  });
  it('bounds clients and disconnects slow receivers rather than retaining audio buffers', async () => {
    const { player, encoder } = await fixture(); await player.start(config);
    const client = () => Object.assign(new EventEmitter(), { writableLength: 0, write: vi.fn(), destroy: vi.fn() });
    const first = client(), slow = client(); slow.writableLength = 300000;
    expect(player.attach(first)).toBe(true); expect(player.attach(slow)).toBe(true); expect(player.attach(client())).toBe(false);
    encoder.stdout.write(Buffer.from([255, 251])); expect(slow.destroy).toHaveBeenCalled(); expect(player.clients.size).toBe(1);
    first.emit('close'); expect(player.clients.size).toBe(0);
  });
  it('stops an inactive native session after ten minutes', async () => {
    vi.useFakeTimers(); const { player, native } = await fixture(); await player.start(config);
    await vi.advanceTimersByTimeAsync(610000);
    await player.queue;
    expect(native.kill).toHaveBeenCalled(); expect(player.status().phase).toBe('stopped');
  });
  it('produces real decodable stereo MP3 with the production encoder arguments', async () => {
    const encoder = spawn('ffmpeg', FFMPEG_ARGS); const chunks: Buffer[] = [];
    encoder.stdout.on('data', chunk => chunks.push(chunk)); encoder.stderr.resume();
    const complete = new Promise<void>((resolve, reject) => { encoder.once('error', reject); encoder.once('close', code => code === 0 ? resolve() : reject(Error(`Encoder exited ${code}`))); });
    const pcm = Buffer.alloc(44100 * 4);
    for (let sample = 0; sample < 44100; sample++) { const value = Math.round(Math.sin(sample * Math.PI * 2 * 440 / 44100) * 10000); pcm.writeInt16LE(value, sample * 4); pcm.writeInt16LE(value, sample * 4 + 2); }
    encoder.stdin.end(pcm); await complete;
    const mp3 = Buffer.concat(chunks); expect(mp3.length).toBeGreaterThan(20000);
    const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', 'pipe:0'], { input: mp3 }).toString());
    expect(decoded.streams[0]).toMatchObject({ codec_name: 'mp3', sample_rate: '44100', channels: 2 });
  }, 10000);
});
describe('Container HTTP boundary', () => {
  it('validates start requests and serves audio as a streaming response', async () => {
    const { player, encoder } = await fixture(); const server = createPlayerServer(player);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/stream`)).status).toBe(409);
      expect((await fetch(`${url}/start`, { method: 'POST', body: 'broken' })).status).toBe(400);
      expect((await fetch(`${url}/start`, { method: 'POST', body: JSON.stringify(config) })).status).toBe(200);
      const abort = new AbortController(); const response = await fetch(`${url}/stream`, { signal: abort.signal });
      expect(response.headers.get('Content-Type')).toBe('audio/mpeg'); expect(response.headers.get('Cache-Control')).toBe('no-store');
      const reader = response.body!.getReader(); encoder.stdout.write(Buffer.from([255, 251, 1, 2]));
      expect([...((await reader.read()).value!)]).toEqual([255, 251, 1, 2]); await reader.cancel(); abort.abort();
      expect((await fetch(`${url}/unknown`)).status).toBe(404);
    } finally { await player.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
