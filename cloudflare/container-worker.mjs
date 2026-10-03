import { Container } from '@cloudflare/containers';
import worker from './worker.mjs';
export { PairingSession } from './pairing.mjs';

export class SpotifyPlayerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;
  #operations = Promise.resolve();
  #storage;
  constructor(ctx, env) { super(ctx, env); this.#storage = ctx.storage; }
  #serialize(operation) {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }
  fetch(request) {
    // Only wait for response headers; streaming bodies remain concurrent.
    return this.#serialize(async () => {
      if (!this.#storage) return super.fetch(request);
      const action = new URL(request.url).pathname;
      const config = await this.#storage.get('soloist:config');
      if (!config?.apiKey || config.expiresAt <= Date.now()) return Response.json({ version: 4, backend: 'soloist', playerRevision: 'soloist-cloud-1',
        phase: 'setup_required', authentication: 'pending', audio: 'pending', pcmBytes: 0, audioBytes: 0, keyConfigured: false });
      if (action === '/start') {
        const input = await request.json();
        if (config.expectedUsername !== input.expectedUsername || config.name !== input.name) return Response.json({ error: 'Account does not match stored settings.' }, { status: 403 });
        await this.#storage.delete('soloist:bridge');
        return this.#start(config);
      }
      if (!this.container.running) return Response.json({ version: 4, backend: 'soloist', playerRevision: 'soloist-cloud-1', phase: 'stopped', keyConfigured: true, sessionStored: !!await this.#storage.get('soloist:manifest') });
      const response = await super.fetch(request);
      if (action !== '/status' || !response.ok) return response;
      return Response.json({ ...await response.json(), keyConfigured: true, sessionStored: !!await this.#storage.get('soloist:manifest') });
    });
  }
  async #start(config) {
    const manifest = await this.#storage.get('soloist:manifest'); let checkpoint;
    if (manifest?.owner === config.expectedUsername) {
      const parts = [];
      for (let i = 0; i < manifest.count; i++) { const part = await this.#storage.get(`soloist:state:${i}`); if (typeof part !== 'string') throw new Error('Stored session is incomplete.'); parts.push(part); }
      checkpoint = parts.join('');
    }
    const response = await super.fetch(new Request('http://container/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: config.name, expectedUsername: config.expectedUsername, engine: 'soloist', apiKey: config.apiKey, checkpoint }) }));
    if (!response.ok) return response;
    return Response.json({ ...await response.json(), keyConfigured: true, sessionStored: !!manifest });
  }
  async #seal(config, required = false) {
    const response = await super.fetch(new Request('http://container/stop', { method: 'POST' }));
    if (!response.ok) throw new Error('Session could not be saved.');
    const { checkpoint } = await response.json();
    if (!checkpoint) { if (required) throw new Error('Authenticated session was not saved.'); return; }
    if (typeof checkpoint !== 'string' || checkpoint.length > 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(checkpoint)) throw new Error('Invalid session checkpoint.');
    const parts = []; for (let i = 0; i < checkpoint.length; i += 60000) parts.push(checkpoint.slice(i, i + 60000));
    await this.#storage.transaction(async storage => {
      const old = await storage.get('soloist:manifest');
      for (let i = 0; i < parts.length; i++) await storage.put(`soloist:state:${i}`, parts[i]);
      for (let i = parts.length; i < (old?.count || 0); i++) await storage.delete(`soloist:state:${i}`);
      await storage.put('soloist:manifest', { count: parts.length, owner: config.expectedUsername });
    });
  }
  settings() {
    return this.#serialize(async () => {
      const config = await this.#storage.get('soloist:config');
      return { backend: 'soloist', keyConfigured: !!config?.apiKey && config.expiresAt > Date.now(), sessionStored: !!await this.#storage.get('soloist:manifest') };
    });
  }
  configureSoloist(config) {
    return this.#serialize(async () => {
      if (typeof config.apiKey !== 'string' || !config.apiKey || config.apiKey.length > 4096 || /\s|\0/.test(config.apiKey) ||
        typeof config.expectedUsername !== 'string' || !config.expectedUsername || config.expectedUsername.length > 128 || /[\r\n\0]/.test(config.expectedUsername) ||
        !/^Spotify Cloud Player [a-f0-9]{8}$/.test(config.name || '') || !Number.isFinite(config.expiresAt) || config.expiresAt <= Date.now()) throw new Error('Invalid configuration.');
      const old = await this.#storage.get('soloist:config');
      if (this.container.running) { if (old) await this.#seal(old); await this.destroy(); }
      if (old && old.expectedUsername !== config.expectedUsername) await this.#clearState();
      await this.#storage.put('soloist:config', config); await this.#storage.delete('soloist:bridge');
      return { backend: 'soloist', keyConfigured: true, sessionStored: !!await this.#storage.get('soloist:manifest') };
    });
  }
  createSoloistBridge() {
    return this.#serialize(async () => {
      const config = await this.#storage.get('soloist:config');
      if (!config?.apiKey || config.expiresAt <= Date.now() || !this.container.running) throw new Error('Start Soloist before pairing.');
      const status = await (await super.fetch(new Request('http://container/status'))).json();
      if (status.phase !== 'waiting_for_pairing' || status.discovery !== 'accepted') throw new Error('Soloist is not ready for pairing.');
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const expiresAt = Math.min(Date.now() + 20 * 60 * 1000, config.expiresAt);
      const hash = await tokenHash(token);
      await this.#storage.put('soloist:bridge', { hash, expiresAt, reads: 0, writes: 0 });
      return { token, expiresAt };
    });
  }
  soloistBridge({ token, action, form }) {
    return this.#serialize(async () => {
      const bridge = await this.#storage.get('soloist:bridge');
      const config = await this.#storage.get('soloist:config');
      if (!/^[a-f0-9]{64}$/.test(token || '') || !bridge || bridge.expiresAt <= Date.now() || bridge.hash !== await tokenHash(token) || !config || config.expiresAt <= Date.now()) return Response.json({ error: 'Pairing link expired or is invalid.' }, { status: 401 });
      if (!this.container.running) return Response.json({ error: 'Soloist is not running.' }, { status: 409 });
      if (action !== 'getInfo' && action !== 'addUser') return Response.json({ error: 'Invalid pairing action.' }, { status: 400 });
      if (action === 'getInfo') {
        if (++bridge.reads > 240) return Response.json({ error: 'Pairing request limit reached.' }, { status: 429 });
        await this.#storage.put('soloist:bridge', bridge);
        return super.fetch(new Request('http://container/zeroconf/getInfo'));
      }
      if (++bridge.writes > 6) return Response.json({ error: 'Pairing request limit reached.' }, { status: 429 });
      await this.#storage.put('soloist:bridge', bridge);
      if (typeof form !== 'string' || form.length > 16384) return Response.json({ error: 'Invalid pairing request.' }, { status: 400 });
      const input = new URLSearchParams(form); let username;
      try { username = decodeURIComponent(input.get('userName') || ''); } catch { username = ''; }
      if (username !== config.expectedUsername) return Response.json({ status: 202, statusString: 'ERROR-LOGIN-FAILED', spotifyError: 0, responseSource: 'Spotify Cloud Player' });
      // The received encrypted blob is forwarded once and is never stored.
      const response = await super.fetch(new Request('http://container/zeroconf/addUser', { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
      if (!response.ok) return Response.json({ error: 'Soloist pairing failed.' }, { status: 502 });
      const result = await response.json();
      if (result.status === 101) {
        await this.#seal(config, true); await this.#storage.delete('soloist:bridge');
        const restarted = await this.#start(config);
        if (!restarted.ok) throw new Error('Soloist restart failed.');
      }
      return Response.json({ status: Number.isInteger(result.status) ? result.status : 202, statusString: result.status === 101 ? 'OK' : 'ERROR-LOGIN-FAILED',
        spotifyError: Number.isInteger(result.spotifyError) ? result.spotifyError : 0, responseSource: 'Spotify Cloud Player' });
    });
  }
  async #clearState() {
    const manifest = await this.#storage.get('soloist:manifest');
    for (let i = 0; i < (manifest?.count || 0); i++) await this.#storage.delete(`soloist:state:${i}`);
    await this.#storage.delete('soloist:manifest');
  }
  async stopPlayer() {
    // Stopping an unused session must not provision a Container.
    return this.#serialize(async () => {
      if (this.#storage) await this.#storage.delete('soloist:bridge');
      if (!this.container.running) return;
      const config = await this.#storage?.get('soloist:config');
      if (config) await this.#seal(config);
      await this.destroy();
    });
  }
  async forgetPlayer() {
    await this.stopPlayer();
    return this.#serialize(async () => { await this.#clearState(); await this.#storage.delete('soloist:config'); await this.#storage.delete('soloist:bridge'); });
  }
  async onActivityExpired() { await this.stopPlayer(); }
}

async function tokenHash(token) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join(''); }

export default worker;
