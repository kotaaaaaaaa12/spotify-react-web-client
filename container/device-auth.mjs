export const PLAYER_REVISION = 'native-device-auth-1';

export function safeDevicePairing(input) {
  if (!input || typeof input.code !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(input.code)) return;
  try {
    const url = new URL(input.url);
    if (url.origin !== 'https://spotify.com' || url.pathname !== '/pair' || url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'code') || url.searchParams.getAll('code').length > 1 ||
        (url.searchParams.has('code') && url.searchParams.get('code') !== input.code)) return;
    return { code: input.code, url: `https://spotify.com/pair?code=${encodeURIComponent(input.code)}` };
  } catch { return; }
}
