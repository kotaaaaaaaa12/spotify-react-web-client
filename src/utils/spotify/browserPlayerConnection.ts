export type BrowserPlayerFailure = 'sdk_load_failed' | 'initialization_error' | 'authentication_error' | 'connection_failed' | 'connection_timeout' | 'not_ready' | 'account_error' | 'playback_error' | 'autoplay_failed';

export const BROWSER_PLAYER_TIMEOUT_MS = 20000;

export function shouldUseServerPlayback(reason?: BrowserPlayerFailure): boolean {
  return reason !== undefined && ['sdk_load_failed', 'initialization_error', 'authentication_error', 'connection_failed', 'connection_timeout', 'not_ready'].includes(reason);
}

// A connect() promise can resolve without a ready event, or never settle at all.
export function watchBrowserPlayerConnection(onTimeout: () => void, timeout = BROWSER_PLAYER_TIMEOUT_MS): () => void {
  const timer = setTimeout(onTimeout, timeout);
  return () => clearTimeout(timer);
}
