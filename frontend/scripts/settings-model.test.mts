import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentEnabled, normalizeAgentSettings, parseExpandedRoster, withAgentEnabled, mergeSettingsFields, settingsFields, dirtySettingsKinds } from '../src/features/settings/settings-model.ts';

const settings = normalizeAgentSettings({ codex_bin: 'codex', path: '/bin', local_profiles: [], codex_args: [], codex_env: [], command_configs: [], local_enabled: true, codex_enabled: false, command_enabled: true });

test('saving Local settings never changes launcher availability', () => {
  assert.deepEqual(withAgentEnabled(settings, 'local', true), settings);
});

test('toggling one launcher preserves the other launcher', () => {
  const next = withAgentEnabled(settings, 'codex', true);
  assert.equal(agentEnabled(next, 'codex'), true);
  assert.equal(agentEnabled(next, 'command'), true);
});

test('expanded roster persistence accepts only known cards', () => {
  assert.deepEqual(parseExpandedRoster('["local","codex","command","other"]'), ['local', 'codex', 'command']);
  assert.deepEqual(parseExpandedRoster('invalid'), []);
});

test('each save replaces only its own fields', () => {
  const server = { ...settings, codex_args: ['server-codex'], command_configs: [{ id: 'a', name: 'server', program: 'node', args: ['server'], env: [] }] };
  const draft = { ...settings, codex_args: ['draft-codex'], command_configs: [{ id: 'b', name: 'draft', program: 'python', args: ['draft'], env: [{ key: 'MODE', value: 'test' }] }], local_profiles: ['~/.bashrc', '~/profile'] };
  for (const kind of ['local', 'codex', 'command'] as const) {
    const fields = settingsFields(kind);
    const payload = mergeSettingsFields(server, draft, fields);
    for (const key of Object.keys(server) as (keyof typeof server)[]) assert.deepEqual(payload[key], fields.includes(key) ? draft[key] : server[key]);
  }
  assert.deepEqual(server.command_configs[0].args, ['server']);
});

test('toggle and shortcut saves do not submit other edited fields', () => {
  const commandDraft = [{ id: 'a', name: 'draft', program: 'python', args: ['--safe'], env: [] }];
  const draft = { ...settings, codex_enabled: true, codex_bin: 'draft-path', codex_args: ['draft'], command_configs: commandDraft };
  const toggled = mergeSettingsFields(settings, draft, settingsFields('codex', 'toggle'));
  assert.equal(toggled.codex_enabled, true);
  assert.equal(toggled.codex_bin, settings.codex_bin);
  assert.deepEqual(toggled.codex_args, settings.codex_args);
  assert.deepEqual(toggled.command_configs, settings.command_configs);
  assert.deepEqual(settingsFields('local', 'toggle'), []);
  const shortcut = mergeSettingsFields(settings, draft, settingsFields('codex', 'dialog'));
  assert.equal(shortcut.codex_enabled, settings.codex_enabled);
  assert.equal(shortcut.codex_bin, 'draft-path');
  assert.deepEqual(shortcut.codex_args, ['draft']);
  assert.deepEqual(shortcut.command_configs, settings.command_configs);
});

test('save acknowledgements normalize submitted fields without replacing other local drafts', () => {
  const commandDraft = [{ id: 'local', name: 'not saved', program: 'sh', args: [], env: [] }];
  const draft = { ...settings, codex_args: [' --model ', ''], command_configs: commandDraft };
  const saved = normalizeAgentSettings({ ...settings, codex_args: ['--model'] });
  const next = mergeSettingsFields(draft, saved, settingsFields('codex'));
  assert.deepEqual(next.codex_args, ['--model']);
  assert.deepEqual(next.command_configs, commandDraft);
  assert.deepEqual(draft.codex_args, [' --model ', '']);
});

test('about page uses the package version and current Rust stack', () => {
  const source = readFileSync(new URL('../src/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const cargo = readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf8');
  assert.match(packageInfo.version, /^\d+\.\d+\.\d+$/);
  assert.match(cargo, new RegExp(`^version = "${packageInfo.version}"$`, 'm'));
  assert.match(source, /\['版本号', packageInfo\.version\]/);
  assert.match(source, /\['技术栈', 'Rust backend · React frontend'\]/);
  assert.doesNotMatch(source, /Go backend/);
});

test('card dirty state and one-card reset preserve other drafts', () => {
  const commandDraft = [{ id: 'local', name: 'draft', program: 'sh', args: [], env: [] }];
  const draft = { ...settings, codex_enabled: true, codex_args: ['edited'], command_configs: commandDraft };
  assert.deepEqual(dirtySettingsKinds(draft, settings), ['codex', 'command']);
  const reset = mergeSettingsFields(draft, settings, settingsFields('codex'));
  assert.deepEqual(dirtySettingsKinds(reset, settings), ['command']);
  assert.equal(reset.codex_enabled, true);
  assert.deepEqual(reset.command_configs, commandDraft);
  assert.deepEqual(dirtySettingsKinds(null, settings), []);
});
