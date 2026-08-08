import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { BattleStream } from 'pokemon-showdown';
import { RandomEngine } from '../src/battle-agent.js';
import { buildMenus, type SlotMenu } from '../src/choices.js';
import { defaultPsDir } from '../src/paths.js';
import { RecoveryGate } from '../src/recovery.js';
import { runRotation } from '../src/rotation.js';
import { closedSheetsFormat } from '../src/series.js';
import type { RoomBattleTimerSettings } from '../src/showdown.js';
import { finishUpdateRouting, routeUpdateLines, SimBattle } from '../src/sim.js';
import { BattleState } from '../src/state.js';
import { loadPool } from '../src/teams.js';
import { parseTimerScale, TimerAdapter } from '../src/timer.js';
import type { BattleRequest, TimerScale } from '../src/types.js';

test('forced-switch menus retain the neutral forfeit option', () => {
  const menus = buildMenus({
    forceSwitch: [true],
    side: {
      pokemon: [
        { active: true, condition: '0 fnt', details: 'Garchomp, L50' },
        { active: false, condition: '100/100', details: 'Incineroar, L50' },
      ],
    },
  });
  assert.ok(menus[0]?.some((item) => item.kind === 'switch'));
  assert.ok(menus[0]?.some((item) => item.kind === 'forfeit'));
});

test('the forfeit menu option concedes the game to the opponent', async () => {
  const pool = loadPool();
  class ConcedingEngine extends RandomEngine {
    protected override decideJoint(menus: SlotMenu[]): number[] {
      const forfeit = menus[0]?.findIndex((item) => item.kind === 'forfeit') ?? -1;
      if (forfeit >= 0) return menus.map((_, slot) => (slot === 0 ? forfeit : 0));
      return super.decideJoint(menus);
    }
  }
  const battle = new SimBattle(
    pool.format,
    {
      p1: { name: 'A-conceder', team: pool.teams[0]!.packed },
      p2: { name: 'B-random', team: pool.teams[1]!.packed },
    },
    [1, 2, 3, 4],
  );
  const outcome = await battle.run({ p1: new ConcedingEngine('p1', 10), p2: new RandomEngine('p2', 20) });
  assert.equal(outcome.winner, 'B-random', 'the conceding side loses immediately');
  assert.deepEqual(outcome.errors, { p1: 0, p2: 0 });
});

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

test('three rejected simulator commands cause one simulator substitution and no model fallback', async () => {
  const pool = loadPool();
  class RejectedCommandAgent extends RandomEngine {
    calls = 0;

    override act(): Promise<string> {
      this.calls += 1;
      return Promise.resolve(this.calls <= 3 ? 'invalid' : 'forfeit');
    }

    override decisionStats(): Record<string, number> {
      return { fallbacks: 0 };
    }
  }
  const rejecting = new RejectedCommandAgent('p1', 1);
  const outcome = await new SimBattle(
    pool.format,
    {
      p1: { name: 'A-rejected', team: pool.teams[0]!.packed },
      p2: { name: 'B-deterministic', team: pool.teams[1]!.packed },
    },
    [31, 32, 33, 34],
  ).run({ p1: rejecting, p2: new RandomEngine('p2', 2) });

  assert.equal(rejecting.calls, 4);
  assert.equal(outcome.winner, 'B-deterministic');
  assert.deepEqual(outcome.errors, { p1: 3, p2: 0 });
  assert.deepEqual(outcome.simulatorSubstitutions, { p1: 1, p2: 0 });
  assert.equal(rejecting.decisionStats().fallbacks, 0);
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

test('recovery pause time is not charged to an invalid-choice retry', async () => {
  const pool = loadPool();
  const firstChoice = Promise.withResolvers<string>();
  const firstRequestStarted = Promise.withResolvers<void>();
  const retryReceived = Promise.withResolvers<void>();
  let firstTimer: BattleRequest['timer'];
  let retryTimer: BattleRequest['timer'];
  class PausedInvalidAgent extends RandomEngine {
    private calls = 0;

    override act(request: BattleRequest): Promise<string> {
      this.calls += 1;
      if (this.calls === 1) {
        firstTimer = request.timer;
        firstRequestStarted.resolve();
        return firstChoice.promise;
      }
      retryTimer = request.timer;
      retryReceived.resolve();
      return Promise.resolve('forfeit');
    }
  }
  let clock = 1_000;
  const recovery = new RecoveryGate();
  const battle = new SimBattle(
    `${pool.format}@@@!!timermaxfirstturn=60,!!timermaxperturn=60`,
    {
      p1: { name: 'A-paused', team: pool.teams[0]!.packed },
      p2: { name: 'B-deterministic', team: pool.teams[1]!.packed },
    },
    [41, 42, 43, 44],
    undefined,
    1,
    () => clock,
  ).run({ p1: new PausedInvalidAgent('p1', 1), p2: new RandomEngine('p2', 2) }, undefined, undefined, recovery);

  await firstRequestStarted.promise;
  clock += 4_000;
  const paused = recovery.pause('fake:paused', { kind: 'rate_limit', summary: 'controlled pause' });
  clock += 3_600_000;
  assert.equal(recovery.resume(), true);
  await paused;
  clock += 3_000;
  firstChoice.resolve('invalid');
  await retryReceived.promise;
  await battle;

  assert.ok(firstTimer?.seconds !== undefined && firstTimer.turnSeconds !== undefined);
  assert.ok(retryTimer?.seconds !== undefined && retryTimer.turnSeconds !== undefined);
  assert.equal(retryTimer.seconds, firstTimer.seconds - 7);
  assert.equal(retryTimer.turnSeconds, firstTimer.turnSeconds - 7);
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
  finishUpdateRouting(buffered);
  assert.deepEqual(buffered.pov.p1, ['|secret', '|after']);
  assert.deepEqual(buffered.pov.p2, ['|public', '|after']);
  assert.deepEqual(buffered.publicLog, ['|public', '|after']);
});

test('split messages reject an unknown owner without routing either payload', () => {
  const state = {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null,
    turns: 0,
  };
  assert.throws(() => routeUpdateLines(['|split|p3', '|secret', '|public'], state), /unknown split owner: p3/);
  assert.deepEqual(state.pov, { p1: [], p2: [] });
  assert.deepEqual(state.log, []);
  assert.deepEqual(state.publicLog, []);
});

test('stream termination rejects an incomplete split triple', () => {
  const state = {
    pov: { p1: [] as string[], p2: [] as string[] },
    log: [] as string[],
    publicLog: [] as string[],
    pendingSplit: [] as string[],
    winner: null,
    turns: 0,
  };
  routeUpdateLines(['|split|p2', '|secret'], state);
  assert.throws(() => finishUpdateRouting(state), /incomplete split triple \(2 of 3 lines\)/);
  assert.deepEqual(state.pov, { p1: [], p2: [] });
  assert.deepEqual(state.log, []);
  assert.deepEqual(state.publicLog, []);
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
