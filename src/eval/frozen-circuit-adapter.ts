import {
  FROZEN_CIRCUIT_SEAT_IDS,
  type FrozenCircuitPendingTurn,
  type FrozenCircuitPhase,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
  type FrozenCircuitSubmissionResult,
  type FrozenCircuitTerminalEvidence,
  type TurnReceipt,
} from '../frozen-circuit-model.js';
import { FrozenCircuitReferee } from '../frozen-circuit-referee.js';
import { sha256 } from '../frozen-circuit-setup.js';
import type { DecisionNode, StrategicStage } from './experiment-kernel.js';
import { canonicalJsonDigest } from './serialization.js';

export const FROZEN_CIRCUIT_ADAPTER_PROTOCOL = {
  version: 1,
  replay: 'private-turn-receipts-through-authoritative-referee-v1',
  checkpoint: 'before-one-receipt-with-authorized-observation-v1',
  fork: 'replace-target-response-drop-source-suffix-v1',
  continuation: 'strict-stop-on-first-unaccepted-or-defaulted-turn-v1',
  tolerantContinuation: 'advance-on-domain-defaults-v1',
} as const;

export type FrozenCircuitReplayReceipt = TurnReceipt & { response: string };

export interface FrozenCircuitStateProjection {
  phase: FrozenCircuitPhase;
  revision: number;
  stateHash: string;
  pendingDigest: string;
}

export interface FrozenCircuitReplayTranscript {
  protocolVersion: typeof FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version;
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  sourceConfigDigest: string;
  sourcePromptRevision: string;
  receipts: FrozenCircuitReplayReceipt[];
  expectedEnd: FrozenCircuitStateProjection;
  expectedTerminalDigest: string | null;
  transcriptDigest: string;
}

export interface FrozenCircuitCheckpoint {
  protocolVersion: typeof FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version;
  kind: 'before-receipt';
  sourceTranscriptDigest: string;
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  sourceConfigDigest: string;
  sourcePromptRevision: string;
  receiptIndex: number;
  prefixReceipts: FrozenCircuitReplayReceipt[];
  targetReceipt: FrozenCircuitReplayReceipt;
  targetTurn: FrozenCircuitPendingTurn;
  decisionNode: DecisionNode;
  preState: FrozenCircuitStateProjection;
  checkpointDigest: string;
}

export interface FrozenCircuitForkArtifact {
  protocolVersion: typeof FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version;
  sourceTranscriptDigest: string;
  sourceCheckpointDigest: string;
  decisionNode: DecisionNode;
  originalReceipt: FrozenCircuitReplayReceipt;
  replacementReceipt: FrozenCircuitReplayReceipt;
  postState: FrozenCircuitStateProjection;
  invalidatedSourceSuffixReceipts: number;
  sourceSuffixInvalidated: true;
  forkDigest: string;
}

export interface FrozenCircuitForkResult {
  referee: FrozenCircuitReferee;
  submission: FrozenCircuitSubmissionResult;
  artifact: FrozenCircuitForkArtifact;
}

export interface FrozenCircuitControllerContext {
  turn: FrozenCircuitPendingTurn;
  observation: ReturnType<FrozenCircuitReferee['observe']>;
  decisionIndex: number;
}

export interface FrozenCircuitContinuationController {
  respond(context: FrozenCircuitControllerContext): string | Promise<string>;
}

export interface FrozenCircuitContinuationControllers {
  controllerSetDigest: string;
  seats: Record<FrozenCircuitSeatId, FrozenCircuitContinuationController>;
}

export interface FrozenCircuitContinuationResult {
  protocolValid: boolean;
  accepted: boolean;
  diagnostic: string | null;
  receipts: FrozenCircuitReplayReceipt[];
  end: FrozenCircuitStateProjection;
  terminalEvidence: FrozenCircuitTerminalEvidence | null;
}

function transcriptBase(transcript: FrozenCircuitReplayTranscript) {
  const { transcriptDigest: _transcriptDigest, ...base } = transcript;
  return base;
}

function checkpointBase(checkpoint: FrozenCircuitCheckpoint) {
  const { checkpointDigest: _checkpointDigest, ...base } = checkpoint;
  return base;
}
function phase(referee: FrozenCircuitReferee): FrozenCircuitPhase {
  return referee.observe(FROZEN_CIRCUIT_SEAT_IDS[0]).phase;
}

