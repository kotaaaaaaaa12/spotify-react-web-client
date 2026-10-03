import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudBrowserPlayer } from '../container/cloud-browser-player.mjs';
import { createPlayerServer } from '../container/server.mjs';
import { request as httpRequest } from 'node:http';

const players: any[] = [];
afterEach(async () => { for (const player of players.splice(0)) await player.dispose(); });
function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null });
  const kill = vi.fn(() => { if (process.exitCode === null) { process.exitCode = 0; process.emit('close', 0, 'SIGTERM'); } });
  return Object.assign(process, { kill });
}
async function fixture() {
  const processes = new Map<string, any>(); let browserReport: any = { drm: 'pending', sdk: 'pending' };
  const control = { command: vi.fn(async () => browserReport.playback), open: vi.fn(async () => {}), report: vi.fn(async () => browserReport), activate: vi.fn(async () => {}), close: vi.fn(), version: 'Chrome/140.0.0.0' };
  const spawnProcess = vi.fn((command: string) => { const process = child(); processes.set(command, process); return process; });
  const root = await mkdtemp(join(tmpdir(), 'spotify-chrome-test-'));
  const player = new CloudBrowserPlayer({ root, spawnProcess, fileStat: async () => ({}), connectChrome: async () => control }); players.push(player);
  const config = { expectedUsername: 'verified-user', name: 'Spotify Cloud Player 1234abcd', accessToken: 'private-oauth', tokenExpiresAt: Date.now() + 3600000 };
  return { player, processes, config, control, spawnProcess, setReport: (value: any) => { browserReport = value; } };
}
describe('Cloud browser audio and credential lifecycle', () => {
  it('uses unmuted full Chrome, waits for DRM and SDK, and excludes idle silence from audio success', async () => {
    const { player, config, processes, setReport, control, spawnProcess } = await fixture();
    await player.start(config);
    const launch = spawnProcess.mock.calls.find(call => String(call[0]).includes('chrome'))! as any;
    expect(launch[1]).toContain('--headless=new'); expect(launch[1]).not.toContain('--mute-audio');
    expect(launch[1]).not.toContain('--disable-web-security'); expect(JSON.stringify(launch)).not.toContain('private-oauth');
    const capture = processes.get('parec'), encoder = processes.get('ffmpeg'); const pcm: Buffer[] = [];
    encoder.stdin.on('data', (chunk: Buffer) => pcm.push(chunk));
    capture.stdout.write(Buffer.from([1, 2])); expect(pcm).toHaveLength(0);
    setReport({ drm: 'accepted', sdk: 'ready', deviceId: 'cloud-device' });
    await vi.waitFor(() => expect(player.status().authentication).toBe('accepted'), { timeout: 2000 });
    expect(control.activate).toHaveBeenCalledOnce(); expect(player.status().phase).toBe('waiting_for_playback');
    capture.stdout.write(Buffer.alloc(100)); encoder.stdout.write(Buffer.from([255, 251]));
    expect(player.status()).toMatchObject({ audio: 'pending', pcmBytes: 0, audioBytes: 0 });
    const client = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn(), writableLength: 0 });
    expect(player.attach(client)).toBe(true);
    capture.stdout.write(Buffer.from([1, 2, 3, 4])); encoder.stdout.write(Buffer.from([255, 251, 1]));
    expect(player.status()).toMatchObject({ phase: 'streaming', audio: 'received', pcmBytes: 4, audioBytes: 3, deviceId: 'cloud-device' });
    expect(client.write).toHaveBeenCalledWith(Buffer.from([255, 251, 1]));
    expect(JSON.stringify(player.status())).not.toMatch(/private-oauth|verified-user/);
    await player.start({ ...config, accessToken: 'rotated-oauth' }); expect(player.token()).toEqual({ access_token: 'rotated-oauth' }); expect(spawnProcess).toHaveBeenCalledTimes(4);
    await player.stop(); expect(player.token()).toBeNull(); expect(client.end).toHaveBeenCalledOnce();
    encoder.stdout.write(Buffer.from([255, 251])); expect(player.status().audioBytes).toBe(3);
  });
  it('relays only this SDK track and clears its playback state on stop', async () => {
    const { player, config, setReport } = await fixture(); await player.start(config);
    setReport({ drm: 'accepted', sdk: 'ready', deviceId: 'cloud-device', playback: {
      paused: false, position: 12000, duration: 180000, accessToken: 'private-oauth',
      track_window: { current_track: { id: 'track1', uri: 'spotify:track:track1', name: 'Current song',
        artists: [{ name: 'Artist', uri: 'spotify:artist:artist1' }], album: { images: [] } } },
    } });
    await vi.waitFor(() => expect(player.status().playback?.position).toBe(12000), { timeout: 2000 });
    expect(player.status().playback.track_window.current_track.name).toBe('Current song');
    expect(JSON.stringify(player.status())).not.toContain('private-oauth');
    await player.stop(); expect(player.status().playback).toBeNull();
  });
  it('frames PCM with the matching SDK track, invalidates old audio on controls, and rejects slow clients', async () => {
    const { player, config, setReport, processes, control } = await fixture(); await player.start(config);
    const playback = { paused: false, position: 1000, duration: 180000, track_window: { current_track: { name: 'PCM song', uri: 'spotify:track:track', id: 'track', artists: [], album: { images: [] } } } };
    setReport({ drm: 'accepted', sdk: 'ready', deviceId: 'cloud-device', playback });
    await vi.waitFor(() => expect(player.status().playback?.position).toBe(1000));
    const chunks: Uint8Array[] = [];
    const client = Object.assign(new EventEmitter(), { write: (chunk: Uint8Array) => chunks.push(chunk), end: vi.fn(), destroy: vi.fn(), writableLength: 0 });
    expect(player.attachPcm(client)).toBe(true); processes.get('parec').stdout.write(Buffer.from([1, 2, 3, 4]));
    const frames: any[] = []; const { AudioFrameReader } = await import('../container/audio-wire.mjs'); const reader = new AudioFrameReader();
    for (const chunk of chunks) reader.push(chunk, (type: number, bytes: Uint8Array) => frames.push({ type, bytes }));
    expect(JSON.parse(new TextDecoder().decode(frames[0].bytes)).state.track_window.current_track.name).toBe('PCM song');
    expect([...frames[1].bytes.slice(4)]).toEqual([1, 2, 3, 4]);
    control.command.mockResolvedValueOnce({ ...playback, paused: true });
    await player.command({ action: 'pause' }); expect(control.command).toHaveBeenCalledWith('pause', undefined); expect(player.status().audioEpoch).toBe(1);
    await expect(player.command({ action: 'seek', value: -1 })).rejects.toThrow('Invalid control');
    chunks.splice(0); const bytesBeforePause = player.status().liveAudioBytes; processes.get('parec').stdout.write(Buffer.from([1, 2, 3, 4]));
    expect(chunks.every(chunk => chunk[0] === 0)).toBe(true); expect(player.status().liveAudioBytes).toBe(bytesBeforePause);
    client.writableLength = 150000; processes.get('parec').stdout.write(Buffer.from([1, 2, 3, 4])); expect(client.destroy).toHaveBeenCalledOnce();
  });
  it('reports a DRM failure distinctly and stops all processes without emitting credentials or raw errors', async () => {
    const { player, config, processes, setReport } = await fixture(); await player.start(config);
    setReport({ drm: 'rejected', sdk: 'failed', errorCode: 'cloud_drm_unavailable', message: 'private-oauth' });
    await vi.waitFor(() => expect(player.status().phase).toBe('failed'), { timeout: 2000 });
    expect(player.status()).toMatchObject({ errorCode: 'cloud_drm_unavailable', diagnostics: { drm: 'rejected' }, pcmBytes: 0 });
    expect(JSON.stringify(player.status())).not.toContain('private-oauth'); expect(player.token()).toBeNull();
    for (const process of processes.values()) expect(process.kill).toHaveBeenCalled();
  });
  it('limits attached clients, drops slow consumers, and denies tokens after stop or expiry', async () => {
    const { player, config, processes, setReport } = await fixture(); await player.start(config);
    setReport({ drm: 'accepted', sdk: 'ready', deviceId: 'cloud-device' });
    await vi.waitFor(() => expect(player.status().authentication).toBe('accepted'), { timeout: 2000 });
    const client = () => Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn(), writableLength: 0 });
    const first = client(), slow = client(); slow.writableLength = 300000;
    expect(player.attach(first)).toBe(true); expect(player.attach(slow)).toBe(true); expect(player.attach(client())).toBe(false);
    processes.get('parec').stdout.write(Buffer.from([1, 2])); processes.get('ffmpeg').stdout.write(Buffer.from([255, 251]));
    expect(slow.destroy).toHaveBeenCalled(); expect(player.clients.size).toBe(1);
    player.tokenExpiresAt = Date.now() - 1; expect(player.token()).toBeNull();
    await expect(player.start({ ...config, accessToken: 'bad token' })).rejects.toThrow('Invalid token');
  });
  it('serves OAuth only on loopback with an exact Host and same-origin request', async () => {
    const { player, config } = await fixture(); await player.start(config);
    const server = createPlayerServer(player); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const html = await (await fetch(origin + '/browser-player')).text(); expect(html).not.toContain('private-oauth');
      expect(await (await fetch(origin + '/browser-token')).json()).toEqual({ access_token: 'private-oauth' });
      for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        // Native fetch normalizes some forbidden browser headers. Send the
        // actual wire headers to exercise Host and Fetch Metadata validation.
        const response: any = await new Promise(resolve => { httpRequest(origin + '/browser-token', { headers }, response => {
          let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
        }).end(); });
        expect(response.status).toBe(403); expect(response.body).not.toContain('private-oauth');
      }
      expect((await fetch(origin + '/browser-token', { method: 'POST' })).status).toBe(403);
      expect(await (await fetch(origin + '/status')).text()).not.toContain('private-oauth');
      await player.stop(); expect((await fetch(origin + '/browser-token')).status).toBe(401);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
