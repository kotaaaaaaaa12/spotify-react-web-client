import { getFromLocalStorageWithExpiry } from '../localstorage';
import { getRefreshToken } from './login';
import { PAIR_MODE } from './pairing';

const scopePath = '/v1/melody/v1/check_scope?scope=web-playback';
export interface PlayerCheck {
  name: string;
  result: 'accepted' | 'rejected' | 'no_response' | 'timed_out' | 'skipped';
  httpStatus?: number;
  subscription?: string;
}
export interface PlayerReport {
  version: 1;
  sessionMode: 'paired' | 'direct';
  checks: PlayerCheck[];
}

export async function getPlayerAccessToken(forceRefresh = false): Promise<string> {
  const stored = !forceRefresh && getFromLocalStorageWithExpiry('access_token') as string | null;
  const token = stored || await getRefreshToken();
  if (!token) throw new Error('Your Spotify session expired. Sign in again.');
  return token;
}

async function check(name: string, path: string, token?: string, profile = false): Promise<PlayerCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), token ? 10000 : 20000);
  try {
    const response = await fetch(path, {
      credentials: token ? 'omit' : 'same-origin', cache: 'no-store',
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}), signal: controller.signal,
    });
    const result: PlayerCheck = { name, result: response.ok ? 'accepted' : 'rejected', httpStatus: response.status };
    if (profile && response.ok) {
      // Keep only the subscription category, never profile identifiers or email.
      try {
        const data = await response.json();
        result.subscription = ['premium', 'free', 'open'].includes(data.product) ? data.product : 'unknown';
      } catch { result.subscription = 'unknown'; }
    } else { await response.body?.cancel(); }
    return result;
  } catch {
    return { name, result: controller.signal.aborted ? 'timed_out' : 'no_response' };
  } finally { clearTimeout(timeout); }
}

export async function runPlayerDiagnostics(): Promise<PlayerReport> {
  const token = await getPlayerAccessToken();
  const paired = !!localStorage.getItem(PAIR_MODE);
  const checks = await Promise.all([
    check('Browser scope check', `https://api.spotify.com${scopePath}`, token),
    paired ? check('Worker scope check', `/api/spotify${scopePath}`) : Promise.resolve({ name: 'Worker scope check', result: 'skipped' } as PlayerCheck),
    check('Account check', paired ? '/api/spotify/v1/me' : 'https://api.spotify.com/v1/me', paired ? undefined : token, true),
  ]);
  return { version: 1, sessionMode: paired ? 'paired' : 'direct', checks };
}
