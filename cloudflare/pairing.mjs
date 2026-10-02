const PAIR_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = '__Host-spotify-pair';
const PHONE_COOKIE = '__Host-spotify-phone';
const scopes = 'ugc-image-upload streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-modify-public playlist-modify-private playlist-read-collaborative user-follow-modify user-follow-read user-read-playback-position user-top-read user-read-recently-played user-library-read user-library-modify';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const json = (data, status = 200) => Response.json(data, { status, headers });
const random = (length = 32) => Array.from(crypto.getRandomValues(new Uint8Array(length)), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const validId = id => /^[a-f0-9]{32}$/.test(id || '');
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const readCookie = (request, name) => (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const stub = (env, id) => env.PAIR_SESSIONS.get(env.PAIR_SESSIONS.idFromName(id));
async function call(env, id, action, data = {}) {
  const response = await stub(env, id).fetch(new Request(`https://internal/${action}`, { method: 'POST', body: JSON.stringify(data) }));
  // Responses crossing a Durable Object boundary have immutable headers.
  // Copy the response before attaching or clearing browser cookies.
  return new Response(response.body, response);
}
function page(message, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spotify device connection</title><style>body{background:#121212;color:#fff;font:18px system-ui;margin:12vh auto;padding:24px;max-width:520px}h1{font-size:28px}a{color:#1ed760}</style><h1>Spotify device connection</h1><p>${message}</p></html>`, {
    status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
  });
}

// This handler only exposes specific operations; callers cannot access internal DO routes.
export async function handlePairing(request, env, config) {
  const url = new URL(request.url);
  const isCallback = url.pathname === '/' && (url.searchParams.get('state') || '').startsWith('pair_');
  if (!url.pathname.startsWith('/api/pair/') && !isCallback) return null;
  if (!env.PAIR_SESSIONS) return json({ error: 'Device connections are unavailable. Apply the Durable Objects binding and redeploy.' }, 503);
  if (isCallback) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const state = url.searchParams.get('state') || '';
    const id = state.split('_')[1];
    if (!validId(id)) return page('This connection could not be verified. Start again on your other device.', 400);
    const phone = readCookie(request, PHONE_COOKIE);
    const [phoneId, secret] = phone.split('.');
    if (phoneId !== id || !/^[a-f0-9]{64}$/.test(secret || '')) return page('This connection could not be verified. Start again on your other device.', 400);
    const result = await call(env, id, 'finish', { state, secret, code: url.searchParams.get('code'), error: url.searchParams.get('error') });
    const response = result.ok ? page('Connected. Return to your other device to finish. You can close this tab.') : page('The connection failed or expired. Start a new connection on your other device.', result.status);
    response.headers.set('Set-Cookie', cookie(PHONE_COOKIE, '', 0));
    return response;
  }
  const path = url.pathname.slice('/api/pair/'.length);
  const methods = { new: 'POST', info: 'GET', authorize: 'POST', session: 'GET', refresh: 'POST', logout: 'POST' };
  if (!methods[path]) return json({ error: 'Not found.' }, 404);
  if (request.method !== methods[path]) return json({ error: 'Method not allowed.' }, 405);
  // SameSite alone is insufficient for sibling domains. Missing Origin is allowed
  // only with a custom header, which cross-origin scripts cannot send without a
  // successful CORS preflight. This Worker does not allow CORS preflights.
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    if ((origin && origin !== url.origin) || (!origin && (request.headers.get('X-Spotify-Device') !== '1' || (site && site !== 'same-origin')))) {
      return json({ error: 'Request origin could not be verified.' }, 403);
    }
  }
  if (!config?.clientId) return json({ error: 'A Spotify Client ID is required.' }, 503);
  if (path === 'new') {
    const rateId = `rate:${await digest(request.headers.get('CF-Connecting-IP') || 'local')}`;
    const rate = await call(env, rateId, 'limit');
    if (!rate.ok) return rate;
    const id = random(16), secret = random();
    const response = await call(env, id, 'create', { secret, clientId: config.clientId, redirectUri: config.redirectUri });
    const data = await response.json();
    if (!response.ok) return json(data, response.status);
    const result = json({ ...data, link: `${url.origin}/pair?id=${id}` });
    result.headers.set('Set-Cookie', cookie(SESSION_COOKIE, `${id}.${secret}`, SESSION_TTL / 1000));
    return result;
  }
  if (path === 'info' || path === 'authorize') {
    const id = url.searchParams.get('id');
    if (!validId(id)) return json({ error: 'Invalid connection link.' }, 400);
    if (path === 'info') return call(env, id, 'info');
    const secret = random();
    const response = await call(env, id, 'authorize', { id, secret });
    if (response.ok) response.headers.set('Set-Cookie', cookie(PHONE_COOKIE, `${id}.${secret}`, PAIR_TTL / 1000));
    return response;
  }
  const [id, secret] = readCookie(request, SESSION_COOKIE).split('.');
  if (!validId(id) || !/^[a-f0-9]{64}$/.test(secret || '')) return json({ error: 'No device session. Connect again.' }, 401);
  const response = await call(env, id, path, { secret });
  if (path === 'logout' || response.status === 401 || response.status === 410) response.headers.set('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
  return response;
}

