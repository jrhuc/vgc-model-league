import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'pokemon-showdown');
const lockPath = path.join(root, 'showdown.lock.json');
const lockText = fs.readFileSync(lockPath, 'utf8');
const lock = JSON.parse(lockText);
const checkOnly = process.argv.includes('--check');
const updateIndex = process.argv.indexOf('--update');
const updateMode = updateIndex >= 0;
const updateArgument = process.argv[updateIndex + 1];
const requestedRef = updateArgument && !updateArgument.startsWith('--') ? updateArgument : 'HEAD';
const requiredBuildFiles = ['dist/sim/index.js', 'dist/sim/index.d.ts', 'dist/server/room-battle.js'];

if (typeof lock.repository !== 'string' || !/^[0-9a-f]{40}$/.test(lock.commit)) {
  throw new Error('showdown.lock.json must contain a repository URL and full commit SHA');
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
  const missing = requiredBuildFiles.filter((file) => !fs.existsSync(path.join(directory, file)));
  if (missing.length) {
    throw new Error(`Pokémon Showdown is not built (${missing.join(', ')} missing); run npm run setup:showdown`);
  }
}

function buildRevision(commit) {
  run('npm', ['ci', '--prefix', directory]);
  run('npm', ['run', 'build-npm', '--prefix', directory]);
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
    if (checkOnly) throw new Error('Pokémon Showdown is not installed; run npm run setup:showdown');
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
    throw new Error(`Pokémon Showdown is at ${current || 'an unknown revision'}; run npm run setup:showdown first`);
  }

  let target = lock.commit;
  if (updateMode) {
    run('git', ['-C', directory, 'fetch', '--depth=1', lock.repository, requestedRef]);
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
    if (!updateMode) run('git', ['-C', directory, 'fetch', '--depth=1', lock.repository, target]);
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
      run('npm', ['test']);
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
