import { getRuntimeConfig } from '../../runtimeConfig';
import { getFromLocalStorageWithExpiry, setLocalStorageWithExpiry } from '../localstorage';
import { PAIR_MODE, refreshPairedToken, signOutPairedSession } from './pairing';

const SCOPES = [
  'ugc-image-upload', 'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-modify-public', 'playlist-modify-private',
  'playlist-read-collaborative', 'user-follow-modify', 'user-follow-read',
  'user-read-playback-position', 'user-top-read', 'user-read-recently-played',
  'user-library-read', 'user-library-modify',
];

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

const PENDING_LOGIN = 'spotify_pkce_login';
let refreshPromise: Promise<string | null> | undefined;
let callbackPromise: Promise<[string | null, boolean]> | undefined;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function clearSpotifySession() {
  localStorage.removeItem(PAIR_MODE);
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('playback_device_id');
  localStorage.removeItem('code_verifier');
  sessionStorage.removeItem(PENDING_LOGIN);
}

export async function signOutSpotify() {
  // Keep the confirmation dialog open on a network failure so logout can be retried.
  await signOutPairedSession();
  clearSpotifySession();
}

async function tokenRequest(body: URLSearchParams): Promise<string> {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    if (response.status === 400 || response.status === 401) clearSpotifySession();
    throw new Error(data.error_description || 'Spotify authorization failed. Please sign in again.');
  }
  const token = data as TokenResponse;
  localStorage.removeItem(PAIR_MODE);
  // Spotify reports seconds; the local storage helper expects milliseconds.
  setLocalStorageWithExpiry('access_token', token.access_token, Math.max(1, token.expires_in - 60) * 1000);
  if (token.refresh_token) localStorage.setItem('refresh_token', token.refresh_token);
  return token.access_token;
}

const logInWithSpotify = async (): Promise<void> => {
  await signOutPairedSession();
  localStorage.removeItem(PAIR_MODE);
  const { clientId, redirectUri } = getRuntimeConfig();
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PENDING_LOGIN, JSON.stringify({ verifier, state, redirectUri, createdAt: Date.now() }));
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), state, code_challenge_method: 'S256', code_challenge: challenge,
  }).toString();
  location.assign(url.href);
};

export const getRefreshToken = async (): Promise<string | null> => {
  if (refreshPromise) return refreshPromise;
  if (localStorage.getItem(PAIR_MODE)) {
    refreshPromise = refreshPairedToken();
    try { return await refreshPromise; }
    finally { refreshPromise = undefined; }
  }
  const refreshToken = localStorage.getItem('refresh_token');
  if (!refreshToken) return null;
  refreshPromise = tokenRequest(new URLSearchParams({
    client_id: getRuntimeConfig().clientId,
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }));
  try { return await refreshPromise; }
  finally { refreshPromise = undefined; }
};

const getToken = async (): Promise<[string | null, boolean]> => {
  if (callbackPromise) return callbackPromise;
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  const callbackState = params.get('state');
  // Handle the callback before a previously saved session.
  if (code || error) {
    const pending = sessionStorage.getItem(PENDING_LOGIN);
    sessionStorage.removeItem(PENDING_LOGIN);
    for (const key of ['code', 'state', 'error', 'error_description']) params.delete(key);
    history.replaceState({}, document.title, `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    callbackPromise = (async () => {
      const transaction = pending ? JSON.parse(pending) : null;
      const config = getRuntimeConfig();
      if (!transaction || !callbackState || callbackState !== transaction.state ||
          transaction.redirectUri !== config.redirectUri || !transaction.verifier ||
          !Number.isFinite(transaction.createdAt) || Date.now() - transaction.createdAt > 10 * 60 * 1000) {
        throw new Error('Spotify sign-in expired or could not be verified. Please sign in again.');
      }
      if (error) throw new Error('Spotify sign-in was cancelled. You can try again.');
      const token = await tokenRequest(new URLSearchParams({
        client_id: config.clientId, redirect_uri: config.redirectUri,
        code: code!, code_verifier: transaction.verifier, grant_type: 'authorization_code',
      }));
      return [token, true] as [string, boolean];
    })();
    return callbackPromise;
  }
  const token = getFromLocalStorageWithExpiry('access_token') as string | null;
  if (token) return [token, true];
  const refreshed = await getRefreshToken();
  return [refreshed, !!refreshed];
};

export default { logInWithSpotify, getToken, getRefreshToken };
