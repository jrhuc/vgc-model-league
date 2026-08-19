import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFrozenCircuitCheckpoint,
  buildFrozenCircuitReceiptTranscript,
  circuitResponseActionDigest,
  continueFrozenCircuitStrict,
  type FrozenCircuitContinuationControllers,
  type FrozenCircuitReplayReceipt,
  forkFrozenCircuitCheckpoint,
  recordFrozenCircuitSubmission,
  replayFrozenCircuitTranscript,
  restoreFrozenCircuitCheckpoint,
} from '../src/eval/frozen-circuit-adapter.js';
import { FROZEN_CIRCUIT_SEAT_IDS, type FrozenCircuitPendingTurn } from '../src/frozen-circuit-model.js';
import { FrozenCircuitReferee } from '../src/frozen-circuit-referee.js';
import { canonicalJsonDigest } from '../src/serialization.js';

function draftIds(turn: FrozenCircuitPendingTurn): string[] {
  return [...turn.prompt.matchAll(/^- ([a-z0-9][a-z0-9-]*) \|/gmu)].map((match) => match[1]!);
}

function draftResponse(turn: FrozenCircuitPendingTurn, index: number): string {
  const ids = draftIds(turn);
  assert.ok(ids.length > index);
  return JSON.stringify({ pick: ids[index] });
}

function sourceReceipts(count: number): FrozenCircuitReplayReceipt[] {
  const referee = new FrozenCircuitReferee({
    scenarioId: 'draft-league-v1',
    episodeId: 'circuit-adapter-source',
    seed: 11,
  });
  const receipts: FrozenCircuitReplayReceipt[] = [];
  while (receipts.length < count) {
    const turns = referee.pendingTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.kind, 'draft');
    const recorded = recordFrozenCircuitSubmission(referee, turns[0]!, draftResponse(turns[0]!, 0));
    assert.equal(recorded.result.accepted, true);
    assert.equal(recorded.result.defaulted, false);
    receipts.push(recorded.receipt);
  }
  return receipts;
}

test('circuit receipt transcripts replay and checkpoint before one exact decision', () => {
  const receipts = sourceReceipts(3);
  const transcript = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts,
  });
  const replayed = replayFrozenCircuitTranscript(transcript);
  assert.equal(replayed.configDigest, transcript.sourceConfigDigest);
  assert.deepEqual(replayed.currentState(), {
    revision: transcript.expectedEnd.revision,
    stateHash: transcript.expectedEnd.stateHash,
  });

  const checkpoint = buildFrozenCircuitCheckpoint(transcript, 1);
  const restored = restoreFrozenCircuitCheckpoint(checkpoint);
  assert.deepEqual(restored.currentState(), {
    revision: checkpoint.preState.revision,
    stateHash: checkpoint.preState.stateHash,
  });
  assert.equal(checkpoint.decisionNode.stage, 'draft');
  assert.equal(checkpoint.decisionNode.id, receipts[1]!.turnId);
  assert.equal(checkpoint.decisionNode.parentNodeId, receipts[0]!.turnId);
  assert.equal(checkpoint.decisionNode.sourceEpisodeDigest, transcript.transcriptDigest);

  const tampered = structuredClone(transcript);
  tampered.receipts[0]!.response = 'tampered';
  assert.throws(() => replayFrozenCircuitTranscript(tampered), /transcript digest does not match/u);
});

test('circuit fork replaces one response and explicitly invalidates the source suffix', () => {
  const receipts = sourceReceipts(4);
  const transcript = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts,
  });
  const checkpoint = buildFrozenCircuitCheckpoint(transcript, 1);
  const alternative = draftResponse(checkpoint.targetTurn, 1);
  const fork = forkFrozenCircuitCheckpoint(checkpoint, alternative, transcript.receipts.length);
  assert.equal(fork.submission.accepted, true);
  assert.equal(fork.submission.defaulted, false);
  assert.equal(fork.artifact.sourceSuffixInvalidated, true);
  assert.equal(fork.artifact.invalidatedSourceSuffixReceipts, 2);
  assert.notEqual(fork.artifact.originalReceipt.responseSha256, fork.artifact.replacementReceipt.responseSha256);
  assert.equal(circuitResponseActionDigest(alternative), canonicalJsonDigest(['raw-circuit-response-v1', alternative]));

  const sourcePrefix = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts: receipts.slice(0, 2),
  });
  assert.notEqual(fork.artifact.postState.stateHash, sourcePrefix.expectedEnd.stateHash);
});

test('strict circuit continuation stops before a retry or deterministic fallback can shape utility', async () => {
  const receipts = sourceReceipts(2);
  const transcript = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts,
  });
  const checkpoint = buildFrozenCircuitCheckpoint(transcript, 1);
  const referee = restoreFrozenCircuitCheckpoint(checkpoint);
  const controller = { respond: () => 'not-json' };
  const controllers: FrozenCircuitContinuationControllers = {
    controllerSetDigest: canonicalJsonDigest({ policy: 'always-invalid' }),
    seats: Object.fromEntries(
      FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => [seatId, controller]),
    ) as unknown as FrozenCircuitContinuationControllers['seats'],
  };
  const result = await continueFrozenCircuitStrict({ referee, controllers, maxSubmissions: 10 });
  assert.equal(result.protocolValid, true);
  assert.equal(result.accepted, false);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.defaulted, false);
  assert.equal(result.receipts[0]!.attempt, 1);
  assert.equal(result.terminalEvidence, null);
});

test('strict circuit continuation records empty model output as domain-invalid evidence', async () => {
  const receipts = sourceReceipts(2);
  const transcript = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts,
  });
  const checkpoint = buildFrozenCircuitCheckpoint(transcript, 1);
  const referee = restoreFrozenCircuitCheckpoint(checkpoint);
  const controller = { respond: () => '' };
  const controllers: FrozenCircuitContinuationControllers = {
    controllerSetDigest: canonicalJsonDigest({ policy: 'empty-response' }),
    seats: Object.fromEntries(
      FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => [seatId, controller]),
    ) as unknown as FrozenCircuitContinuationControllers['seats'],
  };
  const result = await continueFrozenCircuitStrict({ referee, controllers, maxSubmissions: 10 });
  assert.equal(result.protocolValid, true);
  assert.equal(result.accepted, false);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.response, '');
  assert.equal(result.receipts[0]!.accepted, false);
  assert.equal(result.receipts[0]!.defaulted, false);

  const replayable = buildFrozenCircuitReceiptTranscript({
    scenarioId: checkpoint.scenarioId,
    seed: checkpoint.seed,
    receipts: [...checkpoint.prefixReceipts, ...result.receipts],
  });
  assert.equal(replayable.receipts.at(-1)?.response, '');
  replayFrozenCircuitTranscript(replayable);
});
