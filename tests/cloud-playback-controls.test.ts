import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/axios', () => ({ default: { put: vi.fn(async () => {}), post: vi.fn(async () => {}), get: vi.fn(async () => ({ data: {} })) } }));
import axios from '../src/axios';
import { playerService } from '../src/services/player';
import { setServerAudio } from '../src/utils/spotify/browserAudio';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
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
