import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import xterm from '@xterm/xterm';
import { isPasteShortcut, TerminalInputBuffer, terminalKeyData } from '../src/terminal-input-buffer.ts';

const { Terminal } = xterm;

const fixture = () => {
  let value = '', preview = '';
  const sent: string[] = [], deferred: (() => void)[] = [];
  const buffer = new TerminalInputBuffer({
    clear: () => { value = ''; },
    preview: text => { preview = text; },
    read: () => value,
    send: text => sent.push(text),
    defer: callback => { deferred.push(callback); return () => { const index = deferred.indexOf(callback); if (index >= 0) deferred.splice(index, 1); }; },
  });
  return { buffer, deferred, get preview() { return preview; }, sent, set value(text: string) { value = text; } };
};

test('commits an iOS composition once after the final input event', () => {
  const state = fixture();
  state.buffer.compositionStart();
  state.buffer.compositionUpdate('ni');
  state.value = 'ni';
  state.buffer.input({ data: 'ni', inputType: 'insertCompositionText', isComposing: true });
  state.buffer.compositionUpdate('你');
  state.value = '你';
  state.buffer.compositionEnd('你');
  state.buffer.input({ data: '你', inputType: 'insertText', isComposing: false });
  assert.deepEqual(state.sent, ['你']);
  assert.equal(state.preview, '');
  assert.equal(state.deferred.length, 0);
});

test('falls back to compositionend when iOS does not emit a final input event', () => {
  const state = fixture();
  state.buffer.compositionStart();
  state.value = '好';
  state.buffer.compositionEnd('好');
  state.deferred.splice(0).forEach(callback => callback());
  assert.deepEqual(state.sent, ['好']);
});

test('forwards direct Unicode text and converts terminal controls', () => {
  const state = fixture();
  state.value = '👋';
  state.buffer.input({ data: '👋', inputType: 'insertText', isComposing: false });
  assert.equal(state.buffer.beforeInput('deleteContentBackward', false), '\u007f');
  assert.equal(state.buffer.beforeInput('insertLineBreak', false), '\r');
  assert.deepEqual(state.sent, ['👋', '\u007f', '\r']);
});

test('maps physical keyboard controls without consuming plain text', () => {
  assert.equal(terminalKeyData({ key: 'ArrowUp', altKey: false, ctrlKey: false, metaKey: false, isComposing: false }), '\u001b[A');
  assert.equal(terminalKeyData({ key: 'c', altKey: false, ctrlKey: true, metaKey: false, isComposing: false }), '\u0003');
  assert.equal(terminalKeyData({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 229 }), null);
  assert.equal(terminalKeyData({ key: 'a', altKey: false, ctrlKey: false, metaKey: false, isComposing: false }), null);
});

test('recognizes Ctrl/Cmd+V as a browser paste shortcut', () => {
  assert.equal(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, altKey: false }), true);
  assert.equal(isPasteShortcut({ key: 'V', ctrlKey: false, metaKey: true, altKey: false }), true);
  assert.equal(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: true, altKey: false }), true);
  assert.equal(isPasteShortcut({ key: 'v', ctrlKey: false, metaKey: false, altKey: false }), false);
  assert.equal(isPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, altKey: true }), false);
});

test('does not answer terminal queries while restoring replayed output', async () => {
  const source = readFileSync(new URL('../src/features/terminal/mountTerminal.ts', import.meta.url), 'utf8');
  const term = new Terminal({ disableStdin: /new Terminal\(\{[^}]*disableStdin: true/.test(source) });
  const sent: string[] = [];
  term.onData(data => sent.push(data));
  await new Promise<void>(resolve => term.write('\x1b[6n\x1b[c\x1b[?2026$p', resolve));
  assert.deepEqual(sent, []);
});
