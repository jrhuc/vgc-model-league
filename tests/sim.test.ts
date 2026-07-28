import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { BattleStream } from 'pokemon-showdown';
import { RandomEngine } from '../src/battle-agent.js';
import { defaultPsDir } from '../src/paths.js';
import { runRotation } from '../src/rotation.js';
import { closedSheetsFormat } from '../src/series.js';
import type { RoomBattleTimerSettings } from '../src/showdown.js';
import { routeUpdateLines, SimBattle } from '../src/sim.js';
import { BattleState } from '../src/state.js';
import { loadPool } from '../src/teams.js';
import { parseTimerScale, TimerAdapter } from '../src/timer.js';
import type { BattleRequest, TimerScale } from '../src/types.js';

test('seeded random VGC battle completes untimed by default without protocol errors', async () => {
  const pool = loadPool();
  const battle = new SimBattle(
    pool.format,
    {
      p1: { name: 'A-random', team: pool.teams[0]!.packed },
      p2: { name: 'B-random', team: pool.teams[1]!.packed },
    },
    [1, 2, 3, 4],
  );
  const timers: unknown[] = [];
  class TimerSpy extends RandomEngine {
    override act(request: BattleRequest, context: { povLines: string[]; error?: string }): Promise<string> {
      timers.push(request.timer);
      return super.act(request, context);
    }
  }
  const outcome = await battle.run({ p1: new TimerSpy('p1', 10), p2: new RandomEngine('p2', 20) });
  assert.ok(timers.length > 0);
  assert.ok(timers.every((timer) => timer === undefined));
  assert.ok(outcome.winner === 'A-random' || outcome.winner === 'B-random' || outcome.winner === null);
  assert.ok(outcome.turns > 0);
  assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
  assert.ok(![...outcome.pov.p1, ...outcome.pov.p2].some((line) => line.startsWith('|split|')));
  const state = new BattleState('p1');
  state.feed(outcome.pov.p1);
  assert.equal(state.turn, outcome.turns);
  assert.match(state.render({}), /Opponent side/);
});

test('closed sheets strip the open-team-sheet rules while the stock format keeps them', async () => {
  const pool = loadPool();
  const players = {
    p1: { name: 'A-random', team: pool.teams[0]!.packed },
    p2: { name: 'B-random', team: pool.teams[1]!.packed },
  };
  const open = await new SimBattle(pool.format, players, [1, 2, 3, 4]).run({
    p1: new RandomEngine('p1', 10),
    p2: new RandomEngine('p2', 20),
  });
  assert.ok(
    open.log.some((line) => line.startsWith('|showteam|')),
    'the stock Champions Bo3 format publishes team sheets',
  );

  const stripped = closedSheetsFormat(pool.format, defaultPsDir());
  assert.match(stripped, /@@@!Force Open Team Sheets/);
  const closed = await new SimBattle(stripped, players, [1, 2, 3, 4]).run({
    p1: new RandomEngine('p1', 10),
    p2: new RandomEngine('p2', 20),
  });
  assert.ok(
    closed.log.every((line) => !line.startsWith('|showteam|')),
    'closed sheets publish nothing at team preview',
  );
  assert.ok(closed.turns > 0);
  assert.deepEqual(closed.errors, { p1: 0, p2: 0 });
});

test('Showdown timer defaults a slow decision', { timeout: 25_000 }, async () => {
  const pool = loadPool();
  class SlowEngine extends RandomEngine {
    private slow = true;
    override async act(request: BattleRequest, context: { povLines: string[]; error?: string }): Promise<string> {
      if (this.slow) {
        this.slow = false;
        await delay(11_000);
      }
      return super.act(request, context);
    }
  }
  const battle = new SimBattle(
    `${pool.format}@@@!!timermaxfirstturn=10,!!timermaxperturn=10`,
    {
      p1: { name: 'A-slow', team: pool.teams[0]!.packed },
      p2: { name: 'B-random', team: pool.teams[1]!.packed },
    },
    [9, 10, 11, 12],
    undefined,
    1,
  );
  const outcome = await battle.run({ p1: new SlowEngine('p1', 1), p2: new RandomEngine('p2', 2) });
  assert.ok(outcome.timerAutodefaults.p1 >= 1);
  assert.ok(outcome.pov.p1.includes('|timer|autodefault'));
});

test('timer scale multiplies Showdown timer settings and reseeds the banks', () => {
  const pool = loadPool();
  const stream = { write: () => {} } as unknown as BattleStream;
  const events = () => {};
  const adapter = (scale: TimerScale) =>
    new TimerAdapter(pool.format, stream, events, defaultPsDir(), scale) as unknown as {
      timer: { settings: RoomBattleTimerSettings };
      players: Array<{ secondsLeft?: number; turnSecondsLeft?: number }>;
    };
  const base = adapter(1);
  const scaled = adapter(1.5);
  for (const key of ['starting', 'grace', 'maxPerTurn', 'maxFirstTurn'] as const) {
    assert.equal(
      scaled.timer.settings[key],
      Math.max(5, Math.round((base.timer.settings[key] * 1.5) / 5) * 5),
      `${key} scales`,
    );
  }
  assert.equal(scaled.timer.settings.addPerTurn, base.timer.settings.addPerTurn, 'zero addPerTurn stays zero');
  const bank = scaled.timer.settings.starting + scaled.timer.settings.grace;
  for (const player of scaled.players) assert.equal(player.secondsLeft, bank);
  assert.ok(scaled.timer.settings.starting > base.timer.settings.starting);
});

