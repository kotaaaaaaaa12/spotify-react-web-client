import { describe, expect, it } from 'vitest';
import { classifyNativeLine, safeDiagnostics } from '../container/diagnostics.mjs';
describe('Safe native diagnostics', () => {
  it('extracts only fixed error labels and status codes from private process messages', () => {
    const raw = 'ERROR could not initialize spirc: Permission denied {client_token: "private-token", user: private@example.com, HTTP 403}';
    expect(classifyNativeLine(raw)).toEqual({ event: 'client_token_failed', errorKind: 'PermissionDenied', httpStatus: 403 });
    expect(classifyNativeLine('INFO Authenticated as private-user')).toBeNull();
    expect(classifyNativeLine('ERROR Failed to connect: ECONNREFUSED private-host')).toEqual({ event: 'network_error', osErrorCode: 'ECONNREFUSED' });
  });
  it('rejects arbitrary Container report fields, unknown labels, and unbounded histories', () => {
    expect(safeDiagnostics({ revision: 'private-token' })).toBeUndefined();
    const report = safeDiagnostics({ revision: 'native-diagnostics-2', token: 'private-token',
      nativeExit: { code: 1, signal: 'private-token', stderr: 'private-message' },
      events: [{ event: 'private-token' }, ...Array.from({ length: 30 }, () => ({ event: 'unclassified_error',
        errorKind: 'private-token', httpStatus: 403, osErrorCode: 'private-token', reason: 'private-token', stderr: 'private-message' }))] });
    expect(report.events).toHaveLength(12); expect(report.nativeExit).toEqual({ code: 1, signal: null });
    expect(JSON.stringify(report)).not.toContain('private-');
  });
});
