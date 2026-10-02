import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.mjs';
import { PairingSession } from '../cloudflare/pairing.mjs';

const origin = 'https://music.example.com';
function namespace() {
  const stores = new Map<string, Map<string, any>>();
  const objects = new Map<string, PairingSession>();
  const alarms = new Map<string, number>();
  return {
    stores, alarms, evict: () => objects.clear(),
    idFromName: (name: string) => name,
    get(id: string) {
      if (!stores.has(id)) stores.set(id, new Map());
      if (!objects.has(id)) {
        const data = stores.get(id)!;
        objects.set(id, new PairingSession({ storage: {
          get: async (key: string) => structuredClone(data.get(key)),
          put: async (key: string, value: any) => { data.set(key, structuredClone(value)); },
          deleteAll: async () => { data.clear(); alarms.delete(id); },
          setAlarm: async (time: number) => { alarms.set(id, time); },
        } }, {}));
      }
      return { fetch: async (request: Request) => {
        const response = await objects.get(id)!.fetch(request);
        // Match Workers fetch responses: the caller cannot mutate DO headers.
        const immutable = new Response(response.body, response);
        for (const method of ['set', 'append', 'delete'] as const) {
          Object.defineProperty(immutable.headers, method, { value: () => { throw new TypeError("Can't modify immutable headers."); } });
        }
        return immutable;
      }, alarm: () => objects.get(id)!.alarm() };
    },
  };
}
let ns: ReturnType<typeof namespace>;
let env: any;
const req = (path: string, method = 'GET', cookie = '', requestOrigin = origin) => worker.fetch(new Request(`${origin}${path}`, {
  method, headers: { ...(method === 'POST' ? { Origin: requestOrigin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
}), env);
const responseCookie = (response: Response) => response.headers.get('Set-Cookie')!.split(';')[0];
async function begin() {
  const response = await req('/api/pair/new', 'POST');
  const data = await response.json();
  return { ...data, cookie: responseCookie(response), id: new URL(data.link).searchParams.get('id')! };
}
async function authorize(pair: any) {
  const response = await req(`/api/pair/authorize?id=${pair.id}`, 'POST');
  const data = await response.json();
  return { cookie: responseCookie(response), url: new URL(data.url) };
}
const finishPath = (phone: any) => `/?code=spotify-code&state=${phone.url.searchParams.get('state')}`;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  ns = namespace();
  env = { SPOTIFY_CLIENT_ID: 'a'.repeat(32), SPOTIFY_REDIRECT_URI: '', PAIR_SESSIONS: ns, ASSETS: { fetch: vi.fn() } };
  vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
    const body = new URLSearchParams(init.body);
    return Response.json({ access_token: body.get('grant_type') === 'refresh_token' ? 'refreshed-access' : 'first-access',
      refresh_token: body.get('grant_type') === 'refresh_token' ? 'rotated-refresh' : 'private-refresh', expires_in: 3600 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Cross-device authorization', () => {
  it('connects two browsers, keeps refresh credentials private, and persists across object eviction', async () => {
    const pair = await begin();
    expect(pair.link).not.toContain(pair.cookie.split('.')[1]);
    expect(pair.code).toMatch(/^\d{8}$/);
    expect((await req('/api/pair/session', 'GET', pair.cookie)).headers.get('Cache-Control')).toBe('no-store');
    const pending = await (await req('/api/pair/session', 'GET', pair.cookie)).json();
    expect(pending.status).toBe('pending');
    expect((await req(`/api/pair/info?id=${pair.id}`)).status).toBe(200);
    const phone = await authorize(pair);
    expect(phone.url.origin).toBe('https://accounts.spotify.com');
    expect(phone.url.searchParams.get('redirect_uri')).toBe(`${origin}/`);
    expect(phone.url.searchParams.get('code_challenge_method')).toBe('S256');
    const result = await req(finishPath(phone), 'GET', phone.cookie);
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('Return to your other device');
    expect(await req('/api/pair/session').then(r => r.status)).toBe(401);
    ns.evict();
    const ready = await (await req('/api/pair/session', 'GET', pair.cookie)).json();
    expect(ready.status).toBe('ready'); expect(ready.access_token).toBe('first-access');
    expect(JSON.stringify(ready)).not.toContain('private-refresh');
    expect(ready).not.toHaveProperty('refresh_token');
    expect(await req(`/api/pair/info?id=${pair.id}`).then(r => r.status)).toBe(410);
    const tokenBody = new URLSearchParams((fetch as any).mock.calls[0][1].body);
    expect(tokenBody.get('client_secret')).toBeNull();
    expect(tokenBody.get('code_verifier')).toHaveLength(64);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenBody.get('code_verifier')!))).toString('base64url');
    expect(phone.url.searchParams.get('code_challenge')).toBe(challenge);
  });
  it('requires a matching phone cookie and OAuth state, and exchanges the callback once', async () => {
    const pair = await begin(), phone = await authorize(pair);
    expect(await req(finishPath(phone)).then(r => r.status)).toBe(400);
    expect(await req(finishPath(phone), 'GET', `${phone.cookie}0`).then(r => r.status)).toBe(400);
    expect(await req(`${finishPath(phone)}wrong`, 'GET', phone.cookie).then(r => r.status)).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    await req(finishPath(phone), 'GET', phone.cookie);
    expect(await req(finishPath(phone), 'GET', phone.cookie).then(r => r.status)).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin mutations and wrong browser secrets', async () => {
    expect(await req('/api/pair/new', 'POST', '', 'https://evil.example.com').then(r => r.status)).toBe(403);
    expect(await req('/api/pair/new', 'POST', '', '').then(r => r.status)).toBe(403);
    const pair = await begin();
    expect(await req('/api/pair/session', 'GET', `__Host-spotify-pair=${pair.id}.${'f'.repeat(64)}`).then(r => r.status)).toBe(401);
    expect(await req('/api/pair/logout', 'POST', pair.cookie, 'https://sibling.example.com').then(r => r.status)).toBe(403);
    expect(await req('/api/pair/refresh', 'GET', pair.cookie).then(r => r.status)).toBe(405);
    expect(await req('/api/pair/create', 'POST').then(r => r.status)).toBe(404);
  });
  it('expires abandoned links and prevents callback exchanges after ten minutes', async () => {
    const pair = await begin(), phone = await authorize(pair);
    vi.setSystemTime(Date.now() + 600001);
    expect(await req(finishPath(phone), 'GET', phone.cookie).then(r => r.status)).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
    expect(await req('/api/pair/session', 'GET', pair.cookie).then(r => r.status)).toBe(410);
  });
  it('supports browsers that omit Origin while rejecting cross-origin custom headers and preflights', async () => {
    const headers = { 'X-Spotify-Device': '1', 'Sec-Fetch-Site': 'same-origin' };
    const send = (requestHeaders: Record<string, string>, method = 'POST') => worker.fetch(new Request(`${origin}/api/pair/new`, { method, headers: requestHeaders }), env);
    expect((await send(headers)).status).toBe(200);
    expect((await send({ ...headers, Origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await send({ ...headers, 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await send({ Origin: 'https://evil.example.com', 'Access-Control-Request-Headers': 'X-Spotify-Device' }, 'OPTIONS')).status).toBe(405);
  });
  it('limits connection creation and uses secure HttpOnly cookies', async () => {
    const first = await req('/api/pair/new', 'POST');
    expect(first.headers.get('Set-Cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(first.headers.get('Set-Cookie')).toContain('Path=/');
    for (let i = 0; i < 11; i++) expect(await req('/api/pair/new', 'POST').then(r => r.status)).toBe(200);
    expect(await req('/api/pair/new', 'POST').then(r => r.status)).toBe(429);
    vi.setSystemTime(Date.now() + 600001);
    expect(await req('/api/pair/new', 'POST').then(r => r.status)).toBe(200);
  });
  it('reports cancellation to the waiting device without retaining a reusable callback', async () => {
    const pair = await begin(), phone = await authorize(pair);
    const path = `/?error=access_denied&state=${phone.url.searchParams.get('state')}`;
    expect(await req(path, 'GET', phone.cookie).then(r => r.status)).toBe(400);
    expect(await req('/api/pair/session', 'GET', pair.cookie).then(r => r.status)).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('revokes the browser session on logout and deletes server credentials', async () => {
    const pair = await begin(), phone = await authorize(pair);
    await req(finishPath(phone), 'GET', phone.cookie);
    const result = await req('/api/pair/logout', 'POST', pair.cookie);
    expect(result.status).toBe(200); expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(ns.stores.get(pair.id)?.size).toBe(0);
    expect(await req('/api/pair/refresh', 'POST', pair.cookie).then(r => r.status)).toBe(410);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refreshes on the Worker, serializes simultaneous refreshes, and preserves rotation', async () => {
    const pair = await begin(), phone = await authorize(pair);
    await req(finishPath(phone), 'GET', phone.cookie);
    vi.setSystemTime(Date.now() + 3600001);
    const responses = await Promise.all([req('/api/pair/refresh', 'POST', pair.cookie), req('/api/pair/refresh', 'POST', pair.cookie)]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const response of responses) expect((await response.json()).access_token).toBe('refreshed-access');
    expect(ns.stores.get(pair.id)!.get('session').refreshToken).toBe('rotated-refresh');
    vi.setSystemTime(Date.now() + 3600001); ns.evict();
    await req('/api/pair/session', 'GET', pair.cookie);
    const body = new URLSearchParams((fetch as any).mock.calls[2][1].body);
    expect(body.get('refresh_token')).toBe('rotated-refresh');
  });
  it('clears revoked credentials and rejects future refreshes', async () => {
    const pair = await begin(), phone = await authorize(pair);
    await req(finishPath(phone), 'GET', phone.cookie);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    expect(await req('/api/pair/refresh', 'POST', pair.cookie).then(r => r.status)).toBe(401);
    expect(ns.stores.get(pair.id)!.size).toBe(0);
    expect(await req('/api/pair/session', 'GET', pair.cookie).then(r => r.status)).toBe(410);
  });
  it('a delayed pairing alarm does not delete a newly authorized session', async () => {
    const pair = await begin(), phone = await authorize(pair);
    await req(finishPath(phone), 'GET', phone.cookie);
    await ns.get(pair.id).alarm();
    expect(await req('/api/pair/session', 'GET', pair.cookie).then(r => r.status)).toBe(200);
    vi.setSystemTime(Date.now() + 30 * 86400000 + 1);
    await ns.get(pair.id).alarm();
    expect(ns.stores.get(pair.id)!.size).toBe(0);
  });
});

describe('Paired Spotify Web API relay', () => {
  async function connected() {
    const pair = await begin(), phone = await authorize(pair);
    await req(finishPath(phone), 'GET', phone.cookie);
    return pair;
  }
  it('allows only the SDK’s exact read-only scope diagnostic with private session authentication', async () => {
    const pair = await connected();
    const upstream = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', upstream);
    const result = await req('/api/spotify/v1/melody/v1/check_scope?scope=web-playback', 'GET', pair.cookie);
    expect(result.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith('https://api.spotify.com/v1/melody/v1/check_scope?scope=web-playback', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer first-access', Accept: 'application/json' } }));
    for (const path of ['/api/spotify/v1/melody/v1/check_scope?scope=other', '/api/spotify/v1/melody/v1/check_scope?scope=web-playback&extra=1', '/api/spotify/v1/melody/v1/license_url']) expect((await req(path, 'GET', pair.cookie)).status).toBe(400);
    const mutation = await worker.fetch(new Request(`${origin}/api/spotify/v1/melody/v1/check_scope?scope=web-playback`, { method: 'PUT', headers: { Origin: origin, Cookie: pair.cookie } }), env);
    expect(mutation.status).toBe(400); expect(upstream).toHaveBeenCalledTimes(1);
    expect((await req('/api/spotify/v1/melody/v1/check_scope?scope=web-playback')).status).toBe(401);
  });
  it('uses the server-held account token and preserves query parameters', async () => {
    const pair = await connected();
    const upstream = vi.fn(async () => Response.json({ id: 'account' }));
    vi.stubGlobal('fetch', upstream);
    const result = await worker.fetch(new Request(`${origin}/api/spotify/v1/me/following?type=artist&after=abc`, {
      headers: { Cookie: pair.cookie, Authorization: 'Bearer attacker-token' },
    }), env);
    expect(await result.json()).toEqual({ id: 'account' });
    expect(upstream).toHaveBeenCalledWith('https://api.spotify.com/v1/me/following?type=artist&after=abc', expect.objectContaining({
      method: 'GET', redirect: 'manual', headers: { Authorization: 'Bearer first-access', Accept: 'application/json' },
    }));
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rejects unauthenticated callers, unsupported paths, and unsupported methods', async () => {
    expect((await req('/api/spotify/v1/me')).status).toBe(401);
    expect((await req('/api/spotify/v1/https/evil')).status).toBe(400);
    expect((await req('/api/spotify/v1/me', 'OPTIONS')).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutations and private cookies from another browser', async () => {
    const pair = await connected(); vi.mocked(fetch).mockClear();
    expect((await req('/api/spotify/v1/me/player/play', 'PUT', pair.cookie)).status).toBe(403);
    const response = await worker.fetch(new Request(`${origin}/api/spotify/v1/me/player/play`, {
      method: 'PUT', headers: { Origin: 'https://evil.example.com', Cookie: pair.cookie, 'X-Spotify-Device': '1' },
    }), env);
    expect(response.status).toBe(403);
    expect((await req('/api/spotify/v1/me', 'GET', `__Host-spotify-pair=${pair.id}.${'f'.repeat(64)}`)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('forwards JSON mutations and preserves empty Spotify player responses', async () => {
    const pair = await connected();
    const upstream = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(new Request(`${origin}/api/spotify/v1/me/player/play`, {
      method: 'PUT', headers: { Origin: origin, Cookie: pair.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: ['spotify:track:123'] }),
    }), env);
    expect(response.status).toBe(204); expect(await response.text()).toBe('');
    const init = upstream.mock.calls[0][1] as any;
    expect(JSON.parse(new TextDecoder().decode(init.body))).toEqual({ uris: ['spotify:track:123'] });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Cookie).toBeUndefined();
  });
  it('preserves API errors and rate-limit headers while excluding upstream cookies', async () => {
    const pair = await connected();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Slow down' } }, { status: 429, headers: { 'Retry-After': '4', 'Set-Cookie': 'external=private' } })));
    const result = await req('/api/spotify/v1/me', 'GET', pair.cookie);
    expect(result.status).toBe(429); expect(result.headers.get('Retry-After')).toBe('4');
    expect(result.headers.has('Set-Cookie')).toBe(false);
    expect(await result.json()).toEqual({ error: { message: 'Slow down' } });
  });
  it('does not follow Spotify redirects and gives a distinct server network error', async () => {
    const pair = await connected();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com' } })));
    expect((await req('/api/spotify/v1/me', 'GET', pair.cookie)).status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network error'); }));
    const response = await req('/api/spotify/v1/me', 'GET', pair.cookie);
    expect(response.status).toBe(502); expect((await response.json()).error.message).toContain('server could not reach Spotify Web API');
  });
  it('clears expired private sessions and refuses API access until phone authorization finishes', async () => {
    const pair = await begin();
    expect((await req('/api/spotify/v1/me', 'GET', pair.cookie)).status).toBe(409);
    vi.setSystemTime(Date.now() + 600001);
    const expired = await req('/api/spotify/v1/me', 'GET', pair.cookie);
    expect(expired.status).toBe(410); expect(expired.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds uploaded payloads and rejects unsupported content types', async () => {
    const pair = await connected(); vi.mocked(fetch).mockClear();
    for (const [contentType, body, status] of [['text/html', 'html', 415], ['image/jpeg', 'x'.repeat(4 * 1024 * 1024 + 1), 413]] as const) {
      const result = await worker.fetch(new Request(`${origin}/api/spotify/v1/playlists/id/images`, {
        method: 'PUT', headers: { Origin: origin, Cookie: pair.cookie, 'Content-Type': contentType }, body,
      }), env);
      expect(result.status).toBe(status);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