test('recovery restores a timed request to its turn-start clock', () => {
  const pool = loadPool();
  const stream = { write: () => {} } as unknown as BattleStream;
  const adapter = new TimerAdapter(pool.format, stream, () => {}, defaultPsDir(), 0.5) as unknown as {
    receive(message: string): string;
    pauseForRecovery(): string[];
    resumeAfterRecovery(): string[];
    end(): void;
    players: Array<{ secondsLeft?: number; turnSecondsLeft?: number }>;
  };
  const received = adapter.receive('sideupdate\np1\n|request|{"active":[]}');
  const request = JSON.parse(received.split('\n')[2]!.slice(9)) as {
    timer: { seconds: number; turnSeconds: number };
  };
  adapter.players[0]!.secondsLeft! -= 20;
  adapter.players[0]!.turnSecondsLeft! -= 20;

  assert.deepEqual(adapter.pauseForRecovery(), ['|-vgctimerstop|p1']);
  assert.equal(adapter.players[0]!.secondsLeft, request.timer.seconds);
  assert.equal(adapter.players[0]!.turnSecondsLeft, request.timer.turnSeconds);
  assert.deepEqual(adapter.resumeAfterRecovery(), [
    `|-vgctimer|p1|${request.timer.seconds}|${request.timer.turnSeconds}`,
  ]);
  adapter.end();
});

test('parseTimerScale accepts multipliers and off, rejects everything else', () => {
  assert.equal(parseTimerScale(undefined), undefined);
  assert.equal(parseTimerScale(''), undefined);
  assert.equal(parseTimerScale(1.5), 1.5);
  assert.equal(parseTimerScale('2'), 2);
  assert.equal(parseTimerScale('off'), 'off');
  assert.equal(parseTimerScale('untimed'), 'off');
  assert.throws(() => parseTimerScale(0.1), /timer scale must be/);
  assert.throws(() => parseTimerScale(9), /timer scale must be/);
  assert.throws(() => parseTimerScale('fast'), /timer scale must be/);
});

test('aborting a battle interrupts timer waits and abandons pending decisions', { timeout: 2_000 }, async () => {
  const pool = loadPool();
  const started = Promise.withResolvers<void>();
  const never = Promise.withResolvers<string>().promise;
  let abandoned = false;
  class HangingEngine extends RandomEngine {
    override act(): Promise<string> {
      started.resolve();
      return never;
    }

    override abandonDecision(): void {
      abandoned = true;
    }
  }
  const controller = new AbortController();
  const pending = new SimBattle(
    pool.format,
    {
      p1: { name: 'A-hanging', team: pool.teams[0]!.packed },
      p2: { name: 'B-random', team: pool.teams[1]!.packed },
    },
    [13, 14, 15, 16],
  ).run({ p1: new HangingEngine('p1', 1), p2: new RandomEngine('p2', 2) }, undefined, controller.signal);
  await started.promise;
  controller.abort(new Error('stop requested'));
  await assert.rejects(pending, /stop requested/);
  assert.equal(abandoned, true);
});

test('players can decide concurrently', async () => {
  const pool = loadPool();
  const bothStarted = Promise.withResolvers<void>();
  let started = 0;
  class ConcurrentEngine extends RandomEngine {
    private first = true;
    override async act(request: BattleRequest, context: { povLines: string[]; error?: string }): Promise<string> {
      if (this.first) {
        this.first = false;
        started += 1;
        if (started === 2) bothStarted.resolve();
        await bothStarted.promise;
      }
      return super.act(request, context);
    }
  }
  const outcome = await new SimBattle(
    pool.format,
    {
      p1: { name: 'A', team: pool.teams[0]!.packed },
      p2: { name: 'B', team: pool.teams[1]!.packed },
    },
    [5, 6, 7, 8],
  ).run({ p1: new ConcurrentEngine('p1', 1), p2: new ConcurrentEngine('p2', 2) });
  assert.ok(outcome.turns > 0);
});

test('split messages route secrets and buffer incomplete triples', () => {
  const state = {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null,
    turns: 0,
  };
  routeUpdateLines(['|foo', '|split|p1', '|secret', '', '|bar'], state);
  assert.deepEqual(state.pov.p1, ['|foo', '|secret', '|bar']);
  assert.deepEqual(state.pov.p2, ['|foo', '|bar']);
  assert.deepEqual(state.publicLog, ['|foo', '|bar']);
  const buffered = {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null,
    turns: 0,
  };
  routeUpdateLines(['|split|p1', '|secret'], buffered);
  assert.deepEqual(buffered.pendingSplit, ['|split|p1', '|secret']);
  routeUpdateLines(['|public', '|after'], buffered);
  assert.deepEqual(buffered.pov.p1, ['|secret', '|after']);
  assert.deepEqual(buffered.pov.p2, ['|public', '|after']);
  assert.deepEqual(buffered.publicLog, ['|public', '|after']);
});

test('Rotation writes one completed best-of-three record', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-run-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const rows = await runRotation(['random', 'random'], 1, path.join(directory, 'run'), {
    seed: 1,
    concurrency: 1,
    recordsPath: records,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.run_seed, 1);
  assert.equal(rows[0]!.mode, 'rotation');
  assert.equal(rows[0]!.protocol_version, 1);
  assert.ok(Array.isArray(rows[0]!.games));
  assert.ok((rows[0]!.games as unknown[]).length >= 2);
  assert.equal(fs.readFileSync(records, 'utf8').trim().split('\n').length, 1);
});
