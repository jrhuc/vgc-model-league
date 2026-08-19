import {
  FROZEN_CIRCUIT_SEAT_IDS,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
  type FrozenCircuitTerminalEvidence,
  type FrozenCircuitTurnKind,
} from '../frozen-circuit-model.js';
import { type FrozenCircuitPendingTurn, FrozenCircuitReferee } from '../frozen-circuit-referee.js';
import {
  buildFrozenCircuitCheckpoint,
  continueFrozenCircuitStrict,
  type FrozenCircuitCheckpoint,
  type FrozenCircuitContinuationController,
  type FrozenCircuitContinuationControllers,
  type FrozenCircuitReplayTranscript,
  type FrozenCircuitStateProjection,
  forkFrozenCircuitCheckpoint,
  recordFrozenCircuitSubmission,
  type FrozenCircuitReplayReceipt,
} from './frozen-circuit-adapter.js';
import type { DecisionNode } from './experiment-kernel.js';
import { canonicalJsonDigest } from './serialization.js';

export const FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL = {
  version: 1,
  selection: 'pending-trade-receipt-indices-v1',
  actionIdentity: 'parsed-trade-content-digest-v1',
  matching: 'identical-terms-and-private-evidence-message-only-v1',
  horizons: {
    response: 'counterparty-response-decision-v1',
    terminal: 'terminal-utility-default-tolerant-continuation-v1',
  },
  syntheticSource: 'default-driver-first-command-null-transactions-v1',
} as const;

export type TradeForkHorizon = keyof typeof FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.horizons;

/**
 * The declared synthetic source policy: every seat plays the first authority-accepted
 * command, drafts and constructions fall to referee defaults, and the source trade
 * window is entirely null, so every trade node is reachable and outcome-blind.
 */
export function completeDefaultDrivenCircuit(
  scenarioId: FrozenCircuitScenarioId,
  seed: number,
): FrozenCircuitTerminalEvidence {
  const referee = new FrozenCircuitReferee({
    scenarioId,
    episodeId: `trade-fork-source:${scenarioId}:${seed}`,
    seed,
  });
  let submissions = 0;
  while (!referee.terminalEvidence() && submissions < 20_000) {
    for (const turn of referee.pendingTurns()) {
      const result = referee.submit(turn.turnId, turn.seatId, defaultDriverResponse(turn));
      submissions += 1;
      if (result.terminal) break;
      if (!result.advanced) break;
    }
  }
  const terminal = referee.terminalEvidence();
  if (!terminal) throw new Error('default-driven circuit source did not reach a terminal state');
  return terminal;
}

function defaultDriverResponse(turn: FrozenCircuitPendingTurn): string {
  if (turn.kind === 'action') {
    const marker = 'AUTHORITY-ACCEPTED COMMANDS:\n';
    const offset = turn.prompt.lastIndexOf(marker);
    if (offset < 0) throw new Error('circuit battle turn does not expose its authority-accepted commands');
    const commands = JSON.parse(turn.prompt.slice(offset + marker.length)) as string[];
    const first = commands[0];
    if (!first) throw new Error('circuit battle turn has an empty authority-accepted command set');
    return first;
  }
  if (turn.kind === 'trade_offer') return '{"offer":null}';
  if (turn.kind === 'trade_response') return '{"accept":false}';
  if (turn.kind === 'free_agency') return '{"swaps":[]}';
  if (turn.kind === 'draft' || turn.kind === 'construction') return 'default';
  return '{}';
}

export function defaultDriverContinuationControllers(): FrozenCircuitContinuationControllers {
  const controller: FrozenCircuitContinuationController = {
    respond: ({ turn }) => defaultDriverResponse(turn),
  };
  return {
    controllerSetDigest: canonicalJsonDigest([
      'default-driver-continuation-v1',
      FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.syntheticSource,
    ]),
    seats: Object.fromEntries(FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => [seatId, controller])) as Record<
      FrozenCircuitSeatId,
      FrozenCircuitContinuationController
    >,
  };
}

export const CIRCUIT_TRADE_TURN_KINDS = ['trade_offer', 'trade_response', 'free_agency'] as const;

