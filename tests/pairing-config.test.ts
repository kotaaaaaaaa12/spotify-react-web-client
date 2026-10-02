import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installer = resolve('scripts/enable-pairing.mjs');
describe('Automatic pairing configuration', () => {
  it('preserves existing Client ID, routes, Worker name, and migrations on an already configured repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-config-'));
    try {
      const existing = { name: 'my-existing-worker', vars: { SPOTIFY_CLIENT_ID: 'b'.repeat(32), EXTRA: 'keep' },
        routes: [{ pattern: 'spotify.example.com', custom_domain: true }],
        durable_objects: { bindings: [{ name: 'OTHER', class_name: 'Other' }] },
        migrations: [{ tag: 'old-v1', new_sqlite_classes: ['Other'] }] };
      writeFileSync(join(dir, 'wrangler.jsonc'), `// My configuration\n${JSON.stringify(existing)}`);
      execFileSync(process.execPath, [installer], { cwd: dir });
      const output = JSON.parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'));
      expect(output.vars).toEqual(existing.vars); expect(output.name).toBe(existing.name); expect(output.routes).toEqual(existing.routes);
      expect(output.migrations[0]).toEqual(existing.migrations[0]);
      expect(output.durable_objects.bindings).toHaveLength(2);
      expect(output.migrations).toHaveLength(2);
      const first = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
      execFileSync(process.execPath, [installer], { cwd: dir });
      expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(first);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not overwrite an unrelated binding with the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spotify-config-'));
    try {
      const source = JSON.stringify({ vars: { SPOTIFY_CLIENT_ID: 'c'.repeat(32) },
        durable_objects: { bindings: [{ name: 'PAIR_SESSIONS', class_name: 'ExistingService' }] } });
      writeFileSync(join(dir, 'wrangler.jsonc'), source);
      expect(() => execFileSync(process.execPath, [installer], { cwd: dir, stdio: 'pipe' })).toThrow();
      expect(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')).toBe(source);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
