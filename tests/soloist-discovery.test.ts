import { describe, expect, it } from 'vitest';
import { discoveryRecords, readDnsName } from '../container/soloist-discovery.mjs';
import { pairingForm } from '../cloudflare/soloist.mjs';
describe('bounded Soloist discovery and authentication messages', () => {
  it('rejects cyclic DNS pointers and truncated records', () => {
    expect(() => readDnsName(Buffer.from([0xc0, 0]), 0)).toThrow();
    expect(() => discoveryRecords(Buffer.alloc(4))).toThrow();
    const packet = Buffer.alloc(12); packet.writeUInt16BE(1, 6);
    expect(() => discoveryRecords(packet)).toThrow();
  });
  it('forwards only the documented addUser fields and supports empty access-token client keys', () => {
    const form = new URLSearchParams({ action: 'addUser', userName: 'user', blob: 'opaque-encrypted-credentials', clientKey: '', tokenType: 'accesstoken' }).toString();
    expect(pairingForm(form)).toBe(form);
    expect(pairingForm(form + '&destination=https://untrusted.example')).toBeNull();
    expect(pairingForm(form + '&blob=second')).toBeNull();
    expect(pairingForm(form.replace('addUser', 'resetUsers'))).toBeNull();
  });
});
