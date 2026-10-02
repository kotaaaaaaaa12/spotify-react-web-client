import { spawn } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { classifyNativeLine, nativeFailureCode, processExit, safeDiagnostics, DIAGNOSTICS_REVISION } from './diagnostics.mjs';
import { PLAYER_REVISION, safeDevicePairing } from './device-auth.mjs';

const CACHE_DIR = '/tmp/spotify-player-credentials';
const FFMPEG_ARGS = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
  '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-id3v2_version', '0', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'];

export class ServerPlayer {
  constructor({ spawnProcess = spawn, cacheDir = CACHE_DIR, now = () => Date.now(), logger = report => console.error(JSON.stringify(report)) } = {}) {
    this.spawnProcess = spawnProcess; this.cacheDir = cacheDir; this.now = now;
    this.clients = new Set(); this.generation = 0; this.queue = Promise.resolve();
    this.logger = logger;
    this.reset();
    this.watchdog = setInterval(() => {
      if (this.native && this.now() - this.lastActivity > 10 * 60 * 1000) void this.stop();
    }, 10000);
    this.watchdog.unref();
  }
  reset() {
    this.phase = 'idle'; this.authentication = 'pending'; this.audio = 'pending';
    this.errorCode = null; this.pcmBytes = 0; this.audioBytes = 0; this.name = null;
    this.lastActivity = this.now();
    this.diagnostics = { revision: DIAGNOSTICS_REVISION, events: [] }; this.nativeFailure = null;
    this.pairing = undefined;
  }
  status() {
    return { playerRevision: PLAYER_REVISION, authenticationMode: 'device', pairing: safeDevicePairing(this.pairing), phase: this.phase, authentication: this.authentication, audio: this.audio,
      pcmBytes: this.pcmBytes, audioBytes: this.audioBytes, errorCode: this.errorCode, diagnostics: safeDiagnostics(this.diagnostics) };
  }
  logFailure() {
    try { const { pairing, ...report } = this.status(); this.logger({ component: 'spotify-server-player', ...report }); } catch { /* Logging must not interrupt cleanup. */ }
  }
  serialize(fn) { const promise = this.queue.then(fn); this.queue = promise.catch(() => {}); return promise; }
  start({ expectedUsername, name }) {
    return this.serialize(async () => {
      if (typeof expectedUsername !== 'string' || !expectedUsername || expectedUsername.length > 128 || /[\r\n\0]/.test(expectedUsername) ||
          !/^Spotify Cloud Player [a-f0-9]{8}$/.test(name || '')) throw new Error('Invalid player configuration.');
      if (this.native && this.name === name && this.phase !== 'failed') return this.status();
      await this.stopInternal(); this.reset(); this.name = name; this.phase = 'starting';
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const generation = ++this.generation;
      const encoder = this.spawnProcess('ffmpeg', FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
      // Device authorization obtains native credentials without the Web API token.
      const { LIBRESPOT_ACCESS_TOKEN, LIBRESPOT_USERNAME, LIBRESPOT_PASSWORD, ...nativeEnv } = process.env;
      const native = this.spawnProcess('librespot', ['--name', name, '--backend', 'pipe', '--format', 'S16', '--bitrate', '160',
        '--initial-volume', '100', '--disable-discovery', '--enable-device-auth', '--system-cache', this.cacheDir, '--disable-audio-cache'], {
        env: { ...nativeEnv, RUST_LOG: 'librespot=info' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.native = native; this.encoder = encoder;
      const current = () => this.generation === generation;
      const fail = (code, stage) => {
        if (!current() || this.phase === 'failed') return;
        this.phase = 'failed'; this.errorCode = code;
        this.pairing = undefined;
        if (stage === 'authentication') this.authentication = 'rejected';
        else this.audio = 'failed';
        native.kill('SIGTERM'); encoder.kill('SIGTERM');
        this.closeClients();
        this.logFailure();
      };
      native.on('error', () => fail('native_process_unavailable', 'authentication'));
      encoder.on('error', () => fail('encoder_unavailable', 'audio'));
      encoder.stdin.on('error', () => fail('encoder_input_closed', 'audio'));
      const pcm = new Transform({ transform: (chunk, encoding, callback) => {
        callback(null, current() && this.authentication === 'accepted' && this.phase !== 'failed' ? chunk : undefined);
      } });
      native.stdout.pipe(pcm).pipe(encoder.stdin);
      native.stdout.on('data', (chunk) => {
        if (!current() || this.phase === 'failed' || this.authentication !== 'accepted') return;
        this.pcmBytes += chunk.length; this.lastActivity = this.now();
        this.audio = 'encoding';
      });
      let tail = '';
      const consumeLine = line => {
        if (this.phase !== 'failed' && this.authentication !== 'accepted') {
          const url = line.match(/^Browse to: (https:\/\/spotify\.com\/pair(?:\?code=[A-Za-z0-9-]{4,32})?)$/)?.[1];
          if (url) this.pairing = { url, code: new URL(url).searchParams.get('code') || '' };
          const code = line.match(/^If prompted, enter code: ([A-Za-z0-9-]{4,32})$/)?.[1];
          if (code && this.pairing) this.pairing.code = code;
          if (safeDevicePairing(this.pairing)) this.phase = 'waiting_for_pairing';
        }
        const evidence = classifyNativeLine(line);
        if (evidence) {
          this.diagnostics.events.push(evidence); this.diagnostics.events = this.diagnostics.events.slice(-12);
          this.nativeFailure = nativeFailureCode(line, evidence) || this.nativeFailure;
        }
        const username = line.match(/Authenticated as (?:'([^']+)'|([^\s]+))/i);
        if (username && this.phase !== 'failed') {
          this.pairing = undefined;
          if ((username[1] || username[2]) !== expectedUsername) { fail('native_account_mismatch', 'authentication'); return; }
          this.authentication = 'accepted'; this.phase = 'waiting_for_playback';
        }
        if (/AudioKeyError|audio key.*error|error audio key|Unable to load key/i.test(line)) fail('spotify_audio_key_rejected', 'audio');
        else if (/Unable to read audio file|Skipping to next track, unable to load/i.test(line)) fail('spotify_track_unavailable', 'audio');
        else if (/BadCredentials|Login failed|Authentication failed|invalid.*access.*token/i.test(line)) fail('spotify_authentication_rejected', 'authentication');
      };
      native.stderr.on('data', (chunk) => {
        if (!current()) return;
        const lines = (tail + chunk.toString()).split(/\r?\n/); tail = lines.pop().slice(-8192);
        for (const line of lines) consumeLine(line.slice(0, 8192));
      });
      encoder.stderr.on('data', () => {});
      encoder.stdout.on('data', (chunk) => {
        if (!current() || this.phase === 'failed' || this.authentication !== 'accepted') return;
        this.audioBytes += chunk.length; this.phase = 'streaming'; this.audio = 'received'; this.lastActivity = this.now();
        for (const client of this.clients) {
          // Disconnect slow clients instead of accumulating unbounded audio.
          if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); }
          else client.write(chunk);
        }
      });
      let nativeEnded = false;
      native.stdout.once('end', () => { nativeEnded = true; });
      native.once('exit', () => { nativeEnded = true; });
      // 'exit' can precede the final stderr bytes. 'close' follows stdio draining.
      native.once('close', (code, signal) => {
        if (!current()) return;
        if (tail) { consumeLine(tail); tail = ''; }
        this.diagnostics.nativeExit = processExit(code, signal);
        if (this.phase === 'failed') this.logFailure();
        else fail(this.nativeFailure || 'native_player_exited', this.authentication === 'accepted' ? 'audio' : 'authentication');
      });
      encoder.once('close', (code, signal) => {
        if (!current()) return;
        this.diagnostics.encoderExit = processExit(code, signal);
        if (this.phase === 'failed') this.logFailure();
        else if (!nativeEnded) fail('encoder_exited', 'audio');
      });
      return this.status();
    });
  }
  attach(client) {
    if (!this.native || this.phase === 'failed') return false;
    if (this.clients.size >= 2) return false;
    this.clients.add(client); this.lastActivity = this.now();
    client.once('close', () => this.clients.delete(client));
    return true;
  }
  closeClients() { for (const client of this.clients) client.destroy(); this.clients.clear(); }
  stop() { return this.serialize(() => this.stopInternal()); }
  async stopInternal() {
    ++this.generation; this.closeClients();
    const processes = [this.native, this.encoder].filter(Boolean); this.native = null; this.encoder = null;
    for (const child of processes) {
      if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) continue;
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500); timer.unref();
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
      });
    }
    await rm(this.cacheDir, { recursive: true, force: true });
    this.reset(); this.phase = 'stopped';
  }
  async dispose() { clearInterval(this.watchdog); await this.stop(); }
}

export { FFMPEG_ARGS };
