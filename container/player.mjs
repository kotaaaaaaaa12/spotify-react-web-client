import { spawn } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';

const CACHE_DIR = '/tmp/spotify-player-credentials';
const FFMPEG_ARGS = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
  '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-id3v2_version', '0', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'];

export class ServerPlayer {
  constructor({ spawnProcess = spawn, cacheDir = CACHE_DIR, now = () => Date.now() } = {}) {
    this.spawnProcess = spawnProcess; this.cacheDir = cacheDir; this.now = now;
    this.clients = new Set(); this.generation = 0; this.queue = Promise.resolve();
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
  }
  status() {
    return { phase: this.phase, authentication: this.authentication, audio: this.audio,
      pcmBytes: this.pcmBytes, audioBytes: this.audioBytes, errorCode: this.errorCode };
  }
  serialize(fn) { const promise = this.queue.then(fn); this.queue = promise.catch(() => {}); return promise; }
  start({ accessToken, name }) {
    return this.serialize(async () => {
      if (typeof accessToken !== 'string' || accessToken.length < 8 || accessToken.length > 8192 || /[\r\n\0]/.test(accessToken) ||
          !/^Spotify Cloud Player [a-f0-9]{8}$/.test(name || '')) throw new Error('Invalid player configuration.');
      if (this.native && this.name === name && this.phase !== 'failed') return this.status();
      await this.stopInternal(); this.reset(); this.name = name; this.phase = 'starting';
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const generation = ++this.generation;
      const encoder = this.spawnProcess('ffmpeg', FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
      // Keep the token out of command-line arguments and never print process logs.
      const native = this.spawnProcess('librespot', ['--name', name, '--backend', 'pipe', '--format', 'S16', '--bitrate', '160',
        '--initial-volume', '100', '--disable-discovery', '--system-cache', this.cacheDir, '--disable-audio-cache'], {
        env: { ...process.env, LIBRESPOT_ACCESS_TOKEN: accessToken, RUST_LOG: 'librespot=info' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.native = native; this.encoder = encoder;
      const current = () => this.generation === generation;
      const fail = (code, stage) => {
        if (!current() || this.phase === 'failed') return;
        this.phase = 'failed'; this.errorCode = code;
        if (stage === 'authentication') this.authentication = 'rejected';
        else this.audio = 'failed';
        native.kill('SIGTERM'); encoder.kill('SIGTERM');
        this.closeClients();
      };
      native.on('error', () => fail('native_process_unavailable', 'authentication'));
      encoder.on('error', () => fail('encoder_unavailable', 'audio'));
      encoder.stdin.on('error', () => fail('encoder_input_closed', 'audio'));
      native.stdout.pipe(encoder.stdin);
      native.stdout.on('data', (chunk) => {
        if (!current()) return;
        this.pcmBytes += chunk.length; this.lastActivity = this.now();
        this.authentication = 'accepted'; this.audio = 'encoding';
      });
      let tail = '';
      native.stderr.on('data', (chunk) => {
        if (!current()) return;
        tail = (tail + chunk.toString()).slice(-8192);
        const lines = tail.split(/\r?\n/); tail = lines.pop();
        for (const line of lines) {
          if (/Authenticated as/i.test(line)) { this.authentication = 'accepted'; if (this.phase !== 'failed') this.phase = 'waiting_for_playback'; }
          if (/AudioKeyError|audio key.*error|error audio key|Unable to load key/i.test(line)) fail('spotify_audio_key_rejected', 'audio');
          else if (/Unable to read audio file|Skipping to next track, unable to load/i.test(line)) fail('spotify_track_unavailable', 'audio');
          else if (/BadCredentials|Login failed|Authentication failed|invalid.*access.*token/i.test(line)) fail('spotify_authentication_rejected', 'authentication');
        }
      });
      encoder.stderr.on('data', () => {});
      encoder.stdout.on('data', (chunk) => {
        if (!current() || this.phase === 'failed') return;
        this.audioBytes += chunk.length; this.phase = 'streaming'; this.audio = 'received'; this.lastActivity = this.now();
        for (const client of this.clients) {
          // Disconnect slow clients instead of accumulating unbounded audio.
          if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); }
          else client.write(chunk);
        }
      });
      native.once('exit', () => fail('native_player_exited', this.authentication === 'accepted' ? 'audio' : 'authentication'));
      encoder.once('exit', () => fail('encoder_exited', 'audio'));
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
      if (child.exitCode !== null && child.exitCode !== undefined) continue;
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
