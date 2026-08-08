import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  type FrozenBattleObservation,
  FrozenBattleReferee,
  FrozenBattleRefereeError,
  type FrozenBattleRefereeOptions,
  type FrozenBattleTerminalEvidence,
} from '../src/frozen-battle-referee.js';
import { TEAMS_DIR } from '../src/paths.js';
import type { Pid } from '../src/types.js';

const FORMAT = 'gen9championsvgc2026regmbbo3';
const SEED = [101, 202, 303, 404] as const;
const ATTACKERS = fs.readFileSync(path.join(TEAMS_DIR, 'test', 'jpnats-mega-swampert.team'), 'utf8').trim();
const TARGETS = fs.readFileSync(path.join(TEAMS_DIR, 'test', 'rios-mega-raichu-x-venusaur.team'), 'utf8').trim();

function options(names: readonly [string, string] = ['attacker', 'target']): FrozenBattleRefereeOptions {
  return {
    format: FORMAT,
    seed: SEED,
    seats: [
      { pid: 'p1', name: names[0], packedTeam: ATTACKERS },
      { pid: 'p2', name: names[1], packedTeam: TARGETS },
    ],
  };
}

function commandFor(referee: FrozenBattleReferee, pid: Pid): string {
  const legal = referee.legalActions(pid);
  assert.equal(legal.candidateScope, 'showdown-accepted-request-derived');
  assert.equal(legal.exhaustive, false);
  assert.ok(legal.actions.length > 0, `${pid} has an active request but no surfaced candidate`);
  return legal.actions[0]!.command;
}

function advanceDecision(referee: FrozenBattleReferee): void {
  const observations: Record<Pid, FrozenBattleObservation> = {
    p1: referee.observe('p1'),
    p2: referee.observe('p2'),
  };
  let submitted = 0;
  for (const pid of ['p1', 'p2'] as const) {
    const observation = observations[pid];
    if (!observation.request || observation.request.wait) continue;
    const command = commandFor(referee, pid);
    referee.submit(pid, command, observation.revision, observation.stateHash);
    submitted += 1;
  }
  assert.ok(submitted > 0, 'nonterminal battle must have an active decision');
}

function runToTerminal(referee: FrozenBattleReferee): FrozenBattleTerminalEvidence {
  for (let decisions = 0; decisions < 20; decisions += 1) {
    const evidence = referee.terminalEvidence();
    if (evidence) return evidence;
    advanceDecision(referee);
  }
  throw new Error('fixture battle did not terminate');
}

function assertRefereeError(code: FrozenBattleRefereeError['code']): (error: unknown) => boolean {
  return (error) => error instanceof FrozenBattleRefereeError && error.code === code;
}

test('same seed and submitted actions deterministically replay to the same terminal evidence', () => {
  const first = new FrozenBattleReferee(options());
  const second = new FrozenBattleReferee(options());
  assert.equal(first.observe('p1').stateHash, second.observe('p1').stateHash);

  const firstEvidence = runToTerminal(first);
  const secondEvidence = runToTerminal(second);
  assert.deepEqual(secondEvidence, firstEvidence);
});

test('simultaneous submissions remain secret until the joint decision advances', () => {
  const referee = new FrozenBattleReferee(options());
  const p1 = referee.observe('p1');
  const p2 = referee.observe('p2');
  assert.ok(p1.request?.teamPreview);
  assert.ok(p2.request?.teamPreview);

  const staged = referee.submit('p1', 'team 1234', p1.revision, p1.stateHash);
  assert.equal(staged.advanced, false);
  assert.equal(staged.revision, p1.revision);
  assert.equal(staged.stateHash, p1.stateHash);

  const p2After = referee.observe('p2');
  assert.equal(p2After.revision, p2.revision);
  assert.equal(p2After.stateHash, p2.stateHash);
  assert.deepEqual(p2After.request, p2.request);
  assert.deepEqual(p2After.povLines, []);
  assert.doesNotMatch(JSON.stringify(p2After), /team 1234|staged|pending/i);

  const advanced = referee.submit('p2', 'team 1234', p2.revision, p2.stateHash);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.revision, p2.revision + 1);
});

test('stale revision and hash submissions are rejected without mutation', () => {
  const referee = new FrozenBattleReferee(options());
  const p1 = referee.observe('p1');
  const p2 = referee.observe('p2');
  referee.submit('p1', 'team 1234', p1.revision, p1.stateHash);
  referee.submit('p2', 'team 1234', p2.revision, p2.stateHash);

  const beforeRevisionFailure = referee.snapshot();
  assert.throws(
    () => referee.submit('p1', 'move 1, move 1', p1.revision, p1.stateHash),
    assertRefereeError('stale-revision'),
  );
  assert.deepEqual(referee.snapshot(), beforeRevisionFailure);

  const current = referee.observe('p1');
  const beforeHashFailure = referee.snapshot();
  assert.throws(
    () => referee.submit('p1', 'move 1, move 1', current.revision, '0'.repeat(64)),
    assertRefereeError('stale-state'),
  );
  assert.deepEqual(referee.snapshot(), beforeHashFailure);
});