function stateProjection(referee: FrozenCircuitReferee): FrozenCircuitStateProjection {
  const pending = referee.pendingTurns();
  const current = referee.currentState();
  return {
    phase: phase(referee),
    revision: current.revision,
    stateHash: current.stateHash,
    pendingDigest: canonicalJsonDigest(pending),
  };
}

function assertProjection(actual: FrozenCircuitStateProjection, expected: FrozenCircuitStateProjection): void {
  if (canonicalJsonDigest(actual) !== canonicalJsonDigest(expected)) {
    throw new Error('replayed circuit end state does not match the bound projection');
  }
}

function assertReceipt(receipt: FrozenCircuitReplayReceipt): void {
  if (typeof receipt.response !== 'string' || sha256(receipt.response) !== receipt.responseSha256) {
    throw new Error(`circuit receipt ${JSON.stringify(receipt.turnId)} response digest does not match`);
  }
  if (
    !receipt.turnId ||
    !receipt.seatId ||
    !receipt.kind ||
    !Number.isSafeInteger(receipt.attempt) ||
    receipt.attempt < 1
  ) {
    throw new Error('circuit replay receipt has invalid turn metadata');
  }
}

function assertTurnJoin(turn: FrozenCircuitPendingTurn, receipt: FrozenCircuitReplayReceipt): void {
  if (
    turn.turnId !== receipt.turnId ||
    turn.seatId !== receipt.seatId ||
    turn.kind !== receipt.kind ||
    turn.attempt !== receipt.attempt
  ) {
    throw new Error(`circuit receipt ${JSON.stringify(receipt.turnId)} does not join its pending turn`);
  }
}

function assertSubmissionJoin(result: FrozenCircuitSubmissionResult, receipt: FrozenCircuitReplayReceipt): void {
  if (
    result.accepted !== receipt.accepted ||
    result.advanced !== receipt.advanced ||
    result.defaulted !== receipt.defaulted ||
    result.diagnostic !== receipt.diagnostic
  ) {
    throw new Error(`circuit receipt ${JSON.stringify(receipt.turnId)} does not replay its submission result`);
  }
}

function newReferee(scenarioId: FrozenCircuitScenarioId, seed: number): FrozenCircuitReferee {
  return new FrozenCircuitReferee({
    scenarioId,
    episodeId: `strategic-replay:${scenarioId}:${seed}`,
    seed,
  });
}

function replaySequence(input: {
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  sourceConfigDigest: string;
  sourcePromptRevision: string;
  receipts: readonly FrozenCircuitReplayReceipt[];
}): FrozenCircuitReferee {
  const referee = newReferee(input.scenarioId, input.seed);
  if (referee.configDigest !== input.sourceConfigDigest || referee.promptRevision !== input.sourcePromptRevision) {
    throw new Error('circuit replay source identity does not match the current authoritative referee');
  }
  for (const receipt of input.receipts) {
    assertReceipt(receipt);
    const turn = referee.pendingTurns().find((entry) => entry.turnId === receipt.turnId);
    if (!turn) throw new Error(`circuit replay cannot find pending turn ${JSON.stringify(receipt.turnId)}`);
    assertTurnJoin(turn, receipt);
    const result = referee.submit(receipt.turnId, receipt.seatId, receipt.response);
    assertSubmissionJoin(result, receipt);
  }
  return referee;
}

function buildTranscript(input: {
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  sourceConfigDigest: string;
  sourcePromptRevision: string;
  receipts: readonly FrozenCircuitReplayReceipt[];
  expectedTerminalDigest: string | null;
}): FrozenCircuitReplayTranscript {
  const receipts = structuredClone([...input.receipts]);
  const referee = replaySequence({ ...input, receipts });
  const expectedEnd = stateProjection(referee);
  if (input.expectedTerminalDigest !== null) {
    const terminal = referee.terminalEvidence();
    if (!terminal || canonicalJsonDigest(terminal) !== input.expectedTerminalDigest) {
      throw new Error('circuit receipt transcript does not replay its bound terminal evidence');
    }
  }
  const base = {
    protocolVersion: FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version,
    scenarioId: input.scenarioId,
    seed: input.seed,
    sourceConfigDigest: input.sourceConfigDigest,
    sourcePromptRevision: input.sourcePromptRevision,
    receipts,
    expectedEnd,
    expectedTerminalDigest: input.expectedTerminalDigest,
  };
  return { ...base, transcriptDigest: canonicalJsonDigest(base) };
}

