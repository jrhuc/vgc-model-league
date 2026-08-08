import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'pokemon-showdown');
const lockPath = path.join(root, 'showdown.lock.json');
const repository = 'https://github.com/smogon/pokemon-showdown.git';
const lockText = fs.readFileSync(lockPath, 'utf8');
const lock = JSON.parse(lockText);
const checkOnly = process.argv.includes('--check');
const updateIndex = process.argv.indexOf('--update');
const updateMode = updateIndex >= 0;
const updateArguments = updateMode
  ? process.argv.slice(2).filter((argument) => !['--', '--check', '--update'].includes(argument))
  : [];
const requestedRef = updateArguments[0] ?? 'HEAD';
const requiredBuildFiles = ['dist/sim/index.js', 'dist/sim/index.d.ts', 'dist/server/room-battle.js'];
const runtimePackages = ['ts-chacha20'];

if (lock.repository !== repository || !/^[0-9a-f]{40}$/.test(lock.commit)) {
  throw new Error('showdown.lock.json must contain the official repository URL and a full commit SHA');
}

if (updateArguments.length > 1 || requestedRef.startsWith('-') || requestedRef.length > 200) {
  throw new Error('Pokémon Showdown update ref must be a branch, tag, or commit');
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function revision() {
  try {
    return output('git', ['-C', directory, 'rev-parse', 'HEAD']);
  } catch {
    return '';
  }
}

function assertBuild() {
  const requiredFiles = [...requiredBuildFiles, ...runtimePackages.map((name) => `node_modules/${name}/package.json`)];
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(directory, file)));
  if (missing.length) {
    throw new Error(`Pokémon Showdown is not built (${missing.join(', ')} missing); run pnpm run setup:showdown`);
  }
}

function dependencyLock() {
  const packageLock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  if (![2, 3].includes(packageLock.lockfileVersion) || !packageLock.packages) {
    throw new Error('Pokémon Showdown must use an integrity-bearing npm lock');
  }
  for (const [location, entry] of Object.entries(packageLock.packages)) {
    if (!location.startsWith('node_modules/')) continue;
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity?.startsWith('sha512-')) {
      throw new Error(`Review Pokémon Showdown's non-registry dependency at ${location}`);
    }
  }
  return packageLock;
}

function retainRuntimePackages(packageLock) {
  const installedRoot = path.join(directory, 'node_modules');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-showdown-runtime-'));
  try {
    for (const name of runtimePackages) {
      const entry = packageLock.packages?.[`node_modules/${name}`];
      if (!entry) throw new Error(`Pokémon Showdown's lock is missing runtime package ${name}`);
      const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
      if (entry.hasInstallScript || Object.keys(dependencies).length) {
        throw new Error(`Review ${name}'s new install or runtime dependencies before updating Pokémon Showdown`);
      }
      fs.cpSync(path.join(installedRoot, name), path.join(temporaryRoot, name), { recursive: true });
    }
    fs.rmSync(installedRoot, { recursive: true, force: true });
    fs.mkdirSync(installedRoot, { recursive: true });
    for (const name of runtimePackages) {
      fs.cpSync(path.join(temporaryRoot, name), path.join(installedRoot, name), { recursive: true });
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function buildRevision(commit) {
  const packageLock = dependencyLock();
  run('npm', ['--ignore-scripts', '--prefix', directory, 'ci']);
  run('npm', ['--ignore-scripts', '--prefix', directory, 'run', 'build-npm']);
  retainRuntimePackages(packageLock);
  fs.writeFileSync(path.join(directory, 'dist', '.vgc-model-league-revision'), `${commit}\n`, 'utf8');
  assertBuild();
}

function writeLock(commit) {
  const temporary = `${lockPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...lock, commit }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, lockPath);
}

function main() {
  let created = false;
  if (!fs.existsSync(directory)) {
    if (checkOnly) throw new Error('Pokémon Showdown is not installed; run pnpm run setup:showdown');
    fs.mkdirSync(directory, { recursive: true });
    run('git', ['-C', directory, 'init']);
    run('git', ['-C', directory, 'remote', 'add', 'origin', lock.repository]);
    created = true;
  } else if (!fs.existsSync(path.join(directory, '.git'))) {
    throw new Error(`${directory} exists but is not a Git checkout`);
  }

  if (!created && output('git', ['-C', directory, 'status', '--porcelain'])) {
    throw new Error('Pokémon Showdown has local changes; refusing to use an unpinned build');
  }

  const current = created ? '' : revision();
  if (updateMode && current !== lock.commit) {
    throw new Error(`Pokémon Showdown is at ${current || 'an unknown revision'}; run pnpm run setup:showdown first`);
  }

  let target = lock.commit;
  if (updateMode) {
    run('git', ['-C', directory, 'fetch', '--depth=1', '--no-tags', lock.repository, requestedRef]);
    target = output('git', ['-C', directory, 'rev-parse', 'FETCH_HEAD^{commit}']);
    if (checkOnly) {
      console.log(
        target === lock.commit
          ? `Pokémon Showdown ${lock.commit.slice(0, 12)} is current at ${requestedRef}`
          : `Pokémon Showdown update available: ${lock.commit.slice(0, 12)} -> ${target.slice(0, 12)} (${requestedRef})`,
      );
      return;
    }
  }

  if (current !== target) {
    if (checkOnly) {
      throw new Error(`Pokémon Showdown is at ${current || 'an unknown revision'}; expected ${target}`);
    }
    if (!updateMode) run('git', ['-C', directory, 'fetch', '--depth=1', '--no-tags', lock.repository, target]);
    run('git', ['-C', directory, 'checkout', '--detach', target]);
  }

  if (checkOnly) {
    assertBuild();
    console.log(`Pokémon Showdown ${lock.commit.slice(0, 12)} is pinned and built`);
    return;
  }

  try {
    buildRevision(target);
    if (updateMode) {
      writeLock(target);
      run('pnpm', ['test']);
      console.log(`Pokémon Showdown ${target.slice(0, 12)} is pinned, built, and verified`);
    } else {
      console.log(`Pokémon Showdown ${target.slice(0, 12)} is ready`);
    }
  } catch (error) {
    if (updateMode && target !== lock.commit) {
      try {
        writeLock(lock.commit);
        run('git', ['-C', directory, 'checkout', '--detach', lock.commit]);
        buildRevision(lock.commit);
      } catch (recoveryError) {
        console.error('Failed to restore the previous Pokémon Showdown build:', recoveryError);
      }
    }
    throw error;
  }
}

main();
