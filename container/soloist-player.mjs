import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { SoloistDiscovery, wait } from './soloist-discovery.mjs';
import { captureState, restoreState, sessionAccounts, SOLOIST_REVISION } from './soloist-state.mjs';

const ROOT = '/tmp/spotify-soloist';
const encoderArgs = ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
  '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '0', '-id3v2_version', '0', '-flush_packets', '1', '-f', 'mp3', 'pipe:1'];
async function endProcess(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref();
    child.once('close', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}

export class SoloistPlayer {
  constructor({ root = ROOT, spawnProcess = spawn, discovery = () => new SoloistDiscovery(), WebSocketClient = globalThis.WebSocket } = {}) {
    this.root = root; this.spawnProcess = spawnProcess; this.createDiscovery = discovery; this.WebSocketClient = WebSocketClient;
    this.clients = new Set(); this.generation = 0; this.queue = Promise.resolve(); this.reset();
  }
  reset() {
    this.phase = 'idle'; this.authentication = 'pending'; this.audio = 'pending'; this.errorCode = null;
    this.pcmBytes = 0; this.audioBytes = 0; this.soundReceived = false; this.endpoint = null; this.loggedIn = false;
    this.discoveryState = 'pending'; this.nativeExit = null; this.encoderExit = null; this.storedSession = false;
  }
  status() {
    return { version: 4, backend: 'soloist', playerRevision: SOLOIST_REVISION, authenticationMode: 'zeroconf',
      phase: this.phase, authentication: this.authentication, audio: this.audio, pcmBytes: this.pcmBytes, audioBytes: this.audioBytes,
      errorCode: this.errorCode, pairingRequired: this.phase === 'waiting_for_pairing', discovery: this.discoveryState,
      sessionRestored: this.storedSession, diagnostics: { revision: 'soloist-diagnostics-1',
        ...(this.nativeExit ? { nativeExit: this.nativeExit } : {}), ...(this.encoderExit ? { encoderExit: this.encoderExit } : {}), events: [] } };
  }
  serialize(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  fail(code, authentication = false) {
    if (this.phase === 'failed' || this.phase === 'stopped') return;
    this.errorCode = code; this.phase = 'failed';
    if (authentication) this.authentication = 'rejected'; else this.audio = 'failed';
    this.closeClients();
    for (const child of [this.native, this.capture, this.encoder, this.pulse]) child?.kill('SIGTERM');
    try { this.socket?.close(); } catch { /* A connecting socket may already be closed. */ }
    this.discovery?.close();
  }
  start({ expectedUsername, name, apiKey, checkpoint }) {
    return this.serialize(async () => {
      if (typeof expectedUsername !== 'string' || !expectedUsername || expectedUsername.length > 128 || /[\r\n\0]/.test(expectedUsername) ||
        !/^Spotify Cloud Player [a-f0-9]{8}$/.test(name || '') || typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /\s|\0/.test(apiKey)) throw new Error('Invalid Soloist configuration.');
      if (this.native && this.name === name && !['failed', 'stopped'].includes(this.phase)) return this.status();
      await this.stopInternal(); this.reset(); this.name = name; this.expectedUsername = expectedUsername;
      this.phase = 'starting'; const generation = ++this.generation;
      this.dataDir = join(this.root, 'data'); const runtime = join(this.root, 'runtime');
      await rm(this.root, { recursive: true, force: true });
      await mkdir(runtime, { recursive: true, mode: 0o700 }); await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      if (checkpoint) { await restoreState(this.dataDir, checkpoint, expectedUsername); this.storedSession = true; }
      const pulseSocket = join(runtime, 'pulse-native');
      const env = { ...process.env, XDG_RUNTIME_DIR: runtime, PULSE_SERVER: `unix:${pulseSocket}` };
      // A private Unix socket and a private null sink are used; there is no
      // network audio server and no dependency on the phone's audio hardware.
      this.pulse = this.spawnProcess('pulseaudio', ['-n', '--daemonize=no', '--exit-idle-time=-1', '--disable-shm', '--log-target=stderr',
        `--load=module-native-protocol-unix socket=${pulseSocket} auth-anonymous=1`, '--load=module-null-sink sink_name=spotify_cloud rate=44100 channels=2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.pulse.on('error', () => this.fail('soloist_audio_server_unavailable'));
      this.pulse.stdout.on('data', () => {}); this.pulse.stderr.on('data', () => {});
      this.pulse.once('close', () => { if (this.generation === generation) this.fail('soloist_audio_server_exited'); });
      for (let i = 0; i < 50 && this.phase !== 'failed'; i++) { try { await stat(pulseSocket); break; } catch { await wait(100); } }
      try { await stat(pulseSocket); } catch { this.fail('soloist_audio_server_unavailable'); return this.status(); }
      this.encoder = this.spawnProcess('ffmpeg', encoderArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.capture = this.spawnProcess('parec', ['--raw', '--format=s16le', '--rate=44100', '--channels=2', '--device=spotify_cloud.monitor', '--latency-msec=100'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.encoder.on('error', () => this.fail('encoder_unavailable')); this.capture.on('error', () => this.fail('soloist_audio_capture_unavailable'));
      this.encoder.stdin.on('error', () => { if (this.generation === generation) this.fail('encoder_input_closed'); });
      this.capture.stderr.on('data', () => {}); this.encoder.stderr.on('data', () => {});
      const pcm = new Transform({ transform: (chunk, _, callback) => {
        if (this.generation !== generation || this.authentication !== 'accepted' || this.phase === 'failed') return callback();
        // A null sink emits silence while idle. Do not report that as successful
        // Spotify playback or send it into the encoder before actual sound.
        if (!this.soundReceived && chunk.some(byte => byte !== 0)) this.soundReceived = true;
        if (!this.soundReceived) return callback();
        this.pcmBytes += chunk.length; this.audio = 'encoding'; callback(null, chunk);
      } });
      this.capture.stdout.pipe(pcm).pipe(this.encoder.stdin);
      this.encoder.stdout.on('data', chunk => {
        if (this.generation !== generation || this.phase === 'failed' || this.authentication !== 'accepted') return;
        this.phase = 'streaming'; this.audio = 'received'; this.audioBytes += chunk.length;
        for (const client of this.clients) {
          if (client.writableLength > 256 * 1024) { client.destroy(); this.clients.delete(client); } else client.write(chunk);
        }
      });
      this.encoder.once('close', (code, signal) => {
        if (this.generation !== generation) return;
        this.encoderExit = { code: Number.isInteger(code) ? code : null, signal: ['SIGTERM', 'SIGKILL'].includes(signal) ? signal : null }; this.fail('encoder_exited');
      });
      this.capture.once('close', () => { if (this.generation === generation) this.fail('soloist_audio_capture_exited'); });
      this.discovery = this.createDiscovery(); await this.discovery.start();
      this.native = this.spawnProcess('soloist', ['--device-name', name, '--api-key', apiKey, '--data-dir', this.dataDir,
        '--cache-dir', join(this.root, 'cache'), '--cache-size', '100', '--initial-volume', '100', '--ws', '127.0.0.1:0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.native.on('error', () => this.fail('soloist_process_unavailable', true));
      // Soloist logs to stdout as well as stderr. Neither stream is audio, and
      // neither is forwarded to logs or the browser because it may contain keys.
      this.native.stdout.on('data', () => {}); this.native.stderr.on('data', () => {});
      this.native.once('close', (code, signal) => {
        if (this.generation !== generation) return;
        this.nativeExit = { code: Number.isInteger(code) ? code : null, signal: ['SIGTERM', 'SIGKILL'].includes(signal) ? signal : null };
        this.fail(code === 10 ? 'soloist_build_expired' : 'soloist_player_exited', this.authentication !== 'accepted');
      });
      void this.monitor(generation); return this.status();
    });
  }
  async monitor(generation) {
    let websocketConnected = false;
    for (let i = 0; i < 40 && this.generation === generation && this.phase !== 'failed'; i++) {
      try {
        if (!websocketConnected) {
          const port = Number(await readFile(join(this.dataDir, 'ws.port'), 'utf8'));
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            this.socket = new this.WebSocketClient(`ws://127.0.0.1:${port}/`); websocketConnected = true;
            this.socket.addEventListener('message', event => {
              try {
                if (this.generation !== generation || typeof event.data !== 'string' || event.data.length > 256 * 1024) return;
                const data = JSON.parse(event.data);
                if (data.type === 'auth_state') {
                  this.loggedIn = data.logged_in === true;
                  if (this.loggedIn) void this.verifyOwner(generation);
                  else if (this.authentication === 'accepted') this.fail('soloist_session_lost', true);
                }
              } catch { /* Only typed authentication events are consumed. */ }
            });
            this.socket.addEventListener('error', () => { if (this.generation === generation) this.fail('soloist_control_unavailable'); });
          }
        }
        if (!this.endpoint) this.endpoint = await this.discovery.resolve(this.name);
        if (this.endpoint) {
          this.discoveryState = 'accepted';
          if (this.authentication !== 'accepted') this.phase = 'waiting_for_pairing';
        }
        if (this.loggedIn) await this.verifyOwner(generation);
        if (websocketConnected && (this.authentication === 'accepted' || (this.endpoint && !this.loggedIn))) return;
      } catch { /* Continue while the native process initializes its interfaces. */ }
      await wait(750);
    }
    if (this.generation !== generation || this.phase === 'failed') return;
    this.discoveryState = this.endpoint ? 'accepted' : 'failed';
    this.fail(websocketConnected ? 'soloist_connect_discovery_failed' : 'soloist_control_unavailable');
  }
  async getInfo() {
    if (!this.endpoint) throw new Error('Soloist discovery is not ready.');
    const response = await fetch(`${this.endpoint}?action=getInfo&version=2.10.0`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Soloist did not respond.');
    const text = await response.text(); if (text.length > 65536) throw new Error('Invalid Soloist response.');
    const info = JSON.parse(text);
    if (info.status !== 101 || info.remoteName !== this.name || typeof info.deviceID !== 'string' || typeof info.publicKey !== 'string') throw new Error('Invalid Soloist device.');
    return info;
  }
  async verifyOwner(generation = this.generation) {
    if (!this.loggedIn || this.phase === 'failed') return;
    const accounts = await sessionAccounts(this.dataDir);
    let username;
    try { const info = await this.getInfo(); if (typeof info.activeUser === 'string' && info.activeUser) username = decodeURIComponent(info.activeUser); } catch { /* Stored native account state is another owner check. */ }
    if (this.generation !== generation || !this.loggedIn || this.phase === 'failed') return;
    if (accounts.some(account => account !== this.expectedUsername) || (username && username !== this.expectedUsername)) return this.fail('native_account_mismatch', true);
    if (username === this.expectedUsername || (accounts.length === 1 && accounts[0] === this.expectedUsername)) {
      this.authentication = 'accepted'; if (this.phase !== 'streaming') this.phase = 'waiting_for_playback';
    }
  }
  async addUser(form) {
    if (!this.endpoint || this.phase === 'failed') throw new Error('Soloist pairing is unavailable.');
    const input = new URLSearchParams(form);
    let username; try { username = decodeURIComponent(input.get('userName') || ''); } catch { throw new Error('Invalid account.'); }
    if (username !== this.expectedUsername) return { status: 202, statusString: 'ERROR-LOGIN-FAILED', spotifyError: 0, responseSource: 'Spotify Cloud Player' };
    const response = await fetch(this.endpoint, { method: 'POST', body: input, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual', signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new Error('Soloist pairing failed.');
    const text = await response.text(); if (text.length > 65536) throw new Error('Invalid Soloist response.');
    const result = JSON.parse(text);
    if (result.status === 101) {
      for (let i = 0; i < 50 && this.phase !== 'failed'; i++) {
        await this.verifyOwner(); if (this.authentication === 'accepted') break; await wait(100);
      }
      if (this.authentication !== 'accepted') return { status: 202, statusString: 'ERROR-LOGIN-FAILED', spotifyError: 0, responseSource: 'Spotify Cloud Player' };
    }
    return { status: Number.isInteger(result.status) ? result.status : 202, statusString: result.status === 101 ? 'OK' : 'ERROR-LOGIN-FAILED', spotifyError: Number.isInteger(result.spotifyError) ? result.spotifyError : 0, responseSource: 'Spotify Cloud Player' };
  }
  attach(client) {
    if (!this.native || this.phase === 'failed' || this.authentication !== 'accepted' || this.clients.size >= 2) return false;
    this.clients.add(client); client.once('close', () => this.clients.delete(client)); return true;
  }
  closeClients() { for (const client of this.clients) client.destroy(); this.clients.clear(); }
  stop() { return this.serialize(() => this.stopInternal()); }
  async stopInternal() {
    const accepted = this.authentication === 'accepted'; ++this.generation; this.closeClients();
    try { this.socket?.close(); } catch { /* Shutdown also covers an unfinished connection. */ }
    this.socket = null; this.discovery?.close(); this.discovery = null;
    // Native shutdown flushes the stored Connect session before it is copied.
    for (const process of [this.native, this.capture, this.encoder, this.pulse]) await endProcess(process);
    this.native = null; this.capture = null; this.encoder = null; this.pulse = null; this.phase = 'stopped';
    if (accepted && this.dataDir) return captureState(this.dataDir, this.expectedUsername);
    return null;
  }
  async dispose() { await this.stop(); }
}
