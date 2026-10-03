import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { captureState, restoreState, sessionAccounts } from '../container/soloist-state.mjs';
import { soloistBuildTime } from '../container/install-soloist.mjs';
const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), 'soloist-state-test-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('private Soloist session storage', () => {
  it('restores device identity and the authenticated account without retaining audio or logs', async () => {
    const source = await directory(), target = await directory();
    await mkdir(join(source, 'settings/Users/linked%20user-user'), { recursive: true });
    await mkdir(join(source, 'cache'));
    await writeFile(join(source, '.device_id'), 'persistent-device-id');
    await writeFile(join(source, 'settings/Users/linked%20user-user/prefs'), Buffer.from([0, 255, 23, 1]));
    await writeFile(join(source, 'settings/Users/linked%20user-user/debug.log'), 'private-log');
    await writeFile(join(source, 'cache/audio.dat'), 'audio-must-not-be-saved');
    const checkpoint = await captureState(source, 'linked user');
    await restoreState(target, checkpoint, 'linked user');
    expect(await sessionAccounts(target)).toEqual(['linked user']);
    expect(await readFile(join(target, '.device_id'), 'utf8')).toBe('persistent-device-id');
    expect(await readFile(join(target, 'settings/Users/linked%20user-user/prefs'))).toEqual(Buffer.from([0, 255, 23, 1]));
    expect((await stat(join(target, 'settings/Users/linked%20user-user/prefs'))).mode & 0o777).toBe(0o600);
    await expect(stat(join(target, 'cache'))).rejects.toThrow();
    await expect(stat(join(target, 'settings/Users/linked%20user-user/debug.log'))).rejects.toThrow();
    await expect(restoreState(target, checkpoint, 'other-user')).rejects.toThrow('owner');
  });
  it('rejects path traversal, links, ambiguous owners, and oversized decompression', async () => {
    const root = await directory();
    const archive = (files: object[]) => gzipSync(JSON.stringify({ version: 1, files })).toString('base64');
    for (const path of ['settings/../../outside', 'settings/evil\\path', '/tmp/outside', 'settings//empty']) {
      await expect(restoreState(root, archive([{ path, data: 'YQ==' }]), 'user')).rejects.toThrow();
    }
    await expect(restoreState(root, gzipSync('x'.repeat(5 * 1024 * 1024)).toString('base64'), 'user')).rejects.toThrow();
    await mkdir(join(root, 'settings/Users/user-user'), { recursive: true }); await writeFile(join(root, '.device_id'), 'device');
    await symlink('/etc/hostname', join(root, 'settings/Users/user-user/link'));
    await expect(captureState(root, 'user')).rejects.toThrow('file');
    await rm(join(root, 'settings/Users/user-user/link')); await mkdir(join(root, 'settings/Users/another-user'));
    await expect(captureState(root, 'user')).rejects.toThrow('owner');
  });
  it('reads the official executable build timestamp without treating a version number as one', () => {
    expect(soloistBuildTime('soloist 1.3.8.105 build 1790942580 (20261002) (linux/x86_64)')).toBe(1790942580);
    expect(soloistBuildTime('soloist 1.3.8.105')).toBeNull();
  });
});