export type CircuitTradeTurnKind = (typeof CIRCUIT_TRADE_TURN_KINDS)[number];

export interface FrozenCircuitTradeNode {
  receiptIndex: number;
  turnId: string;
  seatId: FrozenCircuitSeatId;
  kind: CircuitTradeTurnKind;
  accepted: boolean;
  defaulted: boolean;
}

export function selectFrozenCircuitTradeReceipts(
  transcript: FrozenCircuitReplayTranscript,
  kinds: readonly CircuitTradeTurnKind[] = CIRCUIT_TRADE_TURN_KINDS,
): FrozenCircuitTradeNode[] {
  const wanted = new Set<FrozenCircuitTurnKind>(kinds);
  return transcript.receipts.flatMap((receipt, receiptIndex) =>
    wanted.has(receipt.kind)
      ? [
          {
            receiptIndex,
            turnId: receipt.turnId,
            seatId: receipt.seatId,
            kind: receipt.kind as CircuitTradeTurnKind,
            accepted: receipt.accepted,
            defaulted: receipt.defaulted,
          },
        ]
      : [],
  );
}

/** Two responses that parse to the same content are the same trade action regardless of byte layout. */
export function circuitTradeActionDigest(kind: CircuitTradeTurnKind, response: string): string {
  try {
    const parsed = JSON.parse(response) as unknown;
    return canonicalJsonDigest(['parsed-trade-content-v1', kind, parsed]);
  } catch {
    return canonicalJsonDigest(['unparsed-trade-response-v1', kind, response]);
  }
}

export interface MatchedTradeOfferArm {
  id: string;
  label: string;
  response: string;
}

interface ParsedOfferShape {
  offer: { to: number; give: string; get: string; message: string };
  reasoning: string | undefined;
  notebook: string | undefined;
}

function parsedOfferShape(armId: string, response: string): ParsedOfferShape {
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    throw new Error(`trade offer arm ${armId} response is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`trade offer arm ${armId} response must be one JSON object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['offer', 'reasoning', 'notebook']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`trade offer arm ${armId} response has keys outside offer, reasoning, notebook`);
  }
  const offer = record.offer;
  if (typeof offer !== 'object' || offer === null || Array.isArray(offer)) {
    throw new Error(`trade offer arm ${armId} must contain a non-null offer object`);
  }
  const terms = offer as Record<string, unknown>;
  if (
    typeof terms.to !== 'number' ||
    typeof terms.give !== 'string' ||
    typeof terms.get !== 'string' ||
    typeof terms.message !== 'string'
  ) {
    throw new Error(`trade offer arm ${armId} offer must bind numeric to and string give, get, message`);
  }
  return {
    offer: { to: terms.to, give: terms.give, get: terms.get, message: terms.message },
    reasoning: record.reasoning as string | undefined,
    notebook: record.notebook as string | undefined,
  };
}

/**
 * The matched contract: every arm proposes the identical material trade with identical private
 * evidence, so the public message bytes are the only intervention.
 */
export function assertMatchedTradeOfferArms(arms: readonly MatchedTradeOfferArm[]): string {
  if (arms.length < 2) throw new Error('matched trade offer forks need at least two arms');
  const ids = new Set<string>();
  for (const arm of arms) {
    if (!arm.id || !arm.label) throw new Error('matched trade offer arm needs non-empty id and label');
    if (ids.has(arm.id)) throw new Error(`matched trade offer forks repeat arm ${JSON.stringify(arm.id)}`);
    ids.add(arm.id);
  }
  const shapes = arms.map((arm) => ({ arm, shape: parsedOfferShape(arm.id, arm.response) }));
  const first = shapes[0] as (typeof shapes)[number];
  const invariant = (shape: ParsedOfferShape) => ({
    to: shape.offer.to,
    give: shape.offer.give,
    get: shape.offer.get,
    reasoning: shape.reasoning ?? null,
    notebook: shape.notebook ?? null,
  });
  const matchedDigest = canonicalJsonDigest([FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.matching, invariant(first.shape)]);
  for (const { arm, shape } of shapes.slice(1)) {
    if (canonicalJsonDigest([FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.matching, invariant(shape)]) !== matchedDigest) {
      throw new Error(`trade offer arm ${arm.id} changes terms or private evidence, not only the message`);
    }
  }
  return matchedDigest;
}