export function recordFrozenCircuitSubmission(
  referee: FrozenCircuitReferee,
  turn: FrozenCircuitPendingTurn,
  response: string,
): { receipt: FrozenCircuitReplayReceipt; result: FrozenCircuitSubmissionResult } {
  const result = referee.submit(turn.turnId, turn.seatId, response);
  return {
    receipt: {
      turnId: turn.turnId,
      seatId: turn.seatId,
      kind: turn.kind,
      attempt: turn.attempt,
      responseSha256: sha256(response),
      accepted: result.accepted,
      advanced: result.advanced,
      defaulted: result.defaulted,
      diagnostic: result.diagnostic,
      response,
    },
    result,
  };
}

export function buildFrozenCircuitReceiptTranscript(input: {
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  receipts: readonly FrozenCircuitReplayReceipt[];
}): FrozenCircuitReplayTranscript {
  const referee = newReferee(input.scenarioId, input.seed);
  return buildTranscript({
    scenarioId: input.scenarioId,
    seed: input.seed,
    sourceConfigDigest: referee.configDigest,
    sourcePromptRevision: referee.promptRevision,
    receipts: input.receipts,
    expectedTerminalDigest: null,
  });
}

export function buildFrozenCircuitTerminalTranscript(
  evidence: FrozenCircuitTerminalEvidence,
): FrozenCircuitReplayTranscript {
  const publicReceipts = evidence.summary.turnReceipts;
  const privateReceipts = evidence.privateEvidence.turnReceipts;
  if (
    publicReceipts.length !== privateReceipts.length ||
    publicReceipts.some((receipt, index) => {
      const { response: _response, ...privateReceipt } = privateReceipts[index]!;
      return canonicalJsonDigest(receipt) !== canonicalJsonDigest(privateReceipt);
    })
  ) {
    throw new Error('circuit terminal public and private receipt ledgers do not join');
  }
  const sourceDigest = canonicalJsonDigest(evidence);
  return buildTranscript({
    scenarioId: evidence.summary.scenarioId,
    seed: evidence.privateEvidence.derived.seed,
    sourceConfigDigest: evidence.summary.configDigest,
    sourcePromptRevision: evidence.summary.promptRevision,
    receipts: privateReceipts,
    expectedTerminalDigest: sourceDigest,
  });
}

export function replayFrozenCircuitTranscript(transcript: FrozenCircuitReplayTranscript): FrozenCircuitReferee {
  if (
    transcript.protocolVersion !== FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version ||
    canonicalJsonDigest(transcriptBase(transcript)) !== transcript.transcriptDigest
  ) {
    throw new Error('frozen circuit transcript digest does not match its contents');
  }
  const referee = replaySequence(transcript);
  assertProjection(stateProjection(referee), transcript.expectedEnd);
  if (transcript.expectedTerminalDigest !== null) {
    const terminal = referee.terminalEvidence();
    if (!terminal || canonicalJsonDigest(terminal) !== transcript.expectedTerminalDigest) {
      throw new Error('replayed circuit terminal digest does not match the transcript');
    }
  }
  return referee;
}

function stageFor(turn: FrozenCircuitPendingTurn): StrategicStage {
  if (turn.kind === 'draft') return 'draft';
  if (turn.kind === 'construction') return 'construction';
  if (turn.kind === 'action') return 'battle';
  if (turn.kind === 'notebook') return 'notebook';
  return 'trade';
}

function legalActionDigest(turn: FrozenCircuitPendingTurn): string {
  if (turn.kind === 'action') {
    const marker = 'AUTHORITY-ACCEPTED COMMANDS:\n';
    const offset = turn.prompt.lastIndexOf(marker);
    if (offset < 0) throw new Error('circuit battle turn does not expose its authority-accepted commands');
    let commands: unknown;
    try {
      commands = JSON.parse(turn.prompt.slice(offset + marker.length));
    } catch {
      throw new Error('circuit battle turn has an invalid authority-accepted command block');
    }
    if (!Array.isArray(commands) || !commands.length || commands.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new Error('circuit battle turn has an invalid authority-accepted action set');
    }
    return canonicalJsonDigest(commands);
  }
  if (turn.kind === 'trade_response') {
    return canonicalJsonDigest(['trade-response-action-space-v1', 'accept-boolean-with-optional-private-evidence']);
  }
  return canonicalJsonDigest(['prompt-defined-action-space-v1', turn.kind, turn.prompt]);
}

