import type { BattleStream } from 'pokemon-showdown';
import { defaultPsDir } from './paths.js';
import type { RecoveryGate } from './recovery.js';
import { loadShowdown } from './showdown.js';
import type { TimerEvent } from './timer.js';
import { DEFAULT_TIMER_SCALE, TimerAdapter } from './timer.js';
import type { BattleAgent, BattleOutcome, BattleRequest, Pid, PlayerOptions, TimerScale } from './types.js';

interface RouteState {
  pov: Record<Pid, string[]>;
  log: string[];
  publicLog: string[];
  pendingSplit: string[];
  winner: string | null;
  turns: number;
}

export function routeUpdateLines(lines: string[], state: RouteState): void {
  if (state.pendingSplit.length) {
    lines = [...state.pendingSplit, ...lines];
    state.pendingSplit.length = 0;
  }
  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (line.startsWith('|split|')) {
      if (index + 2 >= lines.length) {
        state.pendingSplit.push(...lines.slice(index));
        return;
      }
      const owner = line.split('|', 3)[2] as Pid;
      const secret = lines[index + 1]!;
      const publicLine = lines[index + 2]!;
      if (owner === 'p1' || owner === 'p2') {
        state.pov[owner].push(secret);
        state.log.push(secret);
        if (publicLine) state.publicLog.push(publicLine);
        if (publicLine) state.pov[owner === 'p1' ? 'p2' : 'p1'].push(publicLine);
      }
      index += 3;
      continue;
    }
    state.pov.p1.push(line);
    state.pov.p2.push(line);
    state.log.push(line);
    state.publicLog.push(line);
    if (line.startsWith('|turn|')) state.turns = Number(line.slice(6));
    else if (line.startsWith('|win|')) state.winner = line.slice(5);
    else if (line === '|tie') state.winner = null;
    index += 1;
  }
}

interface PendingAction {
  token: symbol;
  promise: Promise<ActionEvent>;
}

interface ActionEvent {
  kind: 'action';
  pid: Pid;
  token: symbol;
  choice?: string;
  error?: unknown;
}

interface StreamEvent {
  kind: 'stream';
  message: string | null;
}

function streamEvent(stream: BattleStream): Promise<StreamEvent> {
  return stream.read().then((message) => ({ kind: 'stream', message: message ?? null }));
}

export class SimBattle {
  readonly seed?: [number, number, number, number];
  readonly psDir: string;

  constructor(
    readonly format: string,
    readonly players: Record<Pid, PlayerOptions>,
    seed?: number | [number, number, number, number],
    psDir = defaultPsDir(),
    private readonly timerScale: TimerScale = DEFAULT_TIMER_SCALE,
  ) {
    this.psDir = psDir;
    if (Array.isArray(seed)) {
      this.seed = seed;
    } else if (seed !== undefined) {
      let value = BigInt.asUintN(64, BigInt(seed));
      const parts = Array.from({ length: 4 }, () => {
        value = BigInt.asUintN(64, value * 6364136223846793005n + 1442695040888963407n);
        return Number((value >> 16n) & 0xffffn);
      });
      this.seed = parts as [number, number, number, number];
    }
  }