export interface MatchedTradeOfferForkOutcome {
  armId: string;
  label: string;
  offerActionDigest: string;
  forkDigest: string;
  offerAccepted: boolean;
  responderTurnId: string | null;
  responderPromptDigest: string | null;
  responderReceipt: FrozenCircuitReplayReceipt | null;
  responderAccepted: boolean | null;
  protocolValid: boolean;
  diagnostic: string | null;
  postState: FrozenCircuitStateProjection;
  terminal: {
    reached: boolean;
    terminalDigest: string | null;
    proposerReturn: number | null;
    responderReturn: number | null;
    continuationReceipts: number;
    continuationDefaults: number;
    diagnostic: string | null;
  } | null;
}

export interface MatchedTradeOfferForkReport {
  protocolVersion: typeof FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.version;
  horizon: (typeof FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.horizons)[TradeForkHorizon];
  sourceTranscriptDigest: string;
  sourceCheckpointDigest: string;
  decisionNode: DecisionNode;
  matchedTermsDigest: string;
  responderControllerId: string;
  continuationControllerId: string | null;
  originalOfferActionDigest: string;
  arms: MatchedTradeOfferArm[];
  outcomes: MatchedTradeOfferForkOutcome[];
  reportDigest: string;
}

function parsedResponderAccept(response: string): boolean | null {
  try {
    const parsed = JSON.parse(response) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const accept = (parsed as Record<string, unknown>).accept;
    return typeof accept === 'boolean' ? accept : null;
  } catch {
    return null;
  }
}

/**
 * One arm = one replacement offer; the measured decision is the counterparty's single
 * accept-or-reject under the regenerated response prompt at matched pre-offer state.
 */
