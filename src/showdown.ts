import { createRequire } from 'node:module';
import path from 'node:path';

import type { BattleStream, Dex, Teams, TeamValidator } from 'pokemon-showdown';

import { defaultPsDir } from './paths.js';

export interface ShowdownApi {
  BattleStream: typeof BattleStream;
  Dex: typeof Dex;
  Teams: typeof Teams;
  TeamValidator: typeof TeamValidator;
}

const requireFromHere = createRequire(import.meta.url);
const cache = new Map<string, ShowdownApi>();

export function loadShowdown(psDir = defaultPsDir()): ShowdownApi {
  const resolved = path.resolve(psDir);
  const existing = cache.get(resolved);
  if (existing) return existing;
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

export interface RoomBattleTimer {
  start(): boolean;
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
