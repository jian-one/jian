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

test('saved launcher restores only when there is no current selection', () => {
  assert.equal(shouldRestoreNativeSession({ hasOpenSessions: false, hasActiveSession: false, isLocalArea: false }), true);
  assert.equal(shouldRestoreNativeSession({ hasOpenSessions: true, hasActiveSession: false, isLocalArea: false }), false);
  assert.equal(shouldRestoreNativeSession({ hasOpenSessions: false, hasActiveSession: true, isLocalArea: false }), false);
});

test('session normalization and saved-session lookup have one shared rule', () => {
  const rows = normalizeSessions([
    { id: 'older', kind: 'codex', title: '-', workspace: '/tmp', status: 'idle', updated_at: '2024-01-01' },
    { id: 'newer', kind: 'codex', title: ' New ', workspace: '/tmp', status: 'idle', updated_at: '2024-02-01' },
  ]);
  assert.deepEqual(rows.map(row => [row.id, row.title]), [
    ['newer', 'New'],
    ['older', '无标题'],
  ]);
  assert.equal(savedSession(rows, 'newer', 'command'), undefined);
  assert.equal(savedSession(rows, 'newer', 'codex')?.id, 'newer');
});

test('the app restores a saved launcher while list navigation reads the cache first', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

  assert.match(source, /shouldRestoreNativeSession\(/);
  assert.match(source, /catalog.read\(target, refresh\)/);
  const catalog = readFileSync(new URL('../src/features/session-catalog/useSessionCatalog.ts', import.meta.url), 'utf8');
  assert.match(catalog, /sessions\/catalog\?areas=/);
  assert.match(catalog, /if \(area !== 'local'\) await api/);
  assert.match(source, /localStorage\.getItem\(activeSessionKey\(target\)\)/);
});

test('closing the final native session tab clears its persisted restore key', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

  assert.match(source, /const closeTab = \(key: string\) => \{[\s\S]*localStorage\.removeItem\(selectedSessionKey\(closed\)\)/);
  assert.equal(selectedSessionKey({ kind: 'local' }), 'jian.active_local_session');
  assert.equal(selectedSessionKey({ kind: 'command' }), 'jian.active_command_session');
});

test('terminal release errors are caught and shown in a dialog', () => {
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');

  assert.match(main, /const confirmOperation = async \(\) => \{[\s\S]*catch \(e\) \{\s*setError\(errorMessage\(e\)\);/);
  assert.match(main, /<ErrorDialog\s+open=\{!!error\}/);
  assert.match(settings, /<ErrorDialog open=\{!!error\}/);
});
