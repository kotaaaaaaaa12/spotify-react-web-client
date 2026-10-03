import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const SOLOIST_REVISION = 'soloist-cloud-1';
export const MAX_CHECKPOINT = 1024 * 1024;
const MAX_STATE = 2 * 1024 * 1024;
const safePath = value => typeof value === 'string' && value.length <= 512 &&
  (value === '.device_id' || value.startsWith('settings/')) &&
  !value.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0\r\n]/.test(part)) &&
  !/(?:^|\/)(?:LOCK|LOG|.*\.log|.*\.lock)$/.test(value);

export async function sessionAccounts(root) {
  try {
    const entries = await readdir(join(root, 'settings', 'Users'), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && entry.name.endsWith('-user'))
      .map(entry => { try { return decodeURIComponent(entry.name.slice(0, -5)); } catch { return ''; } });
  } catch { return []; }
}

// Only device identity and settings are retained. Audio, logs, and received
// ZeroConf blobs are never part of a checkpoint.
export async function captureState(root, expectedUsername) {
  const accounts = await sessionAccounts(root);
  if (accounts.length !== 1 || accounts[0] !== expectedUsername) throw new Error('Session owner is unverified.');
  const files = []; let bytes = 0;
  async function visit(relative) {
    const path = join(root, relative), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Invalid session file.');
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(`${relative}/${child}`);
    } else if (info.isFile() && safePath(relative)) {
      if (files.length >= 128 || info.size > MAX_STATE || (bytes += info.size) > MAX_STATE) throw new Error('Session state is too large.');
      const data = await readFile(path);
      files.push({ path: relative, data: data.toString('base64') });
    }
  }
  await visit('.device_id'); await visit('settings');
  const checkpoint = gzipSync(Buffer.from(JSON.stringify({ version: 1, files }))).toString('base64');
  if (checkpoint.length > MAX_CHECKPOINT) throw new Error('Session checkpoint is too large.');
  return checkpoint;
}

export async function restoreState(root, checkpoint, expectedUsername) {
  if (typeof checkpoint !== 'string' || checkpoint.length > MAX_CHECKPOINT || !/^[A-Za-z0-9+/]*={0,2}$/.test(checkpoint)) throw new Error('Invalid session checkpoint.');
  const archive = JSON.parse(gunzipSync(Buffer.from(checkpoint, 'base64'), { maxOutputLength: MAX_STATE * 2 }).toString());
  if (archive.version !== 1 || !Array.isArray(archive.files) || !archive.files.length || archive.files.length > 128) throw new Error('Invalid session archive.');
  let size = 0; const paths = new Set();
  const files = archive.files.map(file => {
    if (!safePath(file.path) || paths.has(file.path) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('Invalid session entry.');
    paths.add(file.path);
    const data = Buffer.from(file.data, 'base64'); size += data.length;
    if (size > MAX_STATE) throw new Error('Session archive is too large.');
    return { path: file.path, data };
  });
  if (!paths.has('.device_id')) throw new Error('Missing device identity.');
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: 0o600 });
  }
  const accounts = await sessionAccounts(root);
  if (accounts.length !== 1 || accounts[0] !== expectedUsername) {
    await rm(root, { recursive: true, force: true }); throw new Error('Session owner does not match.');
  }
}
