import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/runtimeConfig', () => ({ getRuntimeConfig: () => ({ clientId: 'a'.repeat(32), redirectUri: 'https://music.example.com/' }) }));
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
}
beforeEach(() => {
  vi.resetModules(); vi.stubGlobal('localStorage', storage()); vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('location', { search: '', pathname: '/', hash: '', assign: vi.fn() });
  localStorage.setItem('spotify_pair_mode', '1');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ready', access_token: 'paired-access', expires_in: 3600 })));
});
afterEach(() => vi.unstubAllGlobals());
it('reloads and refreshes a paired browser only through the same-origin Worker', async () => {
  const { default: login } = await import('../src/utils/spotify/login');
  expect(await login.getToken()).toEqual(['paired-access', true]);
  expect(fetch).toHaveBeenCalledWith('/api/pair/refresh', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  expect(localStorage.getItem('refresh_token')).toBeNull();
  expect(location.assign).not.toHaveBeenCalled();
});
it('deduplicates simultaneous paired refreshes', async () => {
  const { getRefreshToken } = await import('../src/utils/spotify/login');
  expect(await Promise.all([getRefreshToken(), getRefreshToken()])).toEqual(['paired-access', 'paired-access']);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('deletes the server session before clearing browser credentials', async () => {
  localStorage.setItem('access_token', JSON.stringify({ value: 'paired', expiry: Date.now() + 3600000 }));
  const { signOutSpotify } = await import('../src/utils/spotify/login');
  await signOutSpotify();
  expect(fetch).toHaveBeenCalledWith('/api/pair/logout', expect.objectContaining({ method: 'POST' }));
  expect(localStorage.getItem('spotify_pair_mode')).toBeNull(); expect(localStorage.getItem('access_token')).toBeNull();
});
it('retains credentials when logout cannot reach the Worker so it can be retried', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  const { signOutSpotify } = await import('../src/utils/spotify/login');
  await expect(signOutSpotify()).rejects.toThrow('Unable to sign out');
  expect(localStorage.getItem('spotify_pair_mode')).toBe('1');
});
it('clears revoked paired mode without contacting Spotify from the receiving device', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Connect again' }, { status: 401 })));
  const { getRefreshToken } = await import('../src/utils/spotify/login');
  await expect(getRefreshToken()).rejects.toThrow('Connect again');
  expect(localStorage.getItem('spotify_pair_mode')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reports the failed operation when a Worker returns an HTML error page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Worker error</html>', { status: 500 })));
  const { pairingRequest } = await import('../src/utils/spotify/pairing');
  await expect(pairingRequest(`authorize?id=${'f'.repeat(32)}`, 'POST')).rejects.toThrow('HTTP 500, POST /api/pair/authorize');
});
it('reports an HTML fallback page and clears expired credentials even without JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Expired</html>', { status: 410 })));
  const { pairingRequest } = await import('../src/utils/spotify/pairing');
  await expect(pairingRequest('session')).rejects.toThrow('HTTP 410, GET /api/pair/session');
  expect(localStorage.getItem('spotify_pair_mode')).toBeNull();
});
