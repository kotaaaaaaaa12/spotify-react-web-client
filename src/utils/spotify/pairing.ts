import { setLocalStorageWithExpiry } from '../localstorage';

export const PAIR_MODE = 'spotify_pair_mode';
export interface DeviceConnection {
  code: string;
  expiresAt: number;
  link: string;
}

export async function pairingRequest(path: string, method = 'GET') {
  const response = await fetch(`/api/pair/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(method === 'POST' ? { headers: { 'X-Spotify-Device': '1' } } : {}),
  });
  if (response.status === 401 || response.status === 410) {
    localStorage.removeItem(PAIR_MODE);
    localStorage.removeItem('access_token');
  }
  let data;
  try { data = await response.json(); }
  catch {
    // Safari otherwise exposes an opaque JSON parsing error for Worker errors
    // or an HTML fallback page. Include the operation, never session secrets.
    throw new Error(`Unexpected server response (HTTP ${response.status}, ${method} /api/pair/${path.split('?')[0]}). Redeploy the latest device connection update and start a new connection.`);
  }
  if (!response.ok) {
    throw new Error(data.error || 'Unable to connect this device.');
  }
  return data;
}

export function savePairedToken(data: { access_token: string; expires_in: number }) {
  if (!data.access_token || !Number.isFinite(data.expires_in)) throw new Error('Invalid device session.');
  localStorage.setItem(PAIR_MODE, '1');
  localStorage.removeItem('refresh_token');
  setLocalStorageWithExpiry('access_token', data.access_token, Math.max(1, data.expires_in - 60) * 1000);
  return data.access_token;
}

export async function refreshPairedToken() {
  const data = await pairingRequest('refresh', 'POST');
  if (data.status !== 'ready') throw new Error('Finish connecting this device using your phone.');
  return savePairedToken(data);
}

export async function signOutPairedSession() {
  if (!localStorage.getItem(PAIR_MODE)) return;
  const response = await fetch('/api/pair/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Spotify-Device': '1' } });
  if (!response.ok && response.status !== 401 && response.status !== 410) {
    throw new Error('Unable to sign out of this device. Check your connection and try again.');
  }
}
