import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../cloudflare/worker.mjs';
import { collectLibraryPages } from '../src/services/libraryPagination';

vi.mock('../src/runtimeConfig', () => ({
  getRuntimeConfig: () => ({ clientId: 'a'.repeat(32), redirectUri: 'https://music.example.com/' }),
}));

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }, clear: () => data.clear() };
}

const origin = 'https://music.example.com';
const env = { SPOTIFY_CLIENT_ID: 'a'.repeat(32), SPOTIFY_REDIRECT_URI: '',
  ASSETS: { fetch: vi.fn(async () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } })) } };

describe('Worker deployment', () => {
  it('serves runtime configuration with no caching and an exact root callback', async () => {
    const response = await worker.fetch(new Request(`${origin}/api/config`), env);
    expect(await response.json()).toEqual({ clientId: 'a'.repeat(32), redirectUri: `${origin}/` });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('shows a setup error for a missing client ID', async () => {
    expect((await worker.fetch(new Request(`${origin}/api/config`), { ...env, SPOTIFY_CLIENT_ID: '' })).status).toBe(503);
  });
  it('rejects redirects to a different site', async () => {
    expect((await worker.fetch(new Request(`${origin}/api/config`), { ...env, SPOTIFY_REDIRECT_URI: 'https://other.example.com/' })).status).toBe(503);
  });
  it('serves deep links through assets and prevents stale HTML', async () => {
    const request = new Request(`${origin}/artist/example`);
    const response = await worker.fetch(request, env);
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(request);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Permissions-Policy')).not.toContain('encrypted-media');
    expect(response.headers.get('Permissions-Policy')).not.toContain('autoplay');
  });
  it('does not turn unknown API paths into the SPA', async () => {
    expect((await worker.fetch(new Request(`${origin}/api/missing`), env)).status).toBe(404);
  });
});

describe('Full Spotify library pagination', () => {
  it('loads artists beyond the first fifty and deduplicates overlapping pages', async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ id: String(index) }));
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: first, next: 'https://api.spotify.com/v1/me/following?type=artist&after=49' })
      .mockResolvedValueOnce({ items: [{ id: '49' }, { id: '50' }], next: null });
    const result = await collectLibraryPages(fetchPage, 'after');
    expect(result).toHaveLength(51);
    expect(fetchPage).toHaveBeenLastCalledWith({ limit: 50, after: '49' });
  });
  it('stops a repeating cursor instead of looping forever', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ items: [], next: 'https://api.spotify.com/v1/me/following?after=same' });
    await expect(collectLibraryPages(fetchPage, 'after')).rejects.toThrow('invalid library cursor');
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe('Spotify authorization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('sessionStorage', storage());
    vi.stubGlobal('location', { search: '', pathname: '/', hash: '', assign: vi.fn() });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('document', { title: 'Music' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' })));
  });
  function callback(state: string) {
    location.search = `?code=test-code&state=${state}`;
    sessionStorage.setItem('spotify_pkce_login', JSON.stringify({
      state: 'correct-state', verifier: 'verifier', redirectUri: `${origin}/`, createdAt: Date.now(),
    }));
  }
  it('rejects a callback with a mismatched state without sending its code', async () => {
    callback('wrong-state');
    const { default: login } = await import('../src/utils/spotify/login');
    await expect(login.getToken()).rejects.toThrow('could not be verified');
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('spotify_pkce_login')).toBeNull();
  });
  it('exchanges a code once and stores a seconds-to-milliseconds expiry', async () => {
    callback('correct-state');
    const { default: login } = await import('../src/utils/spotify/login');
    const started = Date.now();
    expect(await Promise.all([login.getToken(), login.getToken()])).toEqual([['new-access', true], ['new-access', true]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const expiry = JSON.parse(localStorage.getItem('access_token')!).expiry;
    expect(expiry - started).toBeGreaterThanOrEqual(3540000);
    expect(expiry - started).toBeLessThan(3541000);
  });
  it('deduplicates concurrent refreshes and persists a rotated refresh token', async () => {
    localStorage.setItem('refresh_token', 'old-refresh');
    const { getRefreshToken } = await import('../src/utils/spotify/login');
    await Promise.all([getRefreshToken(), getRefreshToken(), getRefreshToken()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('refresh_token')).toBe('new-refresh');
  });
  it('refreshes an expired session on a reload without redirecting the user', async () => {
    localStorage.setItem('refresh_token', 'old-refresh');
    localStorage.setItem('access_token', JSON.stringify({ value: 'expired', expiry: 1 }));
    const { default: login } = await import('../src/utils/spotify/login');
    expect(await login.getToken()).toEqual(['new-access', true]);
    expect(location.assign).not.toHaveBeenCalled();
  });
  it('returns a signed-out state without redirecting when there is no session', async () => {
    const { default: login } = await import('../src/utils/spotify/login');
    expect(await login.getToken()).toEqual([null, false]);
    expect(fetch).not.toHaveBeenCalled();
    expect(location.assign).not.toHaveBeenCalled();
  });
  it('clears revoked credentials and reports the error', async () => {
    localStorage.setItem('refresh_token', 'revoked');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error_description: 'Token revoked' }, { status: 400 })));
    const { getRefreshToken } = await import('../src/utils/spotify/login');
    await expect(getRefreshToken()).rejects.toThrow('Token revoked');
    expect(localStorage.getItem('refresh_token')).toBeNull();
  });
});