  async run(
    agents: Record<Pid, BattleAgent>,
    onUpdate?: (lines: string[], publicLines: string[]) => void,
    signal?: AbortSignal,
    recovery?: RecoveryGate,
  ): Promise<BattleOutcome> {
    const { BattleStream } = loadShowdown(this.psDir);
    const stream = new BattleStream({ noCatch: true }) as BattleStream;
    const state: RouteState = {
      pov: { p1: [], p2: [] },
      log: [],
      publicLog: [],
      pendingSplit: [],
      winner: null,
      turns: 0,
    };
    const povCursor: Record<Pid, number> = { p1: 0, p2: 0 };
    const errors: Record<Pid, number> = { p1: 0, p2: 0 };
    const fallbacks: Record<Pid, number> = { p1: 0, p2: 0 };
    const lastRequest: Record<Pid, BattleRequest | undefined> = { p1: undefined, p2: undefined };
    const requestAt: Record<Pid, number> = { p1: 0, p2: 0 };
    const retryCount: Record<Pid, number> = { p1: 0, p2: 0 };
    const pendingError: Record<Pid, string | undefined> = { p1: undefined, p2: undefined };
    const suppressRequest: Record<Pid, boolean> = { p1: false, p2: false };
    const pending = new Map<Pid, PendingAction>();
    signal?.throwIfAborted();
    let abortPromise: Promise<never> | undefined;
    let onAbort: (() => void) | undefined;
    if (signal) {
      const aborted = Promise.withResolvers<never>();
      abortPromise = aborted.promise;
      onAbort = () => aborted.reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const route = (lines: string[]) => {
      const before = state.log.length;
      const publicBefore = state.publicLog.length;
      routeUpdateLines(lines, state);
      if (onUpdate && (state.log.length > before || state.publicLog.length > publicBefore)) {
        onUpdate(state.log.slice(before), state.publicLog.slice(publicBefore));
      }
    };

    const timerEvent = (pid: Pid, event: TimerEvent) => {
      const action = pending.get(pid);
      if (action) {
        pending.delete(pid);
        agents[pid].abandonDecision?.();
      }
      if (event === 'autodefault') fallbacks[pid] += 1;
      const line = `|timer|${event}`;
      state.pov[pid].push(line);
      state.log.push(line);
      const spectatorLine = `|-vgctimeout|${pid}|${event}`;
      onUpdate?.([spectatorLine], [spectatorLine]);
    };

    const start: Record<string, unknown> = { formatid: this.format };
    if (this.seed) start.seed = this.seed;
    stream.write(`>start ${JSON.stringify(start)}`);
    for (const pid of ['p1', 'p2'] as const) stream.write(`>player ${pid} ${JSON.stringify(this.players[pid])}`);
    const timer = new TimerAdapter(this.format, stream, timerEvent, this.psDir, this.timerScale);
    for (const pid of ['p1', 'p2'] as const) timer.setPlayer(pid, this.players[pid].name);
    const recoveryChanged = (paused: boolean) => {
      const lines = paused ? timer.pauseForRecovery() : timer.resumeAfterRecovery();
      if (lines.length) onUpdate?.(lines, lines);
    };
    const removeRecoveryListener = recovery?.onChange((pause) => recoveryChanged(Boolean(pause)));
    if (recovery?.paused) recoveryChanged(true);

    const schedule = (pid: Pid, request: BattleRequest, error?: string) => {
      if (pending.has(pid)) throw new Error(`received another request while ${pid} is still deciding`);
      const elapsed = error && request.timer ? (performance.now() - requestAt[pid]) / 1000 : 0;
      const currentRequest =
        request.timer && elapsed > 0
          ? {
              ...request,
              timer: {
                ...(request.timer.seconds === undefined
                  ? {}
                  : { seconds: Math.max(0, request.timer.seconds - elapsed) }),
                ...(request.timer.turnSeconds === undefined
                  ? {}
                  : { turnSeconds: Math.max(0, request.timer.turnSeconds - elapsed) }),
              },
            }
          : request;
      if (currentRequest.timer) {
        const line = `|-vgctimer|${pid}|${currentRequest.timer.seconds ?? ''}|${currentRequest.timer.turnSeconds ?? ''}`;
        onUpdate?.([line], [line]);
      } else {
        const line = `|-vgcdeciding|${pid}`;
        onUpdate?.([line], [line]);
      }
      const lines = state.pov[pid].slice(povCursor[pid]);
      povCursor[pid] = state.pov[pid].length;
      const token = Symbol(pid);
      let action: Promise<string>;
      try {
        action = Promise.resolve(agents[pid].act(currentRequest, { povLines: lines, ...(error ? { error } : {}) }));
      } catch (caught) {
        action = Promise.reject(caught);
      }
      const promise = action.then<ActionEvent, ActionEvent>(
        (choice) => ({ kind: 'action', pid, token, choice }),
        (caught) => ({ kind: 'action', pid, token, error: caught }),
      );
      pending.set(pid, { token, promise });
    };

    const handleSideUpdate = (lines: string[]) => {
      const pid = lines[0] as Pid;
      if (pid !== 'p1' && pid !== 'p2') return;
      for (const line of lines.slice(1)) {
        if (line.startsWith('|error|')) {
          errors[pid] += 1;
          retryCount[pid] += 1;
          pendingError[pid] = line;
          if (retryCount[pid] >= 3) {
            void Promise.resolve(timer.choose(pid, 'default')).catch(() => {});
            const stopLine = `|-vgctimerstop|${pid}`;
            onUpdate?.([stopLine], [stopLine]);
            fallbacks[pid] += 1;
            suppressRequest[pid] = line.includes('[Unavailable choice]');
            pendingError[pid] = undefined;
          } else if (!line.includes('[Unavailable choice]') && lastRequest[pid]) {
            schedule(pid, lastRequest[pid], line);
            pendingError[pid] = undefined;
          }
        } else if (line.startsWith('|request|')) {
          const payload = line.slice(9);
          if (!payload) continue;
          const request = JSON.parse(payload) as BattleRequest;
          lastRequest[pid] = request;
          requestAt[pid] = performance.now();
          if (suppressRequest[pid]) {
            suppressRequest[pid] = false;
            continue;
          }
          const error = pendingError[pid];
          if (!error) retryCount[pid] = 0;
          pendingError[pid] = undefined;
          if (!request.wait) schedule(pid, request, error);
        }
      }
    };

    let ended = false;
    let nextStream = streamEvent(stream);
    try {
      while (!ended) {
        const candidates: Array<Promise<StreamEvent | ActionEvent>> = [
          nextStream,
          ...[...pending.values()].map((item) => item.promise),
        ];
        if (abortPromise) candidates.push(abortPromise);
        let idleTimer: NodeJS.Timeout | undefined;
        if (!pending.size) {
          const { promise, resolve } = Promise.withResolvers<StreamEvent | ActionEvent>();
          idleTimer = setTimeout(() => resolve({ kind: 'stream', message: null }), 60_000);
          candidates.push(promise);
        }
        const event = await Promise.race(candidates);
        clearTimeout(idleTimer);
        if (event.kind === 'action') {
          const current = pending.get(event.pid);
          if (!current || current.token !== event.token) continue;
          pending.delete(event.pid);
          if (event.error !== undefined) throw event.error;
          await timer.choose(event.pid, event.choice ?? '');
          const stopLine = `|-vgctimerstop|${event.pid}`;
          onUpdate?.([stopLine], [stopLine]);
          continue;
        }
        if (event.message === null) throw new Error('simulator produced no output for 60 seconds');
        nextStream = streamEvent(stream);
        const message = timer.receive(event.message);
        const lines = message.split('\n');
        if (lines[0] === 'update') route(lines.slice(1));
        else if (lines[0] === 'sideupdate') handleSideUpdate(lines.slice(1));
        else if (lines[0] === 'end') {
          if (lines[1]) {
            const data = JSON.parse(lines.slice(1).join('\n')) as { winner?: string; turns?: number };
            state.winner = data.winner || state.winner;
            state.turns = data.turns ?? state.turns;
          }
          ended = true;
        } else if (lines[0]?.startsWith('|')) route(lines);
      }
    } finally {
      timer.end();
      removeRecoveryListener?.();
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      await stream.writeEnd();
      for (const pid of pending.keys()) agents[pid].abandonDecision?.();
      pending.clear();
    }

    for (const pid of ['p1', 'p2'] as const) {
      const remaining = state.pov[pid].slice(povCursor[pid]);
      if (remaining.length) await agents[pid].observe(remaining);
    }
    return { winner: state.winner, turns: state.turns, log: state.log, pov: state.pov, errors, fallbacks };
  }
}
