import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beginSessionLoad, invalidateSessionLoads, isCurrentSessionLoad, normalizeSessions, savedSession, shouldRestoreNativeSession } from '../src/session-load-guard.ts';
import { selectedSessionKey } from '../src/shared/model.ts';

test('a session list request cannot overwrite a session created after it started', () => {
  const version = { current: 0 };
  const listRequest = beginSessionLoad(version);

  invalidateSessionLoads(version);

  assert.equal(isCurrentSessionLoad(version, listRequest), false);
});

test('explicit Hermes profile selection stays on its home page when the list refreshes', () => {
  assert.equal(shouldRestoreNativeSession({ hasOpenSessions: false, hasActiveSession: false, isLocalArea: false, explicitHome: true }), false);
  assert.equal(shouldRestoreNativeSession({ hasOpenSessions: false, hasActiveSession: false, isLocalArea: false, explicitHome: false }), true);
});

test('session normalization and saved-profile lookup have one shared rule', () => {
  const rows = normalizeSessions([
    { id: 'older', kind: 'hermes', profile: '', title: '-', workspace: '/tmp', status: 'idle', updated_at: '2024-01-01' },
    { id: 'newer', kind: 'hermes', profile: 'work', title: ' New ', workspace: '/tmp', status: 'idle', updated_at: '2024-02-01' },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.profile, row.title]), [
    ['newer', 'work', 'New'],
    ['older', 'default', '无标题'],
  ]);
  assert.equal(savedSession(rows, 'newer', 'hermes', 'default'), undefined);
  assert.equal(savedSession(rows, 'newer', 'hermes', 'work')?.id, 'newer');
});

test('the app passes explicit Hermes home selection into native-session restoration', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

  assert.match(source, /shouldRestoreNativeSession\(/);
  assert.match(source, /explicitHome:\s*target === 'hermes' && hermesHomeSelected\.current/);
  assert.match(source, /const selectProfile = \(nextProfile: string\) => \{[\s\S]*localStorage\.removeItem\(activeSessionKey\('hermes', nextProfile\)\)/);
});

test('closing the final native session tab clears its persisted restore key', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

  assert.match(source, /const closeTab = \(key: string\) => \{[\s\S]*localStorage\.removeItem\(selectedSessionKey\(closed, profile\)\)/);
  assert.equal(selectedSessionKey({ kind: 'local' }), 'jian.active_local_session');
  assert.equal(selectedSessionKey({ kind: 'hermes', profile: 'work' }), 'jian.active_hermes_work_session');
});

test('terminal release errors are caught and shown in a dialog', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');

  assert.match(main, /const release = async \(\) => \{[\s\S]*catch \(e\) \{ setError\(errorMessage\(e\)\); \}/);
  assert.match(main, /<ErrorDialog open=\{!!error\}/);
  assert.match(settings, /<ErrorDialog open=\{!!error\}/);
});
