import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getRefreshToken } from '../src/utils/spotify/login';
vi.mock('../src/utils/spotify/login', () => ({ getRefreshToken: vi.fn(async () => 'refreshed-player-token') }));

beforeEach(() => {
  vi.resetModules(); vi.mocked(getRefreshToken).mockReset().mockResolvedValue('refreshed-player-token');
  const data = new Map<string, string>([['spotify_pair_mode', '1'], ['access_token', JSON.stringify({ value: 'private-player-token', expiry: Date.now() + 3600000 })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  vi.stubGlobal('fetch', vi.fn(async url => url.endsWith('/me') ? Response.json({ id: 'private-id', email: 'private@example.com', product: 'premium' }) : Response.json({ token: 'private-response-token' })));
});
afterEach(() => vi.unstubAllGlobals());

it('compares direct and cookie-authenticated scope checks without putting credentials in the report', async () => {
  const { runPlayerDiagnostics } = await import('../src/utils/spotify/playerDiagnostics');
  const report = await runPlayerDiagnostics();
  expect(report.checks.map(check => check.result)).toEqual(['accepted', 'accepted', 'accepted']);
  expect(report.checks[2].subscription).toBe('premium');
  const serialized = JSON.stringify(report);
  for (const secret of ['private-player-token', 'private-response-token', 'private-id', 'private@example.com']) expect(serialized).not.toContain(secret);
  expect(fetch).toHaveBeenCalledWith('https://api.spotify.com/v1/melody/v1/check_scope?scope=web-playback', expect.objectContaining({ credentials: 'omit', headers: { Authorization: 'Bearer private-player-token' } }));
  const relay = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith('/api/spotify/v1/melody'))!;
  expect(relay[1]).toMatchObject({ credentials: 'same-origin' }); expect(relay[1]).not.toHaveProperty('headers');
});
it('distinguishes a browser request with no response from a successful server check', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => { if (url.startsWith('https:')) throw new TypeError('Failed to fetch'); return Response.json({ product: 'premium' }); }));
  const { runPlayerDiagnostics } = await import('../src/utils/spotify/playerDiagnostics');
  const report = await runPlayerDiagnostics();
  expect(report.checks[0].result).toBe('no_response'); expect(report.checks[0]).not.toHaveProperty('httpStatus');
  expect(report.checks[1]).toMatchObject({ result: 'accepted', httpStatus: 200 });
});
it('preserves a Spotify scope rejection as HTTP 403', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => url.endsWith('/me') ? Response.json({ product: 'premium' }) : Response.json({ error: 'Invalid scopes' }, { status: 403 })));
  const { runPlayerDiagnostics } = await import('../src/utils/spotify/playerDiagnostics');
  expect((await runPlayerDiagnostics()).checks[0]).toMatchObject({ result: 'rejected', httpStatus: 403 });
});
it('does not make an unauthenticated relay call for ordinary direct login', async () => {
  localStorage.removeItem('spotify_pair_mode');
  const { runPlayerDiagnostics } = await import('../src/utils/spotify/playerDiagnostics');
  expect((await runPlayerDiagnostics()).checks[1].result).toBe('skipped');
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('https://api.spotify.com/'))).toBe(true);
});
it('refreshes the player token explicitly after a rejection even when the cached expiry is still valid', async () => {
  const { getPlayerAccessToken } = await import('../src/utils/spotify/playerDiagnostics');
  expect(await getPlayerAccessToken()).toBe('private-player-token'); expect(getRefreshToken).not.toHaveBeenCalled();
  expect(await getPlayerAccessToken(true)).toBe('refreshed-player-token'); expect(getRefreshToken).toHaveBeenCalledTimes(1);
});
it('refuses a stale token when an explicit refresh returns no session', async () => {
  vi.mocked(getRefreshToken).mockResolvedValue(null);
  const { getPlayerAccessToken } = await import('../src/utils/spotify/playerDiagnostics');
  await expect(getPlayerAccessToken(true)).rejects.toThrow('session expired');
});
it('refreshes an expired cached token before passing it to the SDK', async () => {
  localStorage.setItem('access_token', JSON.stringify({ value: 'expired', expiry: Date.now() - 1 }));
  const { getPlayerAccessToken } = await import('../src/utils/spotify/playerDiagnostics');
  expect(await getPlayerAccessToken()).toBe('refreshed-player-token');
});
