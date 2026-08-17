import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSocketMessage } from '../src/shared/api.ts';

test('malformed websocket messages are ignored without throwing', () => {
  assert.equal(parseSocketMessage('{'), null);
  assert.equal(parseSocketMessage('null'), null);
  assert.deepEqual(parseSocketMessage('{"type":"pong"}'), { type: 'pong' });
  assert.deepEqual(parseSocketMessage('{"id":3,"status":200,"body":[]}'), { id: 3, status: 200, body: [] });
});
