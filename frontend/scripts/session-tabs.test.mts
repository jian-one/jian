import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjacentTab, moveTab } from '../src/session-tabs.ts';

test('close chooses the visual neighbor, among session tabs', () => {
  const order = ['local:a', 'codex:third', 'pi:role:b'];
  assert.equal(adjacentTab(order, 'codex:third'), 'local:a');
  assert.equal(adjacentTab(order, 'local:a'), 'codex:third');
  assert.equal(adjacentTab(order, 'pi:role:b'), 'codex:third');
  assert.equal(adjacentTab(['codex:third'], 'codex:third'), null);
  assert.equal(adjacentTab(order, 'missing'), null);
});

test('session reorder does not mutate input', () => {
  const order = ['local:a', 'codex:third', 'codex:b'];
  const moved = moveTab(order, 'codex:third', 'codex:b');
  assert.deepEqual(moved, ['local:a', 'codex:b', 'codex:third']);
  assert.equal(adjacentTab(moved, 'codex:b'), 'local:a');
  assert.deepEqual(order, ['local:a', 'codex:third', 'codex:b']);
  assert.deepEqual(moveTab(order, 'codex:b', 'local:a'), ['codex:b', 'local:a', 'codex:third']);
  assert.equal(moveTab(order, 'missing', 'codex:third'), order);
  assert.equal(moveTab(order, 'codex:third', 'codex:third'), order);
});

import { connectionView, statusView, openSessionKey, activeSessionKey, initialInterfaceTheme } from '../src/shared/model.ts';
test('connection messages cannot turn disconnected or unknown process state into running', () => {
  assert.equal(connectionView('disconnected').tone, 'idle');
  assert.equal(connectionView('reconnecting').tone, 'waiting');
  assert.equal(statusView('已断开连接').tone, 'idle');
  assert.equal(statusView('unknown').label, 'unknown');
  assert.equal(statusView('running').label, '运行中');
  assert.notEqual(openSessionKey({ id: 'same', kind: 'pi', profile: 'ops', title: '', workspace: '', status: '' }), openSessionKey({ id: 'same', kind: 'pi', profile: 'research', title: '', workspace: '', status: '' }));
});
test('new users get light while legacy and independent theme choices remain valid', () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
  assert.equal(initialInterfaceTheme(), 'light');
  values.set('jian.theme', 'console');
  assert.equal(initialInterfaceTheme(), 'console');
  values.set('jian.interface_theme', 'black');
  assert.equal(initialInterfaceTheme(), 'black');
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('Pi sessions in different roles retain separate restore keys', () => {
  assert.notEqual(activeSessionKey('pi', 'first'), activeSessionKey('pi', 'second'));
});
