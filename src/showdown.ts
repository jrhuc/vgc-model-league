import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Battle, BattleStream, Dex, Teams, TeamValidator } from 'pokemon-showdown';

import { defaultPsDir, PINNED_PS_DIR, REPO_ROOT } from './paths.js';

export interface ShowdownApi {
  Battle: typeof Battle;
  BattleStream: typeof BattleStream;
  Dex: typeof Dex;
  Teams: typeof Teams;
  TeamValidator: typeof TeamValidator;
}
interface ShowdownLock {
  repository: string;
  commit: string;
}

const requireFromHere = createRequire(import.meta.url);
const cache = new Map<string, ShowdownApi>();
const revisionCache = new Map<string, string>();
const requiredBuildFiles = ['dist/sim/index.js', 'dist/sim/index.d.ts', 'dist/server/room-battle.js'];
const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'showdown.lock.json'), 'utf8')) as ShowdownLock;
if (typeof lock.repository !== 'string' || !/^[0-9a-f]{40}$/.test(lock.commit)) {
  throw new Error('showdown.lock.json must contain a repository URL and full commit SHA');
}
export const SHOWDOWN_LOCK: Readonly<ShowdownLock> = lock;

export function showdownCommit(psDir = defaultPsDir()): string {
  const resolved = path.resolve(psDir);
  const existing = revisionCache.get(resolved);
  if (existing) return existing;
  let revision = '';
  try {
    revision = execFileSync('git', ['-C', resolved, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch {}
  if (!revision) {
    try {
      revision = fs.readFileSync(path.join(resolved, 'dist', '.vgc-model-league-revision'), 'utf8').trim();
    } catch {}
  }
  const result = revision || 'unknown';
  revisionCache.set(resolved, result);
  return result;
}

function assertShowdownInstallation(resolved: string): void {
  const missing = requiredBuildFiles.filter((file) => !fs.existsSync(path.join(resolved, file)));
  if (missing.length) {
    throw new Error(`Pokémon Showdown is not built at ${resolved}; run pnpm run setup:showdown`);
  }
  const revision = showdownCommit(resolved);
  if (resolved === PINNED_PS_DIR && revision !== SHOWDOWN_LOCK.commit) {
    throw new Error(
      `Pokémon Showdown is at ${revision}; expected ${SHOWDOWN_LOCK.commit}. Run pnpm run setup:showdown`,
    );
  }
}

export function loadShowdown(psDir = defaultPsDir()): ShowdownApi {
  const resolved = path.resolve(psDir);
  const existing = cache.get(resolved);
  if (existing) return existing;
  assertShowdownInstallation(resolved);
  const api = requireFromHere(path.join(resolved, 'dist', 'sim')) as ShowdownApi;
  api.Dex.includeModData();
  cache.set(resolved, api);
  return api;
}

export interface TimerPlayer {
  slot: 'p1' | 'p2';
  name: string;
  active: boolean;
  knownActive: boolean;
  eliminated: boolean;
  request: { isWait: boolean | 'cantUndo' };
  secondsLeft?: number;
  turnSecondsLeft?: number;
  dcSecondsLeft?: number;
  sendRoom(message: string): void;
}

export interface RoomBattleTimerSettings {
  starting: number;
  grace: number;
  addPerTurn: number;
  maxPerTurn: number;
  maxFirstTurn: number;
}

export interface RoomBattleTimer {
  settings: RoomBattleTimerSettings;
  start(): boolean;
  stop(): boolean;
  nextRequest(player: TimerPlayer): void;
  end(): boolean;
}

interface RoomBattleTimerConstructor {
  new (battle: unknown): RoomBattleTimer;
}

export function loadRoomBattleTimer(psDir = defaultPsDir()): RoomBattleTimerConstructor {
  const resolved = path.resolve(psDir);
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  globals.Config ??= {};
  globals.Monitor ??= { crashlog() {}, slow() {} };
  globals.Dex = loadShowdown(resolved).Dex;
  const module = requireFromHere(path.join(resolved, 'dist', 'server', 'room-battle.js')) as {
    RoomBattleTimer: RoomBattleTimerConstructor;
  };
  return module.RoomBattleTimer;
}