function decisionNode(input: {
  referee: FrozenCircuitReferee;
  transcript: FrozenCircuitReplayTranscript;
  prefixReceipts: readonly FrozenCircuitReplayReceipt[];
  target: FrozenCircuitPendingTurn;
}): DecisionNode {
  const observation = input.referee.observe(input.target.seatId);
  const { private: privateState, ...publicState } = observation;
  return {
    id: input.target.turnId,
    opportunityKey: `${input.transcript.scenarioId}:${input.transcript.seed}:${input.target.kind}:${input.target.turnId}`,
    stage: stageFor(input.target),
    actor: input.target.seatId,
    parentNodeId: input.prefixReceipts.at(-1)?.turnId ?? null,
    sourceEpisodeDigest: input.transcript.transcriptDigest,
    publicStateDigest: canonicalJsonDigest(publicState),
    privateStateDigest: canonicalJsonDigest(privateState),
    promptDigest: canonicalJsonDigest(input.target.prompt),
    legalActionDigest: legalActionDigest(input.target),
  };
}

export function buildFrozenCircuitCheckpoint(
  transcript: FrozenCircuitReplayTranscript,
  receiptIndex: number,
): FrozenCircuitCheckpoint {
  if (canonicalJsonDigest(transcriptBase(transcript)) !== transcript.transcriptDigest) {
    throw new Error('frozen circuit transcript digest does not match its contents');
  }
  if (!Number.isSafeInteger(receiptIndex) || receiptIndex < 0 || receiptIndex >= transcript.receipts.length) {
    throw new Error('circuit checkpoint receiptIndex must name one source receipt');
  }
  const prefixReceipts = structuredClone(transcript.receipts.slice(0, receiptIndex));
  const targetReceipt = structuredClone(transcript.receipts[receiptIndex]!);
  const referee = replaySequence({ ...transcript, receipts: prefixReceipts });
  const targetTurn = referee.pendingTurns().find((turn) => turn.turnId === targetReceipt.turnId);
  if (!targetTurn) throw new Error('circuit checkpoint target receipt is not pending after its source prefix');
  assertTurnJoin(targetTurn, targetReceipt);
  const preState = stateProjection(referee);
  const node = decisionNode({ referee, transcript, prefixReceipts, target: targetTurn });
  const base = {
    protocolVersion: FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version,
    kind: 'before-receipt' as const,
    sourceTranscriptDigest: transcript.transcriptDigest,
    scenarioId: transcript.scenarioId,
    seed: transcript.seed,
    sourceConfigDigest: transcript.sourceConfigDigest,
    sourcePromptRevision: transcript.sourcePromptRevision,
    receiptIndex,
    prefixReceipts,
    targetReceipt,
    targetTurn: structuredClone(targetTurn),
    decisionNode: node,
    preState,
  };
  return { ...base, checkpointDigest: canonicalJsonDigest(base) };
}

export function restoreFrozenCircuitCheckpoint(checkpoint: FrozenCircuitCheckpoint): FrozenCircuitReferee {
  if (
    checkpoint.protocolVersion !== FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version ||
    checkpoint.kind !== 'before-receipt' ||
    canonicalJsonDigest(checkpointBase(checkpoint)) !== checkpoint.checkpointDigest
  ) {
    throw new Error('frozen circuit checkpoint digest does not match its contents');
  }
  const referee = replaySequence({
    scenarioId: checkpoint.scenarioId,
    seed: checkpoint.seed,
    sourceConfigDigest: checkpoint.sourceConfigDigest,
    sourcePromptRevision: checkpoint.sourcePromptRevision,
    receipts: checkpoint.prefixReceipts,
  });
  assertProjection(stateProjection(referee), checkpoint.preState);
  const target = referee.pendingTurns().find((turn) => turn.turnId === checkpoint.targetReceipt.turnId);
  if (!target || canonicalJsonDigest(target) !== canonicalJsonDigest(checkpoint.targetTurn)) {
    throw new Error('restored circuit checkpoint does not reproduce its target turn');
  }
  return referee;
}

export function circuitResponseActionDigest(response: string): string {
  return canonicalJsonDigest(['raw-circuit-response-v1', response]);
}

