import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerPlaybackRequestError, serverRequest } from '../src/utils/spotify/serverPlayback';

afterEach(() => vi.unstubAllGlobals());
describe('startup report in the browser', () => {
  it('retains only safe startup labels so HTTP failures can be copied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unable to verify the account.', errorCode: 'server_account_request_failed', token: 'private-token',
      startup: { revision: 'server-startup-1', stage: 'account', upstreamStatus: 401, exception: 'private-exception' } }, { status: 503 })));
    try { await serverRequest('start'); throw Error('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(ServerPlaybackRequestError);
      expect((error as ServerPlaybackRequestError).report).toEqual({ version: 3, phase: 'failed', errorCode: 'server_account_request_failed', startup: { revision: 'server-startup-1', stage: 'account', httpStatus: 503, upstreamStatus: 401 } });
      expect(JSON.stringify((error as ServerPlaybackRequestError).report)).not.toContain('private');
    }
  });
  it('reports unreadable HTTP responses without reflecting their body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-platform-body', { status: 502 })));
    try { await serverRequest('start'); throw Error('Expected rejection'); }
    catch (error) {
      expect((error as ServerPlaybackRequestError).report).toMatchObject({ errorCode: 'server_invalid_response', startup: { stage: 'browser_response', httpStatus: 502 } });
      expect(JSON.stringify(error)).not.toContain('private-platform-body');
    }
  });
});
