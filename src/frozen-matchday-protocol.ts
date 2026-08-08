import { canonicalJsonDigest } from './eval/serialization.js';
import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION, FrozenBattleRefereeError } from './frozen-battle-referee.js';
import {
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  type FrozenBetweenGameInput,
  FrozenMatchdayReferee,
  FrozenMatchdayRefereeError,
  type FrozenMatchdayRefereeOptions,
  type FrozenMatchdaySnapshot,
} from './frozen-matchday-referee.js';
import { showdownCommit } from './showdown.js';
import type { Pid } from './types.js';
import { isRecord } from './value.js';

export const FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION = 1 as const;

export interface FrozenMatchdayProtocolBinding {
  episodeId: string;
  conditionDigest: string;
  configDigest: string;
  showdownRevision: string;
  matchdayProtocolVersion: typeof FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION;
  battleProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
}

export interface FrozenMatchdayProtocolSnapshot {
  protocolVersion: typeof FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION;
  binding: FrozenMatchdayProtocolBinding;
  referee: FrozenMatchdaySnapshot;
  sha256: string;
}

export interface FrozenMatchdayProtocolResponse {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function pid(value: unknown): Pid {
  if (value !== 'p1' && value !== 'p2') throw new Error('pid must be p1 or p2');
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return Number(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function digest(value: unknown, name: string): string {
  const candidate = text(value, name);
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return candidate;
}

function protocolError(error: unknown): { code: string; message: string } {
  if (error instanceof FrozenMatchdayRefereeError || error instanceof FrozenBattleRefereeError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) };
}

function outerSnapshot(
  binding: FrozenMatchdayProtocolBinding,
  referee: FrozenMatchdayReferee,
): FrozenMatchdayProtocolSnapshot {
  const body = {
    protocolVersion: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
    binding: structuredClone(binding),
    referee: referee.snapshot(),
  };
  return { ...body, sha256: canonicalJsonDigest(body) };
}

export class FrozenMatchdayProtocolSession {
  readonly showdownRevision = showdownCommit();
  private referee: FrozenMatchdayReferee | undefined;
  private binding: FrozenMatchdayProtocolBinding | undefined;

  ready(): unknown {
    return {
      kind: 'ready',
      protocolVersion: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
      matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      showdownRevision: this.showdownRevision,
    };
  }

  handle(value: unknown): FrozenMatchdayProtocolResponse {
    const id = isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null;
    try {
      if (!isRecord(value)) throw new Error('request must be a JSON object');
      if (value.protocolVersion !== FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must be ${FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION}`);
      }
      const method = text(value.method, 'method');
      const params = value.params === undefined ? {} : value.params;
      if (!isRecord(params)) throw new Error('params must be a JSON object');
      return { id, ok: true, result: this.dispatch(method, params) };
    } catch (error) {
      return { id, ok: false, error: protocolError(error) };
    }
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    if (method === 'start') return this.start(params);
    if (method === 'restore') return this.restore(params);
    const referee = this.requireReferee();
    if (method === 'observe') return this.bound(referee.observe(pid(params.pid)));
    if (method === 'legal_actions') return this.bound(referee.legalActions(pid(params.pid)));
    if (method === 'submit') {
      return this.bound(
        referee.submit(
          pid(params.pid),
          text(params.command, 'command'),
          integer(params.expectedRevision, 'expectedRevision'),
          text(params.expectedStateHash, 'expectedStateHash'),
        ),
      );
    }
    if (method === 'ready_next_game') {
      let input: FrozenBetweenGameInput = {};
      if (Object.hasOwn(params, 'notebookReplacement')) {
        if (typeof params.notebookReplacement !== 'string') {
          throw new Error('notebookReplacement must be a string when supplied');
        }
        input = { notebookReplacement: params.notebookReplacement };
      }
      return this.bound(
        referee.readyNextGame(
          pid(params.pid),
          input,
          integer(params.expectedRevision, 'expectedRevision'),
          text(params.expectedStateHash, 'expectedStateHash'),
        ),
      );
    }
    if (method === 'snapshot') return outerSnapshot(this.requireBinding(), referee);
    if (method === 'terminal') return this.bound(referee.terminalEvidence());
    if (method === 'private_evidence') return this.bound(referee.seatPrivateEvidence(pid(params.pid)));
    throw new Error(`unknown method ${JSON.stringify(method)}`);
  }

  private start(params: Record<string, unknown>): unknown {
    if (this.referee) throw new Error('a referee is already active');
    const episodeId = text(params.episodeId, 'episodeId');
    const conditionDigest = digest(params.conditionDigest, 'conditionDigest');
    if (params.showdownRevision !== this.showdownRevision) {
      throw new Error(`showdownRevision must be ${this.showdownRevision}`);
    }
    if (!isRecord(params.options)) throw new Error('options must be a JSON object');
    const referee = new FrozenMatchdayReferee(
      structuredClone(params.options) as unknown as FrozenMatchdayRefereeOptions,
    );
    this.binding = {
      episodeId,
      conditionDigest,
      configDigest: referee.configDigest,
      showdownRevision: this.showdownRevision,
      matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
    };
    this.referee = referee;
    const snapshot = referee.snapshot();
    return this.bound({ started: true, revision: snapshot.revision, stateHash: snapshot.stateHash });
  }

  private restore(params: Record<string, unknown>): unknown {
    if (this.referee) throw new Error('a referee is already active');
    if (!isRecord(params.snapshot)) throw new Error('snapshot must be a JSON object');
    const snapshot = params.snapshot;
    if (
      snapshot.protocolVersion !== FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION ||
      !isRecord(snapshot.binding) ||
      !isRecord(snapshot.referee) ||
      typeof snapshot.sha256 !== 'string'
    ) {
      throw new Error('snapshot is incomplete or unsupported');
    }
    const body = {
      protocolVersion: snapshot.protocolVersion,
      binding: snapshot.binding,
      referee: snapshot.referee,
    };
    if (canonicalJsonDigest(body) !== snapshot.sha256) throw new Error('snapshot digest does not match its state');
    const binding = structuredClone(snapshot.binding) as unknown as FrozenMatchdayProtocolBinding;
    if (
      binding.showdownRevision !== this.showdownRevision ||
      binding.matchdayProtocolVersion !== FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION ||
      binding.battleProtocolVersion !== FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION ||
      typeof binding.episodeId !== 'string' ||
      !binding.episodeId ||
      typeof binding.conditionDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(binding.conditionDigest) ||
      typeof binding.configDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(binding.configDigest)
    ) {
      throw new Error('snapshot binding does not match this referee runtime');
    }
    const referee = FrozenMatchdayReferee.restore(
      structuredClone(snapshot.referee) as unknown as FrozenMatchdaySnapshot,
    );
    if (referee.configDigest !== binding.configDigest) {
      throw new Error('snapshot referee does not match its binding');
    }
    this.binding = binding;
    this.referee = referee;
    return this.bound({ restored: true });
  }

  private requireReferee(): FrozenMatchdayReferee {
    if (!this.referee || !this.binding) throw new Error('start or restore a referee first');
    return this.referee;
  }

  private requireBinding(): FrozenMatchdayProtocolBinding {
    if (!this.binding) throw new Error('start or restore a referee first');
    return this.binding;
  }

  private bound(value: unknown): unknown {
    return { binding: structuredClone(this.requireBinding()), value };
  }
}
