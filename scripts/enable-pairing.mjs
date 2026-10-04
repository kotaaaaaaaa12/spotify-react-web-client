import { readFileSync, writeFileSync } from 'node:fs';
import { parseConfigFileTextToJson } from 'typescript';

const path = 'wrangler.jsonc';
const source = readFileSync(path, 'utf8');
const parsed = parseConfigFileTextToJson(path, source);
if (parsed.error || !parsed.config || typeof parsed.config !== 'object') throw new Error('Unable to read wrangler.jsonc. Fix its JSON before installing dependencies.');
const config = parsed.config;
const original = JSON.stringify(config);
const binding = { name: 'PAIR_SESSIONS', class_name: 'PairingSession' };
config.durable_objects ||= {};
config.durable_objects.bindings ||= [];
const existing = config.durable_objects.bindings.find(item => item.name === binding.name);
if (existing && (existing.class_name !== binding.class_name || existing.script_name)) throw new Error('PAIR_SESSIONS is already used by a different Durable Object. Resolve the binding name before deploying.');
if (!existing) config.durable_objects.bindings.push(binding);
config.migrations ||= [];
const migrated = config.migrations.some(item => [...(item.new_sqlite_classes || []), ...(item.new_classes || [])].includes(binding.class_name));
if (!migrated) {
  if (config.migrations.some(item => item.tag === 'spotify-pairing-v1')) throw new Error('The spotify-pairing-v1 migration tag is already in use. Resolve it before deploying.');
  config.migrations.push({ tag: 'spotify-pairing-v1', new_sqlite_classes: [binding.class_name] });
}
const serverBinding = { name: 'SERVER_PLAYERS', class_name: 'SpotifyPlayerContainer' };
const serverExisting = config.durable_objects.bindings.find(item => item.name === serverBinding.name);
if (serverExisting && (serverExisting.class_name !== serverBinding.class_name || serverExisting.script_name)) throw new Error('SERVER_PLAYERS is already used by another Durable Object. Resolve the binding before deploying.');
if (!serverExisting) config.durable_objects.bindings.push(serverBinding);
const serverMigrated = config.migrations.some(item => [...(item.new_sqlite_classes || []), ...(item.new_classes || [])].includes(serverBinding.class_name));
if (!serverMigrated) {
  if (config.migrations.some(item => item.tag === 'spotify-server-player-v1')) throw new Error('The spotify-server-player-v1 migration tag is already in use. Resolve it before deploying.');
  config.migrations.push({ tag: 'spotify-server-player-v1', new_sqlite_classes: [serverBinding.class_name] });
}
if (config.main && !['cloudflare/worker.mjs', './cloudflare/worker.mjs', 'cloudflare/container-worker.mjs', './cloudflare/container-worker.mjs'].includes(config.main)) throw new Error('This update expects the Spotify Worker entrypoint. Review your custom main before deploying.');
config.main = 'cloudflare/container-worker.mjs';
config.containers ||= [];
const container = config.containers.find(item => item.class_name === serverBinding.class_name);
const settings = { class_name: serverBinding.class_name, image: './container/Dockerfile', image_build_context: '.',
  instance_type: 'standard-2', max_instances: 5, constraints: { regions: ['APAC'] } };
if (container) Object.assign(container, settings);
else config.containers.push(settings);
if (JSON.stringify(config) !== original) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log('Configured QR connections and APAC server playback (standard-2, up to 5 instances). Existing Spotify variables, routes, and Worker name were preserved.');
}
