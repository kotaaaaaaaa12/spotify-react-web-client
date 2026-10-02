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
  process.kill = vi.fn(() => { if (process.exitCode === null) { process.exitCode = 0; process.emit('exit', 0); process.emit('close', 0, null); } });
  return process;
}
async function fixture() {
  const encoder = child(), native = child();
  const cacheDir = await mkdtemp(join(tmpdir(), 'spotify-player-test-'));
  const spawnProcess = vi.fn((name: string) => name === 'ffmpeg' ? encoder : native);
  const logger = vi.fn(); const player = new ServerPlayer({ spawnProcess, cacheDir, logger }); players.push(player);
  return { player, encoder, native, cacheDir, spawnProcess, logger };
}
const config = { expectedUsername: 'private-user', name: 'Spotify Cloud Player 1234abcd' };
describe('Container audio process', () => {
  it('uses native device authorization, pipes PCM into the encoder, and broadcasts encoded bytes', async () => {
    const { player, native, encoder, spawnProcess } = await fixture();
    await player.start(config);
    const [, args, options] = spawnProcess.mock.calls.find(call => call[0] === 'librespot')! as any;
    expect(args).toContain('--enable-device-auth'); expect(options.env).not.toHaveProperty('LIBRESPOT_ACCESS_TOKEN');
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
  it('keeps pairing announcements private and gates audio until the expected account authenticates', async () => {
    const { player, native, encoder, logger } = await fixture(); await player.start(config);
    const pcm: Buffer[] = []; encoder.stdin.on('data', (chunk: Buffer) => pcm.push(chunk));
    native.stderr.write('Browse to: https://spotify.com/pair?code=AB');
    native.stderr.write('C123\nIf prompted, enter code: ABC123\n');
    expect(player.status()).toMatchObject({ playerRevision: 'native-device-auth-1', authenticationMode: 'device', phase: 'waiting_for_pairing', pairing: { code: 'ABC123', url: 'https://spotify.com/pair?code=ABC123' } });
    native.stdout.write(Buffer.from([1, 2])); expect(pcm).toHaveLength(0); expect(player.status().pcmBytes).toBe(0);
    native.stderr.write("Authenticated as 'different-user' !\n");
    encoder.stdout.write(Buffer.from([1, 2]));
    expect(player.status()).toMatchObject({ errorCode: 'native_account_mismatch', authentication: 'rejected', phase: 'failed', pcmBytes: 0, audioBytes: 0 });
    expect(player.status().pairing).toBeUndefined(); expect(JSON.stringify(logger.mock.calls)).not.toMatch(/ABC123|different-user/);
  });
  it('clears the pairing code after approval and removes inherited token credentials', async () => {
    vi.stubEnv('LIBRESPOT_ACCESS_TOKEN', 'inherited-secret');
    try {
      const { player, native, spawnProcess } = await fixture(); await player.start(config);
      const nativeOptions = spawnProcess.mock.calls.find(call => call[0] === 'librespot')![2] as any;
      expect(nativeOptions.env).not.toHaveProperty('LIBRESPOT_ACCESS_TOKEN');
      native.stderr.write('Browse to: https://spotify.com/pair\nIf prompted, enter code: ABC123\n');
      expect(player.status().pairing.code).toBe('ABC123');
      native.stderr.write("Authenticated as 'private-user' !\n");
      expect(player.status().pairing).toBeUndefined(); expect(player.status().authentication).toBe('accepted');
    } finally { vi.unstubAllEnvs(); }
  });
  it('distinguishes audio-key rejection from login failure without exposing raw stderr', async () => {
    const { player, native } = await fixture(); await player.start(config);
    native.stderr.write('Authenticated as private-user\nError audio key for private-track\n');
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
    const { player, native, encoder } = await fixture(); await player.start(config); native.stderr.write('Authenticated as private-user\n');
    const client = () => Object.assign(new EventEmitter(), { writableLength: 0, write: vi.fn(), destroy: vi.fn() });
    const first = client(), slow = client(); slow.writableLength = 300000;
    expect(player.attach(first)).toBe(true); expect(player.attach(slow)).toBe(true); expect(player.attach(client())).toBe(false);
    encoder.stdout.write(Buffer.from([255, 251])); expect(slow.destroy).toHaveBeenCalled(); expect(player.clients.size).toBe(1);
    first.emit('close'); expect(player.clients.size).toBe(0);
  });
  it('waits for final stderr after exit and preserves the native cause ahead of encoder shutdown', async () => {
    const { player, native, encoder, logger } = await fixture(); await player.start(config);
    native.stderr.write('Authenticated as private-user\n'); native.emit('exit', 1, null);
    encoder.emit('close', 0, null);
    expect(player.status().phase).toBe('waiting_for_playback');
    native.stderr.write('ERROR librespot: could not initialize spirc: Permission denied { HTTP 403, access token private-access-token }');
    native.emit('close', 1, null);
    expect(player.status()).toMatchObject({ phase: 'failed', authentication: 'accepted', errorCode: 'spotify_access_token_failed',
      diagnostics: { revision: 'native-diagnostics-2', nativeExit: { code: 1, signal: null }, encoderExit: { code: 0, signal: null },
        events: [{ event: 'access_token_failed', errorKind: 'PermissionDenied', httpStatus: 403 }] } });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private-user|private-access-token/);
    expect(logger).toHaveBeenCalled();
  });
  it('reports signal termination without guessing why the process was killed', async () => {
    const { player, native } = await fixture(); await player.start(config);
    native.stderr.write('Authenticated as private-user\n'); native.emit('exit', null, 'SIGKILL'); native.emit('close', null, 'SIGKILL');
    expect(player.status()).toMatchObject({ errorCode: 'native_player_exited', diagnostics: { nativeExit: { code: null, signal: 'SIGKILL' } } });
  });
  it('captures complete error lines from large stderr chunks and bounds the event history', async () => {
    const { player, native } = await fixture(); await player.start(config);
    native.stderr.write('Authenticated as private-user\n');
    native.stderr.write('ERROR could not initialize spirc: No valid authentication credentials { INVALID_CREDENTIALS }\n' + 'private-data'.repeat(2000) + '\n');
    native.emit('exit', 1, null); native.emit('close', 1, null);
    expect(player.status()).toMatchObject({ errorCode: 'native_connect_initialization_failed', diagnostics: { events: [
      { event: 'connect_initialization_failed', errorKind: 'Unauthenticated', reason: 'invalid_credentials' },
    ] } });
    expect(JSON.stringify(player.status())).not.toContain('private-data');
  });
  it('captures native failure from a real subprocess with stderr lacking a final newline', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'spotify-player-test-')); const logger = vi.fn();
    const player = new ServerPlayer({ cacheDir, logger, spawnProcess: (name: string, args: string[], options: any) =>
      name === 'librespot' ? spawn(process.execPath, ['-e', "process.stderr.write('Authenticated as private-user\\nERROR could not initialize spirc: Service unavailable { INVALID_CREDENTIALS }');process.exitCode=1;"], options) : spawn(name, args, options) });
    players.push(player); await player.start(config);
    await new Promise<void>(resolve => player.native.once('close', () => resolve()));
    expect(player.status()).toMatchObject({ phase: 'failed', errorCode: 'native_connect_initialization_failed',
      diagnostics: { nativeExit: { code: 1, signal: null }, events: [{ event: 'connect_initialization_failed', errorKind: 'Unavailable', reason: 'invalid_credentials' }] } });
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private-user');
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
    const { player, native, encoder } = await fixture(); const server = createPlayerServer(player);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
      expect((await fetch(`${url}/stream`)).status).toBe(409);
      expect((await fetch(`${url}/start`, { method: 'POST', body: 'broken' })).status).toBe(400);
      expect((await fetch(`${url}/start`, { method: 'POST', body: JSON.stringify(config) })).status).toBe(200);
      native.stderr.write('Authenticated as private-user\n');
      const abort = new AbortController(); const response = await fetch(`${url}/stream`, { signal: abort.signal });
      expect(response.headers.get('Content-Type')).toBe('audio/mpeg'); expect(response.headers.get('Cache-Control')).toBe('no-store');
      const reader = response.body!.getReader(); encoder.stdout.write(Buffer.from([255, 251, 1, 2]));
      expect([...((await reader.read()).value!)]).toEqual([255, 251, 1, 2]); await reader.cancel(); abort.abort();
      expect((await fetch(`${url}/unknown`)).status).toBe(404);
    } finally { await player.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