export async function runMatchedTradeOfferForks(input: {
  checkpoint: FrozenCircuitCheckpoint;
  arms: readonly MatchedTradeOfferArm[];
  responder: FrozenCircuitContinuationController;
  responderControllerId: string;
  sourceReceiptCount: number;
  horizon?: TradeForkHorizon;
  continuation?: {
    controllers: FrozenCircuitContinuationControllers;
    controllerId: string;
    maxSubmissions?: number;
  };
}): Promise<MatchedTradeOfferForkReport> {
  if (input.checkpoint.targetTurn.kind !== 'trade_offer') {
    throw new Error('matched trade offer forks require a checkpoint at a trade_offer receipt');
  }
  if (!input.responderControllerId) throw new Error('matched trade offer forks need a responder controller id');
  const horizon = input.horizon ?? 'response';
  if (horizon === 'terminal' && !input.continuation) {
    throw new Error('terminal-horizon trade forks need declared continuation controllers');
  }
  const matchedTermsDigest = assertMatchedTradeOfferArms(input.arms);
  const outcomes: MatchedTradeOfferForkOutcome[] = [];
  for (const arm of input.arms) {
    const fork = forkFrozenCircuitCheckpoint(input.checkpoint, arm.response, input.sourceReceiptCount);
    const offerActionDigest = circuitTradeActionDigest('trade_offer', arm.response);
    const failure = (diagnostic: string): MatchedTradeOfferForkOutcome => ({
      armId: arm.id,
      label: arm.label,
      offerActionDigest,
      forkDigest: fork.artifact.forkDigest,
      offerAccepted: fork.submission.accepted && !fork.submission.defaulted,
      responderTurnId: null,
      responderPromptDigest: null,
      responderReceipt: null,
      responderAccepted: null,
      protocolValid: false,
      diagnostic,
      postState: fork.artifact.postState,
      terminal: null,
    });
    if (!fork.submission.accepted || fork.submission.defaulted) {
      outcomes.push(failure(fork.submission.diagnostic ?? 'replacement offer was not accepted'));
      continue;
    }
    const pending = fork.referee.pendingTurns();
    const responseTurn = pending.find((turn) => turn.kind === 'trade_response');
    if (!responseTurn || pending.length !== 1) {
      outcomes.push(failure('accepted replacement offer did not produce exactly one pending trade response'));
      continue;
    }
    let responderBytes: string;
    try {
      responderBytes = await input.responder.respond({
        turn: responseTurn,
        observation: fork.referee.observe(responseTurn.seatId),
        decisionIndex: 0,
      });
    } catch (cause) {
      outcomes.push(failure(cause instanceof Error ? cause.message : String(cause)));
      continue;
    }
    const { receipt, result } = recordFrozenCircuitSubmission(fork.referee, responseTurn, responderBytes);
    const accepted = result.accepted && !result.defaulted;
    let terminal: MatchedTradeOfferForkOutcome['terminal'] = null;
    if (horizon === 'terminal' && accepted && input.continuation) {
      const continuation = await continueFrozenCircuitStrict({
        referee: fork.referee,
        controllers: input.continuation.controllers,
        tolerateDefaults: true,
        ...(input.continuation.maxSubmissions === undefined
          ? {}
          : { maxSubmissions: input.continuation.maxSubmissions }),
      });
      const evidence = continuation.terminalEvidence;
      const seatReturn = (seatId: FrozenCircuitSeatId): number | null =>
        evidence?.summary.perSeat.find((seat) => seat.seatId === seatId)?.reward.value ?? null;
      terminal = {
        reached: evidence !== null,
        terminalDigest: evidence === null ? null : canonicalJsonDigest(evidence),
        proposerReturn: seatReturn(input.checkpoint.targetTurn.seatId),
        responderReturn: seatReturn(responseTurn.seatId),
        continuationReceipts: continuation.receipts.length,
        continuationDefaults: continuation.receipts.filter((entry) => entry.defaulted).length,
        diagnostic: continuation.diagnostic,
      };
    }
    outcomes.push({
      armId: arm.id,
      label: arm.label,
      offerActionDigest,
      forkDigest: fork.artifact.forkDigest,
      offerAccepted: true,
      responderTurnId: responseTurn.turnId,
      responderPromptDigest: canonicalJsonDigest(responseTurn.prompt),
      responderReceipt: receipt,
      responderAccepted: accepted ? parsedResponderAccept(receipt.response) : null,
      protocolValid: accepted && (horizon !== 'terminal' || terminal?.reached === true),
      diagnostic: accepted
        ? horizon === 'terminal' && terminal?.reached !== true
          ? (terminal?.diagnostic ?? 'terminal continuation did not finish')
          : null
        : (result.diagnostic ?? 'responder reply was not accepted'),
      postState: {
        phase: fork.artifact.postState.phase,
        revision: fork.referee.currentState().revision,
        stateHash: fork.referee.currentState().stateHash,
        pendingDigest: canonicalJsonDigest(fork.referee.pendingTurns()),
      },
      terminal,
    });
  }
  const base = {
    protocolVersion: FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.version,
    horizon: FROZEN_CIRCUIT_TRADE_FORK_PROTOCOL.horizons[horizon],
    sourceTranscriptDigest: input.checkpoint.sourceTranscriptDigest,
    sourceCheckpointDigest: input.checkpoint.checkpointDigest,
    decisionNode: input.checkpoint.decisionNode,
    matchedTermsDigest,
    responderControllerId: input.responderControllerId,
    continuationControllerId: input.continuation?.controllerId ?? null,
    originalOfferActionDigest: circuitTradeActionDigest('trade_offer', input.checkpoint.targetReceipt.response),
    arms: structuredClone([...input.arms]),
    outcomes,
  };
  return { ...base, reportDigest: canonicalJsonDigest(base) };
}

export function buildFrozenCircuitTradeCheckpoint(
  transcript: FrozenCircuitReplayTranscript,
  node: FrozenCircuitTradeNode,
): FrozenCircuitCheckpoint {
  const checkpoint = buildFrozenCircuitCheckpoint(transcript, node.receiptIndex);
  if (checkpoint.targetTurn.kind !== node.kind) {
    throw new Error('selected trade node does not join its checkpoint target turn');
  }
  return checkpoint;
}
