import { readFileSync, writeFileSync } from 'node:fs';
import { parseConfigFileTextToJson } from 'typescript';

const path = 'wrangler.jsonc';
const source = readFileSync(path, 'utf8');
const parsed = parseConfigFileTextToJson(path, source);
if (parsed.error || !parsed.config || typeof parsed.config !== 'object') throw new Error('Unable to read wrangler.jsonc. Fix its JSON before installing dependencies.');
const config = parsed.config;
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
if (!existing || !migrated) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log('Configured the device connection binding. Existing Worker settings and Spotify variables were preserved.');
}
