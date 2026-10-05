import { audioFrame } from './audio-wire.mjs';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { safePlaybackState } from './playback-state.mjs';
import { ChromeControl } from './chrome-control.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = new Set(['cloud_drm_unavailable', 'cloud_sdk_timeout', 'cloud_authentication_error', 'cloud_device_offline',
  'cloud_drm_initialization_failed', 'cloud_premium_required', 'cloud_playback_error', 'cloud_autoplay_failed',
  'cloud_sdk_connection_failed', 'cloud_sdk_load_failed', 'cloud_page_initialization_failed']);
async function endProcess(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref();
    child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
export class CloudBrowserPlayer {
  constructor({ root = '/tmp/spotify-chrome', spawnProcess = spawn, connectChrome = ChromeControl.connect,
    fileStat = stat, pageOrigin = 'http://127.0.0.1:8080' } = {}) {
    this.root = root; this.spawnProcess = spawnProcess; this.connectChrome = connectChrome; this.fileStat = fileStat;
    this.pageOrigin = pageOrigin; this.clients = new Set(); this.pcmClients = new Map(); this.generation = 0; this.queue = Promise.resolve(); this.reset();
  }
  reset() {
    this.phase = 'idle'; this.authentication = 'pending'; this.audio = 'pending'; this.errorCode = null;
    this.playback = null; this.observedAt = Date.now(); this.audioEpoch = 0; this.audioBlocked = false; this.deviceId = null; this.drm = 'pending'; this.sdk = 'pending'; this.chromeVersion = undefined;
    this.liveAudioBytes = 0; this.pcmBytes = 0; this.audioBytes = 0; this.soundReceived = false;
  }
  status() {
    return { version: 5, backend: 'cloud-browser', playerRevision: 'chrome-cloud-1', authenticationMode: 'oauth',
      phase: this.phase, authentication: this.authentication, audio: this.audio, deviceId: this.deviceId, playback: this.playback, audioTransport: 'pcm-v1', controls: 'sdk-v1', audioEpoch: this.audioEpoch,
      liveAudioBytes: this.liveAudioBytes, pcmBytes: this.pcmBytes, audioBytes: this.audioBytes, errorCode: this.errorCode,
      diagnostics: { revision: 'chrome-diagnostics-1', drm: this.drm, sdk: this.sdk, chromeVersion: this.chromeVersion, events: [] } };
  }
  serialize(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  updateToken({ accessToken, tokenExpiresAt }) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192 || /\s|\0/.test(accessToken) ||
      !Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) throw new Error('Invalid token.');
    this.accessToken = accessToken; this.tokenExpiresAt = tokenExpiresAt;
  }
  token() {
    if (!this.accessToken || this.tokenExpiresAt <= Date.now() || ['failed', 'stopped', 'idle'].includes(this.phase)) return null;
    return { access_token: this.accessToken };
  }
  fail(code) {
    if (['failed', 'stopped'].includes(this.phase)) return;
    this.errorCode = code; this.phase = 'failed'; this.audio = 'failed';
    if (code === 'cloud_authentication_error' || code === 'cloud_premium_required') this.authentication = 'rejected';
    this.playback = null; this.accessToken = null; this.closeClients(); this.control?.close();
    for (const child of [this.chrome, this.capture, this.encoder, this.pulse]) child?.kill('SIGTERM');
  }
  start(input) {
    return this.serialize(async () => {
      if (!/^Spotify Cloud Player [a-f0-9]{8}$/.test(input.name || '') || typeof input.expectedUsername !== 'string' ||
        !input.expectedUsername || input.expectedUsername.length > 128 || /[\r\n\0]/.test(input.expectedUsername)) throw new Error('Invalid player configuration.');
      if (this.chrome && this.name === input.name && this.expectedUsername === input.expectedUsername && !['failed', 'stopped'].includes(this.phase)) {
        this.updateToken(input); return this.status();
      }
      await this.stopInternal(); this.reset(); this.updateToken(input);
      this.name = input.name; this.expectedUsername = input.expectedUsername; this.phase = 'starting'; const generation = ++this.generation;
      const runtime = join(this.root, 'runtime'); const profile = join(this.root, 'profile');
      await rm(this.root, { recursive: true, force: true }); await mkdir(runtime, { recursive: true, mode: 0o700 }); await mkdir(profile, { mode: 0o700 });
      const pulseSocket = join(runtime, 'pulse-native');
      const env = { ...process.env, XDG_RUNTIME_DIR: runtime, PULSE_SERVER: 'unix:' + pulseSocket };
      this.pulse = this.launch('pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1', '--disable-shm', '--log-target=stderr',
        '--load=module-native-protocol-unix socket=' + pulseSocket + ' auth-anonymous=1',
        '--load=module-null-sink sink_name=spotify_cloud rate=48000 channels=2'], { env, stdio: ['ignore', 'pipe', 'pipe'] }, 'cloud_audio_server_unavailable', generation);
      for (let i = 0; i < 50 && this.phase !== 'failed'; i++) { try { await this.fileStat(pulseSocket); break; } catch { await wait(100); } }
      try { await this.fileStat(pulseSocket); } catch { this.fail('cloud_audio_server_unavailable'); return this.status(); }
      if (this.phase === 'failed') return this.status();
      this.encoder = this.launch('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
        '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-id3v2_version', '0', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'],
        { env, stdio: ['pipe', 'pipe', 'pipe'] }, 'encoder_unavailable', generation);
      this.capture = this.launch('parec', ['--raw', '--format=s16le', '--rate=48000', '--channels=2', '--device=spotify_cloud.monitor', '--latency-msec=40'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] }, 'cloud_audio_capture_unavailable', generation);
      this.encoder.stdin.on('error', () => { if (this.generation === generation) this.fail('encoder_input_closed'); });
      const pcm = new Transform({ transform: (chunk, _, done) => {
        if (this.generation !== generation || this.authentication !== 'accepted' || this.phase === 'failed') return done();
        if (!this.soundReceived && chunk.some(byte => byte !== 0)) this.soundReceived = true;
        if (!this.soundReceived) return done();
        this.pcmBytes += chunk.length; this.audio = 'encoding';
        if (!this.audioBlocked) this.sendPcm(chunk);
        done(null, chunk);
      } });
      this.capture.stdout.pipe(pcm).pipe(this.encoder.stdin);
      this.encoder.stdout.on('data', chunk => {
        if (this.generation !== generation || this.phase === 'failed' || this.authentication !== 'accepted' || !this.soundReceived) return;
        this.phase = 'streaming'; this.audio = 'received'; this.audioBytes += chunk.length;
        for (const client of this.clients) {
          if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); } else client.write(chunk);
        }
      });
      this.chrome = this.launch(process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox',
        '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
        '--password-store=basic', 'about:blank'], { env, stdio: ['ignore', 'pipe', 'pipe'] }, 'cloud_browser_unavailable', generation);
      void this.monitor(profile, generation); return this.status();
    });
  }
  launch(command, args, options, errorCode, generation) {
    const child = this.spawnProcess(command, args, options);
    child.on('error', () => { if (this.generation === generation) this.fail(errorCode); });
    // Chrome logs and DevTools frames may contain URLs or credentials.
    child.stderr?.on('data', () => {}); if (!['parec', 'ffmpeg'].includes(command)) child.stdout?.on('data', () => {});
    child.once('close', () => { if (this.generation === generation) this.fail(errorCode.replace('_unavailable', '_exited')); }); return child;
  }
  async monitor(profile, generation) {
    const active = () => this.generation === generation && !['failed', 'stopped'].includes(this.phase);
    let control;
    try {
      control = await this.connectChrome(profile, active);
      if (!active()) { control.close(); return; }
      this.control = control; this.chromeVersion = control.version;
      await control.open(this.pageOrigin + '/browser-player'); let activated = false; const startedAt = Date.now();
      while (active()) {
        const report = await control.report(); if (!active()) break;
        if (['accepted', 'rejected'].includes(report?.drm)) this.drm = report.drm;
        if (['pending', 'connecting', 'ready', 'failed'].includes(report?.sdk)) this.sdk = report.sdk;
        if (report?.errorCode) { this.fail(errors.has(report.errorCode) ? report.errorCode : 'cloud_sdk_connection_failed'); break; }
        if (report?.sdk === 'ready' && /^[a-zA-Z0-9_-]{1,128}$/.test(report.deviceId || '') && this.drm === 'accepted') {
          this.deviceId = report.deviceId; this.authentication = 'accepted';
          this.playback = safePlaybackState(report.playback); this.observedAt = Date.now();
          if (this.phase === 'starting') this.phase = 'waiting_for_playback';
          if (!activated) { activated = true; await control.activate(); }
        }
        if (!this.deviceId && Date.now() - startedAt > 95000) { this.fail('cloud_sdk_timeout'); break; }
        await wait(250);
      }
    } catch { if (active()) this.fail(control ? 'cloud_browser_control_failed' : 'cloud_browser_start_failed'); }
  }
  command({ action, value }) {
    return this.serialize(async () => {
      if (this.authentication !== 'accepted' || !this.control || ['failed', 'stopped'].includes(this.phase)) throw new Error('Player unavailable.');
      if (!['pause', 'resume', 'next', 'previous', 'seek', 'volume', 'flush'].includes(action) ||
        (action === 'seek' && (!Number.isInteger(value) || value < 0 || value > 86400000)) ||
        (action === 'volume' && (!Number.isFinite(value) || value < 0 || value > 1))) throw new Error('Invalid control.');
      if (action !== 'volume') { this.audioBlocked = true; ++this.audioEpoch; }
      try {
        if (action !== 'flush') { this.playback = safePlaybackState(await this.control.command(action, value)); this.observedAt = Date.now(); }
        for (const [client, info] of this.pcmClients) this.sendMetadata(client, info);
        return this.status();
      } finally { this.audioBlocked = false; }
    });
  }
  sendMetadata(client, info) {
    const state = this.playback ? { ...this.playback, position: this.playback.paused ? this.playback.position :
      Math.min(this.playback.duration, this.playback.position + Math.max(0, Date.now() - this.observedAt)) } : null;
    client.write(audioFrame(0, new TextEncoder().encode(JSON.stringify({ version: 1, rate: 48000, channels: 2, epoch: this.audioEpoch, state }))));
    info.sentAt = Date.now(); info.key = `${this.audioEpoch}:${state?.track_window.current_track.uri}:${state?.paused}`;
  }
  sendPcm(chunk) {
    // Keep stereo samples aligned even when Node splits the source pipe read.
    const source = this.pcmRemainder?.length ? Buffer.concat([this.pcmRemainder, chunk]) : chunk;
    const length = source.length - source.length % 4; this.pcmRemainder = source.subarray(length);
    if (length && this.pcmClients.size && !this.playback?.paused) { this.liveAudioBytes += length; this.phase = 'streaming'; this.audio = 'received'; }
    for (const [client, info] of this.pcmClients) {
      if (client.writableLength > 48000 * 4 * 2.4) { clearInterval(info.heartbeat); client.destroy(); this.pcmClients.delete(client); continue; }
      const key = `${this.audioEpoch}:${this.playback?.track_window.current_track.uri}:${this.playback?.paused}`;
      if (Date.now() - info.sentAt >= (this.playback?.paused ? 1000 : 250) || info.key !== key) this.sendMetadata(client, info);
      if (this.playback?.paused) continue;
      for (let offset = 0; offset < length; offset += 32768) {
        const bytes = source.subarray(offset, Math.min(length, offset + 32768));
        const payload = new Uint8Array(4 + bytes.length); new DataView(payload.buffer).setUint32(0, this.audioEpoch); payload.set(bytes, 4);
        client.write(audioFrame(1, payload));
      }
    }
  }
  attachPcm(response) {
    if (this.authentication !== 'accepted' || ['failed', 'stopped'].includes(this.phase) || this.clients.size + this.pcmClients.size >= 2) return false;
    const info = { sentAt: 0, key: '', heartbeat: null };
    this.pcmClients.set(response, info);
    // The HTTP handler flushes headers synchronously before this microtask.
    // Send state immediately, including before the first track produces sound.
    const heartbeat = () => {
      if (!this.pcmClients.has(response)) return;
      if (response.destroyed || response.writableEnded || response.writableLength > 48000 * 4 * 2.4) {
        clearInterval(info.heartbeat); this.pcmClients.delete(response); response.destroy(); return;
      }
      if (Date.now() - info.sentAt >= 1000) this.sendMetadata(response, info);
    };
    queueMicrotask(heartbeat);
    info.heartbeat = setInterval(heartbeat, 1000); info.heartbeat.unref?.();
    response.once('close', () => { clearInterval(info.heartbeat); this.pcmClients.delete(response); }); return true;
  }
  attach(response) {
    if (this.authentication !== 'accepted' || ['failed', 'stopped'].includes(this.phase) || this.clients.size + this.pcmClients.size >= 2) return false;
    this.clients.add(response); response.once('close', () => this.clients.delete(response)); return true;
  }
  closeClients() { for (const client of this.clients) client.end(); for (const [client, info] of this.pcmClients) { clearInterval(info.heartbeat); client.end(); } this.clients.clear(); this.pcmClients.clear(); this.pcmRemainder = null; }
  async stopInternal() {
    ++this.generation; this.phase = 'stopped'; this.playback = null; this.accessToken = null; this.tokenExpiresAt = 0;
    this.closeClients(); this.control?.close(); this.control = null;
    await Promise.all([this.chrome, this.capture, this.encoder, this.pulse].map(endProcess));
    this.chrome = this.capture = this.encoder = this.pulse = null;
    await rm(this.root, { recursive: true, force: true });
  }
  stop() { return this.serialize(async () => { await this.stopInternal(); return null; }); }
  dispose() { return this.stop(); }
}
