import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentEnabled, normalizeAgentSettings, parseExpandedRoster, withAgentEnabled } from '../src/features/settings/settings-model.ts';

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

test('about page uses the package version and current Rust stack', () => {
  const source = readFileSync(new URL('../src/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
  const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageInfo.version, '0.2.3');
  assert.match(source, /\['版本号', packageInfo\.version\]/);
  assert.match(source, /\['技术栈', 'Rust backend · React frontend'\]/);
  assert.doesNotMatch(source, /Go backend/);
});
