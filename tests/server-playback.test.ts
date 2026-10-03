import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.mjs';
import { PairingSession } from '../cloudflare/pairing.mjs';
import { serverPlaybackState } from '../src/utils/spotify/serverPlayback';
import { activateBrowserAudio, setBrowserPlayer, setServerAudio } from '../src/utils/spotify/browserAudio';

const origin = 'https://music.example.com';
let env: any, records: Map<string, Map<string, any>>, containers: Map<string, any>;
const report = { phase: 'waiting_for_playback', authentication: 'accepted', audio: 'pending', pcmBytes: 0, audioBytes: 0, errorCode: null };
function request(path: string, cookie = '', method = 'GET', extra: Record<string, string> = {}) {
  return worker.fetch(new Request(origin + path, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(method === 'POST' ? { Origin: origin } : {}), ...extra,
  } }), env);
}
async function connection(ready = true) {
  const response = await request('/api/pair/new', '', 'POST');
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const id = new URL((await response.json()).link).searchParams.get('id')!;
  if (ready) {
    const phone = await request(`/api/pair/authorize?id=${id}`, '', 'POST');
    const state = new URL((await phone.json()).url).searchParams.get('state');
    await request(`/?code=code&state=${state}`, phone.headers.get('Set-Cookie')!.split(';')[0]);
  }
  return { id, cookie };
}
beforeEach(() => {
  records = new Map(); containers = new Map();
  const objects = new Map();
  env = { SPOTIFY_CLIENT_ID: 'a'.repeat(32), ASSETS: { fetch: vi.fn() }, PAIR_SESSIONS: {
    idFromName: (id: string) => id, get(id: string) {
      if (!records.has(id)) records.set(id, new Map());
      const storage = records.get(id)!;
      if (!objects.has(id)) objects.set(id, new PairingSession({ storage: {
        get: async (key: string) => structuredClone(storage.get(key)),
        put: async (key: string, value: any) => storage.set(key, structuredClone(value)),
        deleteAll: async () => storage.clear(), setAlarm: async () => {},
      } }, {}));
      return { fetch: (request: Request) => objects.get(id).fetch(request) };
    },
  }, SERVER_PLAYERS: { idFromName: (id: string) => id, get: vi.fn((id: string) => {
    if (!containers.has(id)) containers.set(id, { fetch: vi.fn(async () => Response.json(report)), stopPlayer: vi.fn(async () => {}) });
    return containers.get(id);
  }) } };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === 'https://api.spotify.com/v1/me' ? Response.json({ id: 'linked-user' }) : Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 })));
});
afterEach(() => { vi.unstubAllGlobals(); setServerAudio(null); setBrowserPlayer(null); });

