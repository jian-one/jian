import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentEnabled, normalizeAgentSettings, parseExpandedRoster, withAgentEnabled, mergeSettingsFields, settingsFields, dirtySettingsKinds } from '../src/features/settings/settings-model.ts';

const settings = normalizeAgentSettings({ codex_bin: 'codex', path: '/bin', hermes_home: '', hermes_bin: 'hermes', hermes_profiles: [], local_profiles: [], codex_args: [], hermes_args: [], codex_env: [], hermes_env: [], codex_enabled: false, hermes_enabled: true });

test('saving Local settings never changes agent availability', () => {
  assert.deepEqual(withAgentEnabled(settings, 'local', true), settings);
});

test('toggling one agent preserves the other agent', () => {
  const next = withAgentEnabled(settings, 'codex', true);
  assert.equal(agentEnabled(next, 'codex'), true);
  assert.equal(agentEnabled(next, 'hermes'), true);
});

test('expanded roster persistence accepts only known cards', () => {
  assert.deepEqual(parseExpandedRoster('["local","codex","other"]'), ['local', 'codex']);
  assert.deepEqual(parseExpandedRoster('invalid'), []);
});

test('each save only replaces its own fields and preserves server state for other agents', () => {
  const server = { ...settings, codex_args: ['server-codex'], hermes_args: ['server-hermes'], pi_args: ['server-pi'], pi_roles: [{ name: 'server', entry: '/bin/pi', home: '/tmp' }] };
  const draft = { ...settings, codex_args: ['draft-codex'], hermes_args: ['draft-hermes'], pi_args: ['draft-pi'], local_profiles: ['~/.bashrc', '~/profile'], pi_roles: [] };
  for (const kind of ['local', 'codex', 'hermes', 'pi'] as const) {
    const fields = settingsFields(kind);
    const payload = mergeSettingsFields(server, draft, fields);
    for (const key of Object.keys(server) as (keyof typeof server)[]) assert.deepEqual(payload[key], fields.includes(key) ? draft[key] : server[key]);
  }
  assert.deepEqual(server.codex_args, ['server-codex']);
});

test('toggle and shortcut saves do not submit other edited fields', () => {
  const draft = { ...settings, codex_enabled: true, codex_bin: 'draft-path', codex_args: ['draft'], pi_roles: [{ name: '', entry: '', home: '' }] };
  const toggled = mergeSettingsFields(settings, draft, settingsFields('codex', 'toggle'));
  assert.equal(toggled.codex_enabled, true);
  assert.equal(toggled.codex_bin, settings.codex_bin);
  assert.deepEqual(toggled.codex_args, settings.codex_args);
  assert.deepEqual(settingsFields('local', 'toggle'), []);
  const shortcut = mergeSettingsFields(settings, draft, settingsFields('codex', 'dialog'));
  assert.equal(shortcut.codex_enabled, settings.codex_enabled);
  assert.equal(shortcut.codex_bin, settings.codex_bin);
  assert.deepEqual(shortcut.codex_args, ['draft']);
  assert.deepEqual(shortcut.pi_roles, settings.pi_roles);
});

test('save acknowledgements normalize submitted fields without replacing other local drafts', () => {
  const draft = { ...settings, codex_args: [' --model ', ''], hermes_args: ['not-saved'] };
  const saved = normalizeAgentSettings({ ...settings, codex_args: ['--model'] });
  const next = mergeSettingsFields(draft, saved, settingsFields('codex'));
  assert.deepEqual(next.codex_args, ['--model']);
  assert.deepEqual(next.hermes_args, ['not-saved']);
  assert.deepEqual(draft.codex_args, [' --model ', '']);
});

test('about page uses the package version and current Rust stack', () => {
  const source = readFileSync(new URL('../src/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageInfo.version, '0.2.3');
  assert.match(source, /\['版本号', packageInfo\.version\]/);
  assert.match(source, /\['技术栈', 'Rust backend · React frontend'\]/);
  assert.doesNotMatch(source, /Go backend/);
});

test('card dirty state ignores saved switches and resetting one card preserves other drafts', () => {
  const draft = { ...settings, codex_enabled: true, codex_args: ['edited'], hermes_args: ['other draft'] };
  assert.deepEqual(dirtySettingsKinds(draft, settings), ['codex', 'hermes']);
  const reset = mergeSettingsFields(draft, settings, settingsFields('codex'));
  assert.deepEqual(dirtySettingsKinds(reset, settings), ['hermes']);
  assert.equal(reset.codex_enabled, true); assert.deepEqual(reset.hermes_args, ['other draft']);
  assert.deepEqual(dirtySettingsKinds(null, settings), []);
});
