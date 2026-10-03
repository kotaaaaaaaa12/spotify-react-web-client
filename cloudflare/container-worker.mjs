import { Container } from '@cloudflare/containers';
import worker from './worker.mjs';
export { PairingSession } from './pairing.mjs';

export class SpotifyPlayerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;
  #operations = Promise.resolve();
  #storage;
  #env;
  constructor(ctx, env) { super(ctx, env); this.#storage = ctx.storage; this.#env = env; }
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
      const browser = await this.#storage.get('browser:config');
      if (action === '/start') {
        const input = await request.clone().json();
        if (input.engine === 'browser') return this.#startBrowser(input, browser);
      }
      if (browser) {
        if (!this.container.running) return Response.json({ version: 5, backend: 'cloud-browser', playerRevision: 'chrome-cloud-1', phase: 'stopped' });
        if (browser.expiresAt <= Date.now()) { await this.destroy(); this.deleteSchedules('refreshBrowserSession'); return Response.json({ phase: 'stopped' }); }
        if (request.headers.has('X-Cloud-Access-Token')) await this.#updateBrowserToken({
          accessToken: request.headers.get('X-Cloud-Access-Token'), tokenExpiresAt: Number(request.headers.get('X-Cloud-Token-Expires')) }, browser);
        // Do not expose internal authorization headers to the stream handler.
        return super.fetch(new Request(request.url, { method: request.method, ...(action === '/control' ? { headers: { 'Content-Type': 'application/json' }, body: request.body, duplex: 'half' } : {}) }));
      }
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
  async #startBrowser(input, old) {
    if (!/^[a-f0-9]{32}$/.test(input.pairingId || '') || input.name !== `Spotify Cloud Player ${input.pairingId.slice(0, 8)}` ||
      typeof input.expectedUsername !== 'string' || !input.expectedUsername || input.expectedUsername.length > 128 || /[\r\n\0]/.test(input.expectedUsername) ||
      !Number.isFinite(input.sessionExpiresAt) || input.sessionExpiresAt <= Date.now()) return Response.json({ error: 'Invalid player configuration.' }, { status: 400 });
    if (old && (old.pairingId !== input.pairingId || old.expectedUsername !== input.expectedUsername)) return Response.json({ error: 'Account does not match this player.' }, { status: 403 });
    if (!old && this.container.running) await this.destroy();
    // OAuth cloud playback replaces the previous native setup completely.
    await this.#clearState(); await this.#storage.delete('soloist:config');
    const config = { name: input.name, expectedUsername: input.expectedUsername, pairingId: input.pairingId, expiresAt: input.sessionExpiresAt };
    await this.#storage.put('browser:config', config); await this.#storage.delete('soloist:bridge');
    const response = await super.fetch(new Request('http://container/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'browser', name: input.name, expectedUsername: input.expectedUsername, accessToken: input.accessToken, tokenExpiresAt: input.tokenExpiresAt }) }));
    if (response.ok) await this.#scheduleRefresh(input.tokenExpiresAt, config.expiresAt);
    return response;
  }
  async #scheduleRefresh(tokenExpiresAt, expiresAt) {
    // Container's own alarm monitors lifecycle and inactivity. Use its scheduler
    // so OAuth renewal cannot replace the platform's ten-minute sleep checks.
    this.deleteSchedules('refreshBrowserSession');
    await this.schedule(new Date(Math.min(expiresAt, Math.max(Date.now() + 5000, tokenExpiresAt - 60000))), 'refreshBrowserSession');
  }
  async #updateBrowserToken(token, config) {
    const response = await super.fetch(new Request('http://container/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token) }));
    if (!response.ok) throw new Error('Player token update failed.');
    await this.#scheduleRefresh(token.tokenExpiresAt, config.expiresAt);
  }
  refreshBrowserSession() {
    return this.#serialize(async () => {
      const config = await this.#storage.get('browser:config');
      if (!config || !this.container.running) { this.deleteSchedules('refreshBrowserSession'); return; }
      if (config.expiresAt <= Date.now()) { await this.destroy(); this.deleteSchedules('refreshBrowserSession'); return; }
      try {
        const response = await this.#env.PAIR_SESSIONS.get(this.#env.PAIR_SESSIONS.idFromName(config.pairingId)).fetch(new Request('https://internal/player_session', { method: 'POST', body: '{}' }));
        if (!response.ok) { if ([400, 401, 410].includes(response.status)) { await this.destroy(); this.deleteSchedules('refreshBrowserSession'); return; } throw new Error('Refresh unavailable.'); }
        const data = await response.json(); if (data.status !== 'ready') { await this.destroy(); this.deleteSchedules('refreshBrowserSession'); return; }
        await this.#updateBrowserToken({ accessToken: data.access_token, tokenExpiresAt: Date.now() + data.expires_in * 1000 }, config);
      } catch { this.deleteSchedules('refreshBrowserSession'); await this.schedule(new Date(Math.min(config.expiresAt, Date.now() + 30000)), 'refreshBrowserSession'); }
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
      this.deleteSchedules?.('refreshBrowserSession');
      if (!this.container.running) return;
      if (await this.#storage?.get('browser:config')) { await super.fetch(new Request('http://container/stop', { method: 'POST' })); await this.destroy(); return; }
      const config = await this.#storage?.get('soloist:config');
      if (config) await this.#seal(config);
      await this.destroy();
    });
  }
  async forgetPlayer() {
    await this.stopPlayer();
    return this.#serialize(async () => { await this.#clearState(); await this.#storage.delete('soloist:config'); await this.#storage.delete('soloist:bridge'); await this.#storage.delete('browser:config'); });
  }
  async onActivityExpired() { await this.stopPlayer(); }
}

async function tokenHash(token) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join(''); }

export default worker;