describe('Authenticated server playback', () => {
  it('denies missing, pending, and wrong-secret sessions without provisioning a player', async () => {
    expect((await request('/api/server/start', '', 'POST', { Authorization: 'Bearer fake' })).status).toBe(401);
    const pair = await connection(false);
    expect((await request('/api/server/start', pair.cookie, 'POST')).status).toBe(409);
    expect((await request('/api/server/stream', `__Host-spotify-pair=${pair.id}.${'f'.repeat(64)}`)).status).toBe(401);
    expect(env.SERVER_PLAYERS.get).not.toHaveBeenCalled();
  });
  it('starts an isolated APAC player with only server credentials and returns a redacted report', async () => {
    const pair = await connection();
    const result = await request('/api/server/start', pair.cookie, 'POST', { Authorization: 'Bearer attacker' });
    const id = `spotify-player-v1:${pair.id}`, stub = containers.get(id);
    expect(env.SERVER_PLAYERS.get).toHaveBeenCalledWith(id, { locationHint: 'apac' });
    const internal = stub.fetch.mock.calls[0][0];
    expect(internal.url).toBe('http://container/start');
    expect(await internal.json()).toEqual({ expectedUsername: 'linked-user', name: `Spotify Cloud Player ${pair.id.slice(0, 8)}` });
    expect(internal.headers.has('Cookie')).toBe(false); expect(internal.headers.has('Authorization')).toBe(false);
    const body = await result.json(); expect(body.authentication).toBe('accepted'); expect(body.version).toBe(3);
    expect(JSON.stringify(body)).not.toContain('private-'); expect(result.headers.get('Cache-Control')).toBe('no-store');
    const other = await connection(); await request('/api/server/start', other.cookie, 'POST');
    expect(containers.size).toBe(2);
  });
  it('returns only fixed Spotify pairing links to the authenticated receiving session', async () => {
    const pair = await connection(); await request('/api/server/start', pair.cookie, 'POST');
    const stub = containers.get(`spotify-player-v1:${pair.id}`);
    stub.fetch.mockImplementation(async () => Response.json({ ...report, phase: 'waiting_for_pairing', authentication: 'pending', playerRevision: 'native-device-auth-1', authenticationMode: 'device', pairing: { url: 'https://spotify.com/pair?code=ABC123', code: 'ABC123', device_code: 'private-secret' } }));
    const result = await (await request('/api/server/status', pair.cookie)).json();
    expect(result).toMatchObject({ version: 3, playerRevision: 'native-device-auth-1', authenticationMode: 'device', pairing: { url: 'https://spotify.com/pair?code=ABC123', code: 'ABC123' } });
    expect(JSON.stringify(result)).not.toContain('private-secret');
    stub.fetch.mockImplementation(async () => Response.json({ ...report, phase: 'waiting_for_pairing', pairing: { url: 'https://evil.example/pair?code=ABC123', code: 'ABC123' } }));
    expect((await (await request('/api/server/status', pair.cookie)).json()).pairing).toBeUndefined();
    const denied = await request('/api/server/status'); expect(denied.status).toBe(401); expect(await denied.text()).not.toContain('ABC123');
  });
  it('does not provision native playback when the linked account cannot be verified', async () => {
    const pair = await connection();
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 401 }));
    expect((await request('/api/server/start', pair.cookie, 'POST')).status).toBe(502);
    expect(env.SERVER_PLAYERS.get).not.toHaveBeenCalled();
  });
  it('distinguishes account and Container exceptions without logging their private contents', async () => {
    const pair = await connection(); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(fetch).mockImplementation(async () => { throw Error('private-account-token'); });
      const account = await (await request('/api/server/start', pair.cookie, 'POST')).json();
      expect(account).toMatchObject({ errorCode: 'server_account_request_failed', startup: { revision: 'server-startup-1', stage: 'account', httpStatus: 503 } });
      expect(env.SERVER_PLAYERS.get).not.toHaveBeenCalled();
      vi.mocked(fetch).mockImplementation(async () => Response.json({ id: 'linked-user' }));
      env.SERVER_PLAYERS.get.mockImplementation(() => { throw Error('private-container-id'); });
      const container = await (await request('/api/server/start', pair.cookie, 'POST')).json();
      expect(container).toMatchObject({ errorCode: 'server_container_request_failed', startup: { stage: 'container_start' } });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-account-token|private-container-id/);
    } finally { log.mockRestore(); }
  });
  it('checks mutation origin and methods before consulting account sessions', async () => {
    const pair = await connection();
    expect((await request('/api/server/start', pair.cookie, 'POST', { Origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await request('/api/server/stop', pair.cookie, 'POST', { Origin: '', 'X-Spotify-Device': '1', 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await request('/api/server/start', pair.cookie)).status).toBe(405);
    expect((await request('/api/server/stream', pair.cookie, 'OPTIONS')).status).toBe(405);
    expect((await request('/api/server/unknown', pair.cookie)).status).toBe(404);
    expect(env.SERVER_PLAYERS.get).not.toHaveBeenCalled();
    expect((await request('/api/server/start', pair.cookie, 'POST', { Origin: '', 'X-Spotify-Device': '1', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });
  it('streams MP3 on the site origin with no credential headers or public cache', async () => {
    const pair = await connection(); await request('/api/server/start', pair.cookie, 'POST');
    const stub = containers.get(`spotify-player-v1:${pair.id}`);
    stub.fetch.mockImplementation(async () => new Response(new Uint8Array([255, 251, 1, 2]), { headers: { 'Set-Cookie': 'private=secret' } }));
    const result = await request('/api/server/stream?t=1', pair.cookie);
    expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([255, 251, 1, 2]);
    expect(result.headers.get('Content-Type')).toBe('audio/mpeg'); expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.has('Set-Cookie')).toBe(false);
  });
  it('sanitizes Container errors and prevents leaking extra process fields', async () => {
    const pair = await connection(); await request('/api/server/start', pair.cookie, 'POST');
    const stub = containers.get(`spotify-player-v1:${pair.id}`);
    stub.fetch.mockImplementation(async () => Response.json({ ...report, token: 'private-access', stderr: 'private log' }));
    expect(await (await request('/api/server/status', pair.cookie)).text()).not.toContain('private');
    stub.fetch.mockImplementation(async () => new Response('private-access', { status: 429 }));
    const limited = await request('/api/server/status', pair.cookie); expect(limited.status).toBe(429); expect(await limited.text()).not.toContain('private-access');
    stub.fetch.mockImplementation(async () => { throw Error('private-access'); });
    const failed = await request('/api/server/status', pair.cookie); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private-access');
  });
  it('returns a safe retryable response if session storage is temporarily unavailable', async () => {
    const pair = await connection();
    env.PAIR_SESSIONS.get = () => ({ fetch: async () => { throw Error('private storage credentials'); } });
    const result = await request('/api/server/start', pair.cookie, 'POST');
    expect(result.status).toBe(503); expect(await result.text()).not.toContain('private storage');
    expect(env.SERVER_PLAYERS.get).not.toHaveBeenCalled();
  });
  it('forwards only recognized native evidence through the private report route', async () => {
    const pair = await connection(); await request('/api/server/start', pair.cookie, 'POST');
    containers.get(`spotify-player-v1:${pair.id}`).fetch.mockImplementation(async () => Response.json({ ...report,
      diagnostics: { revision: 'native-diagnostics-2', nativeExit: { code: 1, signal: null, token: 'private-token' },
        events: [{ event: 'connect_initialization_failed', errorKind: 'Unavailable', reason: 'invalid_credentials', stderr: 'private-token' }] } }));
    const result = await (await request('/api/server/status', pair.cookie)).json();
    expect(result.version).toBe(3); expect(result.diagnostics.events[0]).toEqual({ event: 'connect_initialization_failed', errorKind: 'Unavailable', reason: 'invalid_credentials' });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
  it('stops only the owned session, and stops its runtime before removing credentials on logout', async () => {
    const pair = await connection();
    expect((await request('/api/server/stop', pair.cookie, 'POST')).status).toBe(200);
    const stub = containers.get(`spotify-player-v1:${pair.id}`);
    expect(stub.stopPlayer).toHaveBeenCalledOnce(); expect(stub.fetch).not.toHaveBeenCalled();
    expect((await request('/api/pair/logout', `__Host-spotify-pair=${pair.id}.${'f'.repeat(64)}`, 'POST')).status).toBe(401);
    expect(stub.stopPlayer).toHaveBeenCalledOnce();
    stub.stopPlayer.mockImplementation(async () => { throw Error('Stop failed'); });
    expect((await request('/api/pair/logout', pair.cookie, 'POST')).status).toBe(503);
    expect((await request('/api/pair/session', pair.cookie)).status).toBe(200);
    stub.stopPlayer.mockImplementation(async () => { expect(records.get(pair.id)!.has('session')).toBe(true); });
    expect((await request('/api/pair/logout', pair.cookie, 'POST')).status).toBe(200);
    expect(records.get(pair.id)!.size).toBe(0);
    expect((await request('/api/server/stream', pair.cookie)).status).toBe(410);
  });
});
describe('Server playback controls', () => {
  it('adapts only the selected server device and preserves transport state', () => {
    const data = { item: { id: 'track', duration_ms: 5000, album: { images: [] }, artists: [] }, device: { id: 'server' },
      is_playing: true, progress_ms: 400, repeat_state: 'track', shuffle_state: true };
    expect(serverPlaybackState(data, 'other')).toBeNull(); expect(serverPlaybackState({}, 'server')).toBeNull();
    expect(serverPlaybackState(data, 'server')).toMatchObject({ paused: false, position: 400, duration: 5000, repeat_mode: 2, shuffle: true });
  });
  it('does not deadlock Spotify play commands while audio is waiting for its first bytes', async () => {
    const play = vi.fn(() => new Promise(() => {}));
    const sdk = { activateElement: vi.fn() }; setBrowserPlayer(sdk as any); setServerAudio({ play } as any);
    await activateBrowserAudio(); expect(play).toHaveBeenCalledOnce(); expect(sdk.activateElement).not.toHaveBeenCalled();
  });
});
