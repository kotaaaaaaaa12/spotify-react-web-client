import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldUseServerPlayback, watchBrowserPlayerConnection } from '../src/utils/spotify/browserPlayerConnection';

afterEach(() => vi.useRealTimers());
describe('browser connection fallback', () => {
  it('falls back for SDK access and connection failures', () => {
    for (const reason of ['sdk_load_failed', 'initialization_error', 'authentication_error', 'connection_failed', 'connection_timeout', 'not_ready'] as const) expect(shouldUseServerPlayback(reason)).toBe(true);
  });
  it('keeps account, track, and autoplay errors in the browser', () => {
    for (const reason of ['account_error', 'playback_error', 'autoplay_failed', undefined] as const) expect(shouldUseServerPlayback(reason)).toBe(false);
  });
  it('bounds a connection that never becomes ready', () => {
    vi.useFakeTimers(); const timeout = vi.fn(); watchBrowserPlayerConnection(timeout);
    vi.advanceTimersByTime(19999); expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(timeout).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000); expect(timeout).toHaveBeenCalledOnce();
  });
  it('cancels the deadline when ready, rejected, or unmounted', () => {
    vi.useFakeTimers(); const timeout = vi.fn(); const cancel = watchBrowserPlayerConnection(timeout);
    cancel(); cancel(); vi.advanceTimersByTime(60000); expect(timeout).not.toHaveBeenCalled();
  });
});
