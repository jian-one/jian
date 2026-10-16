import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`invalid version ${JSON.stringify(value)}; expected x.y.z`);
  }
  return value;
}

export function selectVersion(current, args) {
  parseVersion(current);
  let specified;
  let keep = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--keep-version' || arg === '-kv') {
      keep = true;
    } else if (arg === '--version') {
      if (specified !== undefined || !args[index + 1]) {
        throw new Error('--version requires one x.y.z value and may be used only once');
      }
      specified = parseVersion(args[++index]);
    } else if (arg.startsWith('--version=')) {
      if (specified !== undefined) throw new Error('--version may be used only once');
      specified = parseVersion(arg.slice('--version='.length));
    } else {
      throw new Error(`unknown build option: ${arg}`);
    }
  }
  if (specified !== undefined) return specified;
  if (keep) return current;
  const [major, minor, patch] = current.split('.');
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
}

function writeTemp(file, data, temps) {
  const temp = `${file}.tmp-${process.pid}-${temps.length}`;
  fs.writeFileSync(temp, data, { mode: fs.statSync(file).mode });
  temps.push(temp);
  return temp;
}

export function updateProjectVersion(root, args) {
  const cargoPath = path.join(root, 'Cargo.toml');
  const cargoLockPath = path.join(root, 'Cargo.lock');
  const packagePath = path.join(root, 'frontend/package.json');
  const lockPath = path.join(root, 'frontend/package-lock.json');
  const cargo = fs.readFileSync(cargoPath, 'utf8');
  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packageStart = cargo.indexOf('[package]');
  const nextTable = cargo.indexOf('\n[', packageStart + '[package]'.length);
  const cargoBlock = packageStart < 0 ? '' : cargo.slice(packageStart, nextTable < 0 ? cargo.length : nextTable);
  const current = cargoBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const lockMatches = [...cargoLock.matchAll(/^\[\[package\]\]\nname = "jian"\nversion = "([^"]+)"/gm)];
  if (!current || lockMatches.length !== 1 || lockMatches[0][1] !== current || packageJson.version !== current || packageLock.version !== current || packageLock.packages?.['']?.version !== current) {
    throw new Error('Cargo.toml, Cargo.lock, frontend/package.json and frontend/package-lock.json versions must match');
  }

  const next = selectVersion(current, args);
  if (next === current) return { previous: current, selected: next };
  const nextCargoBlock = cargoBlock.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${next}"`);
  if (nextCargoBlock === cargoBlock) throw new Error('could not update Cargo.toml package version');
  const nextCargo = cargo.replace(cargoBlock, nextCargoBlock);
  const nextCargoLock = cargoLock.replace(
    /^(\[\[package\]\]\nname = "jian"\nversion = ")[^"]+("$)/m,
    `$1${next}$2`,
  );
  const nextPackage = `${JSON.stringify({ ...packageJson, version: next }, null, 2)}\n`;
  packageLock.version = next;
  packageLock.packages[''].version = next;
  const nextLock = `${JSON.stringify(packageLock, null, 2)}\n`;

  const temps = [];
  const writes = [
    [cargoPath, cargo, nextCargo],
    [cargoLockPath, cargoLock, nextCargoLock],
    [packagePath, fs.readFileSync(packagePath, 'utf8'), nextPackage],
    [lockPath, fs.readFileSync(lockPath, 'utf8'), nextLock],
  ];
  let backups = [];
  try {
    backups = writes.map(([file, original]) => [file, writeTemp(file, original, temps)]);
    const staged = writes.map(([file, , data]) => [file, writeTemp(file, data, temps)]);
    try {
      for (const [file, temp] of staged) fs.renameSync(temp, file);
    } catch (error) {
      for (const [file, backup] of backups) fs.renameSync(backup, file);
      backups = [];
      throw error;
    }
  } finally {
    for (const temp of temps) if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { previous: current, selected: next };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { previous, selected } = updateProjectVersion(process.cwd(), process.argv.slice(2));
    process.stdout.write(`${previous} ${selected}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