test('illegal and duplicate submissions are rejected without mutation', () => {
  const referee = new FrozenBattleReferee(options());
  const p1 = referee.observe('p1');
  const beforeIllegal = referee.snapshot();
  assert.throws(
    () => referee.submit('p1', 'not-a-showdown-choice', p1.revision, p1.stateHash),
    assertRefereeError('illegal-action'),
  );
  assert.deepEqual(referee.snapshot(), beforeIllegal);

  const legal = referee.legalActions('p1');
  assert.ok(legal.actions.some((entry) => entry.command === 'team 1234'));
  for (const entry of legal.actions) {
    const candidate = FrozenBattleReferee.restore(JSON.parse(JSON.stringify(beforeIllegal)));
    assert.doesNotThrow(() => candidate.submit('p1', entry.command, legal.revision, legal.stateHash));
  }

  referee.submit('p1', 'team 1234', p1.revision, p1.stateHash);
  const beforeDuplicate = referee.snapshot();
  assert.throws(
    () => referee.submit('p1', 'team 4321', p1.revision, p1.stateHash),
    assertRefereeError('duplicate-submission'),
  );
  assert.deepEqual(referee.snapshot(), beforeDuplicate);
});

test('routed observations preserve Showdown split secrecy for exact HP', () => {
  const referee = new FrozenBattleReferee(options());
  const preview: Record<Pid, FrozenBattleObservation> = {
    p1: referee.observe('p1'),
    p2: referee.observe('p2'),
  };
  referee.submit('p1', 'team 1234', preview.p1.revision, preview.p1.stateHash);
  referee.submit('p2', 'team 1234', preview.p2.revision, preview.p2.stateHash);

  const p1 = referee.observe('p1').povLines;
  const p2 = referee.observe('p2').povLines;
  assert.ok([...p1, ...p2].every((line) => !line.startsWith('|split|')));
  const privateSwitch = p1.find((line) => line.startsWith('|switch|p1a: Grimmsnarl|') && !line.endsWith('|100/100'));
  assert.ok(privateSwitch, 'p1 must receive its exact active HP');
  assert.ok(!p2.includes(privateSwitch), 'p2 must not receive p1 exact HP');
  assert.ok(p2.some((line) => line.startsWith('|switch|p1a: Grimmsnarl|') && line.endsWith('|100/100')));
});

test('a snapshot with one staged action restores the same mid-decision', () => {
  const original = new FrozenBattleReferee(options());
  const p1 = original.observe('p1');
  original.observe('p2');
  original.submit('p1', 'team 1234', p1.revision, p1.stateHash);

  const serialized = JSON.parse(JSON.stringify(original.snapshot())) as ReturnType<FrozenBattleReferee['snapshot']>;
  const restored = FrozenBattleReferee.restore(serialized);
  const originalP2 = original.observe('p2');
  const restoredP2 = restored.observe('p2');
  assert.deepEqual(restoredP2, originalP2);

  original.submit('p2', 'team 1234', originalP2.revision, originalP2.stateHash);
  restored.submit('p2', 'team 1234', restoredP2.revision, restoredP2.stateHash);
  assert.deepEqual(runToTerminal(restored), runToTerminal(original));
});

test('terminal evidence has authoritative result, turns, log, seed, and submitted actions', () => {
  const evidence = runToTerminal(new FrozenBattleReferee(options()));
  assert.deepEqual(evidence.seed, SEED);
  assert.equal(evidence.format, FORMAT);
  assert.equal(evidence.result.type, 'win');
  assert.ok(evidence.turns > 0);
  assert.ok(evidence.authoritativeLog.some((line) => line.startsWith('|win|')));
  assert.ok(evidence.authoritativeLog.every((line) => !line.startsWith('|t:|')));
  assert.ok(evidence.submittedActions.length > 0);
  assert.ok(evidence.submittedActions.every((action) => action.command.length > 0));
  assert.equal(evidence.submittedActions.at(-1)?.decisionRevision, evidence.submittedActions.at(-2)?.decisionRevision);
});

test('exact pid identity remains safe when both seat names are identical', () => {
  const evidence = runToTerminal(new FrozenBattleReferee(options(['same-model', 'same-model'])));
  assert.deepEqual(evidence.seats, [
    { pid: 'p1', name: 'same-model' },
    { pid: 'p2', name: 'same-model' },
  ]);
  assert.deepEqual(evidence.result, { type: 'win', winner: { pid: 'p1', name: 'same-model' } });
  assert.ok(evidence.submittedActions.some((action) => action.pid === 'p1'));
  assert.ok(evidence.submittedActions.some((action) => action.pid === 'p2'));
});
