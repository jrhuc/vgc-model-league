import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DATA_DIR, REPO_ROOT } from './paths.js';
import { isRecord } from './value.js';

const CLI_PATH = path.join(REPO_ROOT, 'dist', 'src', 'cli.js');
const GUI_LOG_PATH = path.join(DATA_DIR, 'gui.log');
const STOP_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 15_000;

export interface RestartOptions {
  port: number;
  host?: string | undefined;
  force?: boolean;
  build?: boolean;
}

export function looksLikeGuiCommand(command: string): boolean {
  return /(?:cli\.(?:js|ts)|vgcleague)\b.*\bgui\b/.test(command);
}

async function serverState(port: number): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function listeningPids(port: number): number[] {
  const result = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processCommand(pid: number): string {
  return (spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '').trim();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return true;
    await delay(250);
  }
  return predicate();
}

async function stopServer(port: number, force: boolean): Promise<boolean> {
  const pids = listeningPids(port);
  if (!pids.length) {
    const state = await serverState(port);
    if (state) {
      console.error(`A server answers on port ${port} but its pid could not be found; stop it manually.`);
      return false;
    }
    console.log(`No GUI listening on port ${port}.`);
    return true;
  }
  for (const pid of pids) {
    const command = processCommand(pid);
    if (!looksLikeGuiCommand(command)) {
      console.error(`Port ${port} is held by pid ${pid} (${command || 'unknown'}); not a vgcleague GUI, not killing it.`);
      return false;
    }
  }
  const state = await serverState(port);
  const run = isRecord(state) && isRecord(state.run) ? state.run : undefined;
  if (run?.state === 'running' && !force) {
    console.error(
      `A run is active on port ${port}. Pass --force to restart anyway; the run will be aborted and its status persisted.`,
    );
    return false;
  }
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  const stopped = await waitFor(() => pids.every((pid) => !processAlive(pid)), STOP_TIMEOUT_MS);
  if (!stopped) {
    for (const pid of pids) if (processAlive(pid)) process.kill(pid, 'SIGKILL');
    if (!(await waitFor(() => pids.every((pid) => !processAlive(pid)), 5000))) {
      console.error(`Could not stop pid(s) ${pids.join(', ')} on port ${port}.`);
      return false;
    }
  }
  console.log(`Stopped GUI pid ${pids.join(', ')} on port ${port}.`);
  return true;
}

export async function stopGui(options: Pick<RestartOptions, 'port' | 'force'>): Promise<number> {
  return (await stopServer(options.port, options.force === true)) ? 0 : 1;
}

export async function restartGui(options: RestartOptions): Promise<number> {
  if (options.build !== false) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (build.status !== 0) {
      console.error('Build failed; any running GUI was left untouched.');
      return 1;
    }
  }
  if (!(await stopServer(options.port, options.force === true))) return 1;
  const log = fs.openSync(GUI_LOG_PATH, 'a');
  const child = spawn(
    process.execPath,
    [CLI_PATH, 'gui', '--port', String(options.port), ...(options.host ? ['--host', options.host] : [])],
    { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log] },
  );
  child.unref();
  fs.closeSync(log);
  const ready = await waitFor(async () => (await serverState(options.port)) !== undefined, START_TIMEOUT_MS);
  if (!ready) {
    console.error(`The new GUI (pid ${child.pid}) did not answer within 15s; check ${GUI_LOG_PATH}.`);
    return 1;
  }
  console.log(`VGC Model League GUI restarted at http://127.0.0.1:${options.port} (pid ${child.pid}, log ${GUI_LOG_PATH}).`);
  return 0;
}
