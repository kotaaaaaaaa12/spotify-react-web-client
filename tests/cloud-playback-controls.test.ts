import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/axios', () => ({ default: { put: vi.fn(async () => {}), post: vi.fn(async () => {}), get: vi.fn(async () => ({ data: {} })) } }));
import axios from '../src/axios';
import { playerService } from '../src/services/player';
import { setServerAudio } from '../src/utils/spotify/browserAudio';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('window', new EventTarget());
  vi.clearAllMocks(); playerService.setCloudPlaybackState('off'); playerService.setPlaybackDevice(null);
});
afterEach(() => { playerService.setCloudPlaybackState('off'); setServerAudio(null); vi.unstubAllGlobals(); });
describe('Song selection during cloud startup', () => {
  it('waits for the exact cloud device and never plays on an unrelated active phone', async () => {
    playerService.setCloudPlaybackState('starting'); const play = vi.fn(async () => {}); setServerAudio({ play } as any);
    const pending = playerService.startPlayback({ uris: ['spotify:track:selected'] });
    await Promise.resolve(); await Promise.resolve(); expect(axios.put).not.toHaveBeenCalled();
    playerService.setPlaybackDevice('cloud-sdk-device'); playerService.setCloudPlaybackState('ready'); await pending;
    expect(axios.put).toHaveBeenCalledWith('/me/player/play', { uris: ['spotify:track:selected'] }, { params: { device_id: 'cloud-sdk-device' } });
    expect(play).toHaveBeenCalled();
  });
  it('rejects a queued selection on failure and blocks transport commands while cloud is unavailable', async () => {
    playerService.setCloudPlaybackState('starting'); const pending = playerService.startPlayback();
    await Promise.resolve(); playerService.setCloudPlaybackState('failed');
    await expect(pending).rejects.toThrow('server player'); await playerService.pausePlayback();
    expect(axios.put).not.toHaveBeenCalled();
  });
});

describe('Immediate live audio controls', () => {
  it('mutes locally before a slow server response and preserves the final intent of rapid pause/resume', async () => {
    playerService.setPlaybackDevice('cloud-sdk-device'); playerService.setCloudPlaybackState('ready'); playerService.setCloudSdkControls(true);
    const target = { play: vi.fn(async () => {}), pause: vi.fn(), begin: vi.fn(), complete: vi.fn() }; setServerAudio(target);
    let resolvePause: (value: Response) => void = () => {};
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolvePause = resolve; }))
      .mockResolvedValueOnce(Response.json({ phase: 'streaming', audioEpoch: 2 })); vi.stubGlobal('fetch', request);
    const pause = playerService.pausePlayback();
    expect(target.pause).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const resume = playerService.startPlayback(); await Promise.resolve(); await Promise.resolve();
    resolvePause(Response.json({ phase: 'streaming', audioEpoch: 1 })); await pause; await resume;
    expect(JSON.parse(request.mock.calls[0][1].body).action).toBe('pause'); expect(JSON.parse(request.mock.calls[1][1].body).action).toBe('resume');
    expect(target.complete).toHaveBeenCalledOnce(); expect(target.complete).toHaveBeenCalledWith(2, false);
    expect(axios.put).not.toHaveBeenCalled();
  });
  it('does not let a later volume update leave a resumed player muted', async () => {
    playerService.setPlaybackDevice('cloud-sdk-device'); playerService.setCloudPlaybackState('ready'); playerService.setCloudSdkControls(true);
    const target = { play: vi.fn(async () => {}), pause: vi.fn(), begin: vi.fn(), complete: vi.fn() }; setServerAudio(target);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ audioEpoch: 1 })));
    const resume = playerService.startPlayback();
    await vi.waitFor(() => expect(target.begin).toHaveBeenCalledOnce());
    const volume = playerService.setVolume(50); await resume; await volume;
    expect(target.complete).toHaveBeenCalledWith(1, false);
    expect(target.begin).toHaveBeenCalledOnce();
  });
  it('orders a selected track before a later pause instead of restarting it after the pause', async () => {
    playerService.setPlaybackDevice('cloud-sdk-device'); playerService.setCloudPlaybackState('ready'); playerService.setCloudSdkControls(true);
    setServerAudio({ play: async () => {}, pause: () => {} });
    let finishPlay = () => {}; vi.mocked(axios.put).mockImplementationOnce(() => new Promise(resolve => { finishPlay = () => resolve(undefined as any); }));
    const request = vi.fn(async () => Response.json({ audioEpoch: 3 })); vi.stubGlobal('fetch', request);
    const play = playerService.startPlayback({ uris: ['spotify:track:new'] });
    await vi.waitFor(() => expect(axios.put).toHaveBeenCalledOnce());
    const pause = playerService.pausePlayback(); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
    finishPlay(); await play; await pause; expect(JSON.parse(request.mock.calls[0][1].body).action).toBe('pause');
  });
});
