import { describe, expect, it } from 'vitest';
import { safeDevicePairing } from '../container/device-auth.mjs';

describe('private native pairing', () => {
  it('permits only the fixed Spotify verification page and matching code', () => {
    expect(safeDevicePairing({ url: 'https://spotify.com/pair', code: 'ABC123' })).toEqual({ url: 'https://spotify.com/pair?code=ABC123', code: 'ABC123' });
    for (const url of ['http://spotify.com/pair', 'https://spotify.com.evil/pair', 'https://spotify.com/other', 'https://spotify.com/pair?code=OTHER1', 'https://spotify.com/pair?token=secret', 'https://spotify.com/pair#secret', 'https://evil@spotify.com/pair']) {
      expect(safeDevicePairing({ url, code: 'ABC123' })).toBeUndefined();
    }
    expect(safeDevicePairing({ url: 'https://spotify.com/pair', code: 'secret\ncode' })).toBeUndefined();
  });
});
