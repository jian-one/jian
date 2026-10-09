import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCatalog, emptyCatalogSlice, catalogFeedback } from '../src/features/session-catalog/catalog-state.ts';

test('catalog snapshots cannot overwrite newer events and preserve other areas', () => {
  const local = { ...emptyCatalogSlice(), revision: 7 };
  const current = { local, codex: { ...emptyCatalogSlice(), revision: 9, error: 'retained' } };
  const merged = mergeCatalog(current, { codex: { ...emptyCatalogSlice(), revision: 8 } });
  assert.equal(merged.local, local);
  assert.equal(merged.codex, current.codex);
  const updated = mergeCatalog(merged, { codex: { ...emptyCatalogSlice(), revision: 10 } });
  assert.equal(updated.codex?.error, null);
  assert.equal(current.codex.error, 'retained');
  assert.equal(catalogFeedback({ ...emptyCatalogSlice(), error: 'offline' }), '更新失败，保留上次列表');
});

test('a failed cold discovery retains the browser catalog but a successful empty result clears it', () => {
  const rows = [{ id: 'cached', kind: 'local' as const, title: 'Bash', workspace: '/work', status: 'idle' }];
  const current = { local: { ...emptyCatalogSlice(), rows } };
  const failed = mergeCatalog(current, { local: { ...emptyCatalogSlice(), revision: 0, error: 'unavailable' } });
  assert.equal(failed.local?.rows, rows);
  assert.equal(failed.local?.error, 'unavailable');
  const empty = mergeCatalog(failed, { local: { ...emptyCatalogSlice(), revision: 1, last_success_at: '2026-10-08T00:00:00Z' } });
  assert.deepEqual(empty.local?.rows, []);
});
