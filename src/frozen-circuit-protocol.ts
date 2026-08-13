import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION, FrozenBattleRefereeError } from './frozen-battle-referee.js';
import {
  FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_SCENARIOS,
  FrozenCircuitReferee,
  FrozenCircuitRefereeError,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
} from './frozen-circuit-referee.js';
import { FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION, FrozenMatchdayRefereeError } from './frozen-matchday-referee.js';
import { showdownCommit } from './showdown.js';
import { isRecord } from './value.js';

export const FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION = 1 as const;

export interface FrozenCircuitProtocolBinding {
  episodeId: string;
  conditionDigest: string;
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  configDigest: string;
  showdownRevision: string;
  jsonlProtocolVersion: typeof FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION;
  circuitProtocolVersion: typeof FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION;
  promptProtocolVersion: typeof FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION;
  matchdayProtocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  battleProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
  promptRevision: string;
}

export interface FrozenCircuitProtocolResponse {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(', ') || 'no fields'}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function digest(value: unknown, name: string): string {
  const candidate = text(value, name);
  if (!/^[0-9a-f]{64}$/u.test(candidate)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return candidate;
}

function rawResponse(value: unknown): string {
  if (typeof value !== 'string') throw new Error('response must be a string');
  return value;
}

function seatId(value: unknown): FrozenCircuitSeatId {
  if (typeof value !== 'string' || !/^seat-[1-8]$/u.test(value))
    throw new Error('seatId must be seat-1 through seat-8');
  return value as FrozenCircuitSeatId;
}

function seed(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('seed must be a non-negative safe integer');
  return Number(value);
}

function protocolError(error: unknown): { code: string; message: string } {
  if (
    error instanceof FrozenCircuitRefereeError ||
    error instanceof FrozenMatchdayRefereeError ||
    error instanceof FrozenBattleRefereeError
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) };
}

export class FrozenCircuitProtocolSession {
  readonly showdownRevision = showdownCommit();
  private referee: FrozenCircuitReferee | undefined;
  private binding: FrozenCircuitProtocolBinding | undefined;

  ready(): unknown {
    return {
      kind: 'ready',
      protocolVersion: FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION,
      circuitProtocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
      promptProtocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
      matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      showdownRevision: this.showdownRevision,
      scenarios: [...FROZEN_CIRCUIT_SCENARIOS],
    };
  }

  handle(value: unknown): FrozenCircuitProtocolResponse {
    const id = isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null;
    try {
      if (!isRecord(value)) throw new Error('request must be a JSON object');
      exactKeys(value, ['id', 'method', 'params', 'protocolVersion'], 'request');
      if (value.protocolVersion !== FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must be ${FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION}`);
      }
      const method = text(value.method, 'method');
      if (!isRecord(value.params)) throw new Error('params must be a JSON object');
      return { id, ok: true, result: this.dispatch(method, value.params) };
    } catch (error) {
      return { id, ok: false, error: protocolError(error) };
    }
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    if (method === 'start') return this.start(params);
    const referee = this.requireReferee();
    if (method === 'observe') {
      exactKeys(params, ['seatId'], 'observe params');
      return this.bound(referee.observe(seatId(params.seatId)));
    }
    if (method === 'pending_turns') {
      exactKeys(params, [], 'pending_turns params');
      return this.bound(referee.pendingTurns());
    }
    if (method === 'submit') {
      exactKeys(params, ['response', 'seatId', 'turnId'], 'submit params');
      return this.bound(
        referee.submit(text(params.turnId, 'turnId'), seatId(params.seatId), rawResponse(params.response)),
      );
    }
    if (method === 'terminal') {
      exactKeys(params, [], 'terminal params');
      return this.bound(referee.terminalEvidence());
    }
    throw new Error(`unknown method ${JSON.stringify(method)}`);
  }

  private start(params: Record<string, unknown>): unknown {
    exactKeys(params, ['conditionDigest', 'episodeId', 'options', 'showdownRevision'], 'start params');
    if (this.referee) throw new Error('a referee is already active');
    const episodeId = text(params.episodeId, 'episodeId');
    const conditionDigest = digest(params.conditionDigest, 'conditionDigest');
    if (params.showdownRevision !== this.showdownRevision) {
      throw new Error(`showdownRevision must be ${this.showdownRevision}`);
    }
    if (!isRecord(params.options)) throw new Error('options must be a JSON object');
    exactKeys(params.options, ['scenarioId', 'seed'], 'start options');
    const scenario = params.options.scenarioId;
    if (!FROZEN_CIRCUIT_SCENARIOS.includes(scenario as FrozenCircuitScenarioId)) {
      throw new Error(`scenarioId must be one of ${FROZEN_CIRCUIT_SCENARIOS.join(', ')}`);
    }
    const derivedSeed = seed(params.options.seed);
    const referee = new FrozenCircuitReferee({
      scenarioId: scenario as FrozenCircuitScenarioId,
      episodeId,
      seed: derivedSeed,
    });
    this.binding = {
      episodeId,
      conditionDigest,
      scenarioId: referee.scenarioId,
      seed: referee.seed,
      configDigest: referee.configDigest,
      showdownRevision: this.showdownRevision,
      jsonlProtocolVersion: FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION,
      circuitProtocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
      promptProtocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
      matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      promptRevision: referee.promptRevision,
    };
    this.referee = referee;
    return this.bound({ started: true, ...referee.currentState() });
  }

  private requireReferee(): FrozenCircuitReferee {
    if (!this.referee || !this.binding) throw new Error('start a referee first');
    return this.referee;
  }

  private requireBinding(): FrozenCircuitProtocolBinding {
    if (!this.binding) throw new Error('start a referee first');
    return this.binding;
  }

  private bound(value: unknown): unknown {
    return { binding: structuredClone(this.requireBinding()), value };
  }
}
