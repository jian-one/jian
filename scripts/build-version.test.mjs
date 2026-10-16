import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseVersion, selectVersion, updateProjectVersion } from './build-version.mjs';

test('patch version increments by default and explicit versions take precedence', () => {
  assert.equal(selectVersion('0.2.9', []), '0.2.10');
  assert.equal(selectVersion('0.2.9', ['--keep-version']), '0.2.9');
  assert.equal(selectVersion('0.2.9', ['-kv']), '0.2.9');
  assert.equal(selectVersion('0.2.9', ['--version', '1.4.2']), '1.4.2');
  assert.equal(selectVersion('0.2.9', ['--version=1.4.2', '-kv']), '1.4.2');
});

test('versions require exactly three numeric components', () => {
  for (const value of ['1', '1.2', '1.2.3-beta', '01.2.3', '1.2.-3']) {
    assert.throws(() => parseVersion(value), /expected x\.y\.z/);
  }
  assert.throws(() => selectVersion('1.2.3', ['--version', '1.2.3', '--version', '2.0.0']), /used only once/);
  assert.throws(() => selectVersion('1.2.3', ['--bad']), /unknown build option/);
});

test('project manifest versions update together and can be kept', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jian-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'frontend'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "jian"\nversion = "0.2.3"\n\n[dependencies]\nanyhow = "1"\n');
  fs.writeFileSync(path.join(root, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "jian"\nversion = "0.2.3"\n');
  fs.writeFileSync(path.join(root, 'frontend/package.json'), '{"name":"jian-ui","version":"0.2.3"}\n');
  fs.writeFileSync(path.join(root, 'frontend/package-lock.json'), '{"name":"jian-ui","version":"0.2.3","packages":{"":{"name":"jian-ui","version":"0.2.3"}}}\n');

  assert.deepEqual(updateProjectVersion(root, []), { previous: '0.2.3', selected: '0.2.4' });
  assert.match(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'), /^version = "0\.2\.4"$/m);
  assert.match(fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8'), /^name = "jian"\nversion = "0\.2\.4"$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'frontend/package.json'))).version, '0.2.4');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'frontend/package-lock.json'))).packages[''].version, '0.2.4');
  assert.deepEqual(updateProjectVersion(root, ['--keep-version']), { previous: '0.2.4', selected: '0.2.4' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'frontend')).sort(), ['package-lock.json', 'package.json']);
});

test('project version update restores every file when a later rename fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jian-version-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'frontend'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "jian"\nversion = "0.2.3"\n');
  fs.writeFileSync(path.join(root, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "jian"\nversion = "0.2.3"\n');
  fs.writeFileSync(path.join(root, 'frontend/package.json'), '{"name":"jian-ui","version":"0.2.3"}\n');
  fs.writeFileSync(path.join(root, 'frontend/package-lock.json'), '{"name":"jian-ui","version":"0.2.3","packages":{"":{"name":"jian-ui","version":"0.2.3"}}}\n');
  const files = ['Cargo.toml', 'Cargo.lock', 'frontend/package.json', 'frontend/package-lock.json'];
  const original = files.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const renameSync = fs.renameSync;
  let failed = false;
  fs.renameSync = function (from, to) {
    if (!failed && to === path.join(root, 'Cargo.lock')) {
      failed = true;
      throw new Error('injected rename failure');
    }
    return renameSync.call(fs, from, to);
  };
  try {
    assert.throws(() => updateProjectVersion(root, []), /injected rename failure/);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(root, file), 'utf8')), original);
  assert.deepEqual(fs.readdirSync(root).sort(), ['Cargo.lock', 'Cargo.toml', 'frontend']);
});
