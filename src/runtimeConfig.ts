export interface SpotifyRuntimeConfig {
  clientId: string;
  redirectUri: string;
}

let config: SpotifyRuntimeConfig | undefined;

export async function loadRuntimeConfig(): Promise<void> {
  if (import.meta.env.DEV && import.meta.env.VITE_SPOTIFY_CLIENT_ID) {
    config = {
      clientId: import.meta.env.VITE_SPOTIFY_CLIENT_ID.trim(),
      redirectUri: import.meta.env.VITE_SPOTIFY_REDIRECT_URL || `${location.origin}/`,
    };
  } else {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load Spotify configuration.');
    config = data;
  }
  if (!config || !/^[a-fA-F0-9]{32}$/.test(config.clientId)) {
    throw new Error('A valid Spotify Client ID is required.');
  }
}

export function getRuntimeConfig(): SpotifyRuntimeConfig {
  if (!config) throw new Error('Spotify configuration has not loaded.');
  return config;
}
