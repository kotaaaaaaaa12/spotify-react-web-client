import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod, rename, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
const execute = promisify(execFile);
const EXPIRES = 90 * 24 * 60 * 60;
const TARGET = '/tmp/soloist-bin';

export function soloistBuildTime(version) {
  const match = version.match(/\bbuild\s+(\d{10})\b/);
  return match ? Number(match[1]) : null;
}
async function current(binary) {
  try {
    const { stdout } = await execute(binary, ['--version'], { timeout: 5000, maxBuffer: 4096 });
    const timestamp = soloistBuildTime(stdout);
    return timestamp !== null && timestamp <= Date.now() / 1000 + 86400 && Date.now() / 1000 < timestamp + EXPIRES - 86400;
  } catch { return false; }
}

export async function ensureSoloist({ directory = TARGET, bundled = '/opt/soloist/soloist', fetchArchive = fetch } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = join(directory, 'soloist');
  if (await current(binary)) return binary;
  if (await current(bundled)) { await copyFile(bundled, binary); await chmod(binary, 0o700); return binary; }
  if (process.arch !== 'x64' || process.platform !== 'linux') throw new Error('This Container requires Linux amd64.');
  const response = await fetchArchive('https://soloist-builds.spotifycdn.com/soloist_release_x86_64.tar.gz', { redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (!response.ok || Number(response.headers.get('Content-Length')) > 32 * 1024 * 1024) throw new Error('Soloist download failed.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('Soloist download is too large.'); chunks.push(chunk); }
  const archive = join(directory, 'release.tar.gz'), candidate = join(directory, 'soloist.new');
  try {
    await writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
    const { stdout } = await execute('tar', ['-tzf', archive], { timeout: 10000, maxBuffer: 65536 });
    const entry = stdout.split('\n').find(path => path === 'soloist' || path === './soloist');
    if (!entry) throw new Error('Soloist archive has no executable.');
    // Extract only the expected executable, never archive paths or links.
    const data = await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xOzf', archive, entry], { stdio: ['ignore', 'pipe', 'ignore'] });
      const output = []; let bytes = 0;
      child.on('error', reject); child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 96 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Executable is too large.')); } else output.push(chunk); });
      child.once('close', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error('Soloist extraction failed.')));
    });
    if (data.length < 4 || !data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Invalid Soloist executable.');
    await writeFile(candidate, data, { mode: 0o700 });
    if (!await current(candidate)) throw new Error('Downloaded Soloist build is expired or incompatible.');
    await rename(candidate, binary); return binary;
  } finally { await rm(archive, { force: true }); await rm(candidate, { force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await ensureSoloist({ directory: process.argv[2] || TARGET }); console.log('Soloist executable is ready.'); }
  catch { console.error('Unable to install a current Soloist executable.'); process.exitCode = 1; }
}