export function forkFrozenCircuitCheckpoint(
  checkpoint: FrozenCircuitCheckpoint,
  replacementResponse: string,
  sourceReceiptCount: number,
): FrozenCircuitForkResult {
  if (!Number.isSafeInteger(sourceReceiptCount) || sourceReceiptCount <= checkpoint.receiptIndex) {
    throw new Error('sourceReceiptCount must include the checkpoint target and its suffix');
  }
  const referee = restoreFrozenCircuitCheckpoint(checkpoint);
  const target = referee.pendingTurns().find((turn) => turn.turnId === checkpoint.targetReceipt.turnId);
  if (!target) throw new Error('restored circuit fork target is not pending');
  const { receipt, result } = recordFrozenCircuitSubmission(referee, target, replacementResponse);
  const postState = stateProjection(referee);
  const base = {
    protocolVersion: FROZEN_CIRCUIT_ADAPTER_PROTOCOL.version,
    sourceTranscriptDigest: checkpoint.sourceTranscriptDigest,
    sourceCheckpointDigest: checkpoint.checkpointDigest,
    decisionNode: checkpoint.decisionNode,
    originalReceipt: checkpoint.targetReceipt,
    replacementReceipt: receipt,
    postState,
    invalidatedSourceSuffixReceipts: sourceReceiptCount - checkpoint.receiptIndex - 1,
    sourceSuffixInvalidated: true as const,
  };
  return {
    referee,
    submission: result,
    artifact: { ...base, forkDigest: canonicalJsonDigest(base) },
  };
}

export async function continueFrozenCircuitStrict(input: {
  referee: FrozenCircuitReferee;
  controllers: FrozenCircuitContinuationControllers;
  maxSubmissions?: number;
  /** Declared tolerant mode: domain defaults advance the circuit instead of aborting the arm. */
  tolerateDefaults?: boolean;
}): Promise<FrozenCircuitContinuationResult> {
  if (!/^[0-9a-f]{64}$/u.test(input.controllers.controllerSetDigest)) {
    throw new Error('circuit continuation controllerSetDigest must be a SHA-256 digest');
  }
  const maxSubmissions = input.maxSubmissions ?? 5_000;
  if (!Number.isSafeInteger(maxSubmissions) || maxSubmissions < 1) {
    throw new Error('circuit continuation maxSubmissions must be a positive integer');
  }
  const receipts: FrozenCircuitReplayReceipt[] = [];
  const decisions = new Map<FrozenCircuitSeatId, number>();
  for (let count = 0; count < maxSubmissions; ) {
    const terminal = input.referee.terminalEvidence();
    if (terminal) {
      return {
        protocolValid: true,
        accepted: true,
        diagnostic: null,
        receipts,
        end: stateProjection(input.referee),
        terminalEvidence: terminal,
      };
    }
    const turns = input.referee.pendingTurns();
    if (!turns.length) {
      return {
        protocolValid: false,
        accepted: false,
        diagnostic: 'nonterminal circuit produced no pending turns',
        receipts,
        end: stateProjection(input.referee),
        terminalEvidence: null,
      };
    }
    for (const turn of turns) {
      const controller = input.controllers.seats[turn.seatId];
      let response: string;
      try {
        response = await controller.respond({
          turn,
          observation: input.referee.observe(turn.seatId),
          decisionIndex: decisions.get(turn.seatId) ?? 0,
        });
      } catch (cause) {
        return {
          protocolValid: false,
          accepted: false,
          diagnostic: cause instanceof Error ? cause.message : String(cause),
          receipts,
          end: stateProjection(input.referee),
          terminalEvidence: null,
        };
      }
      if (typeof response !== 'string') {
        return {
          protocolValid: false,
          accepted: false,
          diagnostic: `${turn.seatId} controller returned a non-string response`,
          receipts,
          end: stateProjection(input.referee),
          terminalEvidence: null,
        };
      }
      const { receipt, result } = recordFrozenCircuitSubmission(input.referee, turn, response);
      receipts.push(receipt);
      decisions.set(turn.seatId, (decisions.get(turn.seatId) ?? 0) + 1);
      count += 1;
      if (!input.tolerateDefaults && (!result.accepted || result.defaulted)) {
        return {
          protocolValid: true,
          accepted: false,
          diagnostic: result.diagnostic ?? 'strict circuit continuation rejected one response',
          receipts,
          end: stateProjection(input.referee),
          terminalEvidence: null,
        };
      }
      if (result.terminal) break;
      if (!result.advanced) break;
      if (count >= maxSubmissions) break;
    }
  }
  return {
    protocolValid: false,
    accepted: false,
    diagnostic: `strict circuit continuation exceeded ${maxSubmissions} submissions`,
    receipts,
    end: stateProjection(input.referee),
    terminalEvidence: null,
  };
}