export class PairingSession {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.queue = Promise.resolve(); }
  fetch(request) {
    // Serialize exchanges and refreshes, including network I/O and token rotation.
    const result = this.queue.then(() => this.handle(request));
    this.queue = result.catch(() => {});
    return result.catch(() => json({ error: 'Unable to connect to Spotify. Please try again.' }, 502));
  }
  alarm() {
    const result = this.queue.then(async () => {
      const record = await this.ctx.storage.get('session') || await this.ctx.storage.get('rate');
      const expiry = record?.expiresAt || record?.until;
      if (expiry > Date.now()) await this.ctx.storage.setAlarm(expiry);
      else await this.ctx.storage.deleteAll();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async save(session) {
    await this.ctx.storage.put('session', session);
    await this.ctx.storage.setAlarm(session.expiresAt);
  }
  async exchange(body) {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(10000),
    });
    let token;
    try { token = await response.json(); } catch { return { error: true, status: 502 }; }
    if (!response.ok || typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) return { error: true, status: response.status === 400 || response.status === 401 ? 401 : 502 };
    return { accessToken: token.access_token, refreshToken: token.refresh_token, tokenExpiresAt: Date.now() + token.expires_in * 1000 };
  }
  async handle(request) {
    const action = new URL(request.url).pathname.slice(1);
    const input = await request.json();
    const now = Date.now();
    if (action === 'limit') {
      let rate = await this.ctx.storage.get('rate');
      if (!rate || rate.until <= now) rate = { count: 0, until: now + PAIR_TTL };
      if (++rate.count > 12) return json({ error: 'Too many connection attempts. Try again in ten minutes.' }, 429);
      await this.ctx.storage.put('rate', rate);
      await this.ctx.storage.setAlarm(rate.until);
      return json({ ok: true });
    }
    let session = await this.ctx.storage.get('session');
    if (action === 'create') {
      if (session) return json({ error: 'Connection already exists.' }, 409);
      const bytes = crypto.getRandomValues(new Uint32Array(1));
      session = { ownerHash: await digest(input.secret), clientId: input.clientId, redirectUri: input.redirectUri,
        code: String(bytes[0] % 100000000).padStart(8, '0'), status: 'pending', expiresAt: now + PAIR_TTL };
      await this.save(session);
      return json({ code: session.code, expiresAt: session.expiresAt });
    }
    if (!session || session.expiresAt <= now) {
      await this.ctx.storage.deleteAll();
      return json({ error: 'This connection expired. Create a new connection.' }, 410);
    }
    if (action === 'info') return session.status === 'pending' ? json({ code: session.code, expiresAt: session.expiresAt }) : json({ error: 'This connection is no longer available.' }, 410);
    if (action === 'authorize') {
      if (session.status !== 'pending' || session.oauth) return json({ error: 'This connection is already in progress. Start a new connection if needed.' }, 409);
      const verifier = random();
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const challenge = btoa(String.fromCharCode(...hash)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const state = `pair_${input.id}_${random(24)}`;
      session.oauth = { verifier, state, phoneHash: await digest(input.secret) };
      await this.save(session);
      const url = new URL('https://accounts.spotify.com/authorize');
      url.search = new URLSearchParams({ client_id: session.clientId, response_type: 'code', redirect_uri: session.redirectUri,
        scope: scopes, state, code_challenge_method: 'S256', code_challenge: challenge, show_dialog: 'true' }).toString();
      return json({ url: url.href });
    }
    if (action === 'finish') {
      if (session.status !== 'pending' || !session.oauth || session.oauth.state !== input.state || session.oauth.phoneHash !== await digest(input.secret)) return json({ error: 'Unverified connection.' }, 400);
      const verifier = session.oauth.verifier;
      delete session.oauth;
      session.status = 'failed';
      // Persist single-use state before exchanging the authorization code.
      await this.save(session);
      if (input.error || typeof input.code !== 'string' || !input.code || input.code.length > 4096) return json({ error: 'Spotify authorization was cancelled.' }, 400);
      const token = await this.exchange({ client_id: session.clientId, redirect_uri: session.redirectUri,
        grant_type: 'authorization_code', code: input.code, code_verifier: verifier });
      if (token.error || typeof token.refreshToken !== 'string' || !token.refreshToken) return json({ error: 'Spotify authorization failed. Start again.' }, token.status || 502);
      Object.assign(session, token, { status: 'ready', expiresAt: now + SESSION_TTL });
      await this.save(session);
      return json({ ok: true });
    }
    if (!['session', 'refresh', 'logout'].includes(action)) return json({ error: 'Not found.' }, 404);
    if (session.ownerHash !== await digest(input.secret || '')) return json({ error: 'Unauthorized session.' }, 401);
    if (action === 'logout') { await this.ctx.storage.deleteAll(); return json({ ok: true }); }
    if (session.status === 'failed') return json({ error: 'Spotify connection failed. Start a new connection.' }, 400);
    if (session.status !== 'ready') return json({ status: 'pending', code: session.code, expiresAt: session.expiresAt });
    if (session.tokenExpiresAt <= now + 60000 || (action === 'refresh' && (!session.lastRefresh || now - session.lastRefresh >= 30000))) {
      const token = await this.exchange({ client_id: session.clientId, grant_type: 'refresh_token', refresh_token: session.refreshToken });
      if (token.error) {
        if (token.status === 401) await this.ctx.storage.deleteAll();
        return json({ error: 'Spotify session could not be refreshed. Connect again if access was revoked.' }, token.status);
      }
      session.accessToken = token.accessToken;
      session.tokenExpiresAt = token.tokenExpiresAt;
      if (token.refreshToken) session.refreshToken = token.refreshToken;
      session.lastRefresh = now;
      await this.save(session);
    }
    // Refresh tokens and both browser secrets are never returned to the frontend.
    return json({ status: 'ready', access_token: session.accessToken, expires_in: Math.max(1, Math.floor((session.tokenExpiresAt - Date.now()) / 1000)), sessionExpiresAt: session.expiresAt });
  }
}
