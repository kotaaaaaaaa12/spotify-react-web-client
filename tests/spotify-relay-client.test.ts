import { AxiosError } from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/utils/spotify/login', () => ({ getRefreshToken: vi.fn(async () => 'new-token') }));
vi.mock('../src/utils/cache', () => ({ cacheGet: vi.fn(), cacheSet: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  const data = new Map<string, string>([['spotify_pair_mode', '1'], ['access_token', JSON.stringify({ value: 'browser-sdk-token', expiry: Date.now() + 3600000 })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

it('loads the paired profile through the same-origin relay without sending its bearer token', async () => {
  const client = (await import('../src/axios')).default;
  const adapter = vi.fn(async config => ({ data: { id: 'user' }, status: 200, statusText: 'OK', headers: {}, config }));
  await client.get('/me', { adapter });
  const config = adapter.mock.calls[0][0];
  expect(config.baseURL).toBe('/api/spotify/v1'); expect(config.withCredentials).toBe(true);
  expect(config.headers.get('Authorization')).toBeUndefined(); expect(config.headers.get('X-Spotify-Device')).toBe('1');
});
it('rewrites Spotify pagination URLs and rejects other absolute destinations', async () => {
  const client = (await import('../src/axios')).default;
  const adapter = vi.fn(async config => ({ data: {}, status: 200, statusText: 'OK', headers: {}, config }));
  await client.get('https://api.spotify.com/v1/me/following?after=cursor', { adapter });
  expect(adapter.mock.calls[0][0].url).toBe('/me/following?after=cursor');
  await expect(client.get('https://other.example.com/me', { adapter })).rejects.toThrow('Invalid Spotify API destination');
  await expect(client.get('//other.example.com/me', { adapter })).rejects.toThrow('Invalid Spotify API path');
  expect(adapter).toHaveBeenCalledTimes(1);
});
it('retains the existing direct API path for ordinary Spotify login', async () => {
  localStorage.removeItem('spotify_pair_mode');
  const client = (await import('../src/axios')).default;
  const adapter = vi.fn(async config => ({ data: {}, status: 200, statusText: 'OK', headers: {}, config }));
  await client.get('/me', { adapter });
  const config = adapter.mock.calls[0][0];
  expect(config.baseURL).toBe('https://api.spotify.com/v1'); expect(config.headers.get('Authorization')).toBe('Bearer browser-sdk-token');
});
it('identifies a relay network failure and the endpoint without exposing query parameters', async () => {
  const client = (await import('../src/axios')).default;
  const adapter = async (config: any) => { throw new AxiosError('Network Error', 'ERR_NETWORK', config); };
  await expect(client.get('/me?private=hidden', { adapter })).rejects.toThrow('API relay (GET /me; no HTTP response)');
});
it('shows upstream HTTP status and message for account permission errors', async () => {
  const client = (await import('../src/axios')).default;
  const adapter = async (config: any) => {
    throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, { data: { error: { message: 'User is not registered' } }, status: 403, statusText: 'Forbidden', headers: {}, config });
  };
  await expect(client.get('/me', { adapter })).rejects.toThrow('Spotify Web API (HTTP 403, GET /me): User is not registered');
});
