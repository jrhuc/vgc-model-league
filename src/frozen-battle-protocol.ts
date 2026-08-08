import crypto from 'node:crypto';

import { canonicalJsonDigest } from './eval/serialization.js';
import {
  FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
  FrozenBattleReferee,
  FrozenBattleRefereeError,
  type FrozenBattleRefereeOptions,
  type FrozenBattleSnapshot,
} from './frozen-battle-referee.js';
import { showdownCommit } from './showdown.js';
import type { Pid } from './types.js';
import { isRecord } from './value.js';

export const FROZEN_BATTLE_JSONL_PROTOCOL_VERSION = 1 as const;

export interface FrozenBattleProtocolBinding {
  episodeId: string;
  conditionDigest: string;
  configDigest: string;
  showdownRevision: string;
  refereeProtocolVersion: typeof FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION;
}

export interface FrozenBattleProtocolSnapshot {
  protocolVersion: typeof FROZEN_BATTLE_JSONL_PROTOCOL_VERSION;
  binding: FrozenBattleProtocolBinding;
  referee: FrozenBattleSnapshot;
  sha256: string;
}

export interface FrozenBattleProtocolResponse {
  id: string | number | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function digestOptions(options: FrozenBattleRefereeOptions): string {
  const seats = [...options.seats]
    .sort((left, right) => left.pid.localeCompare(right.pid))
    .map((seat) => ({
      pid: seat.pid,
      name: seat.name,
      teamSha256: crypto.createHash('sha256').update(seat.packedTeam).digest('hex'),
    }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ format: options.format, seed: [...options.seed], seats }))
    .digest('hex');
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

function protocolError(error: unknown): { code: string; message: string } {
  if (error instanceof FrozenBattleRefereeError) return { code: error.code, message: error.message };
  return { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) };
}

export class FrozenBattleProtocolSession {
  readonly showdownRevision: string;
  private referee: FrozenBattleReferee | undefined;
  private binding: FrozenBattleProtocolBinding | undefined;

  constructor(showdownRevision = showdownCommit()) {
    this.showdownRevision = showdownRevision;
  }

  ready(): unknown {
    return {
      kind: 'ready',
      protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
      refereeProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      showdownRevision: this.showdownRevision,
    };
  }

  handle(value: unknown): FrozenBattleProtocolResponse {
    const id = isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value.id : null;
    try {
      if (!isRecord(value)) throw new Error('request must be a JSON object');
      if (value.protocolVersion !== FROZEN_BATTLE_JSONL_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion must be ${FROZEN_BATTLE_JSONL_PROTOCOL_VERSION}`);
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
    if (method === 'snapshot') {
      const snapshot = JSON.parse(
        JSON.stringify({
          protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
          binding: this.binding,
          referee: referee.snapshot(),
        }),
      ) as Omit<FrozenBattleProtocolSnapshot, 'sha256'>;
      return { ...snapshot, sha256: canonicalJsonDigest(snapshot) } satisfies FrozenBattleProtocolSnapshot;
    }
    if (method === 'terminal') return this.bound(referee.terminalEvidence());
    throw new Error(`unknown method ${JSON.stringify(method)}`);
  }

  private start(params: Record<string, unknown>): unknown {
    if (this.referee) throw new Error('a referee is already active');
    const episodeId = text(params.episodeId, 'episodeId');
    const conditionDigest = text(params.conditionDigest, 'conditionDigest');
    if (!/^[0-9a-f]{64}$/.test(conditionDigest)) throw new Error('conditionDigest must be a lowercase SHA-256 digest');
    if (params.showdownRevision !== this.showdownRevision) {
      throw new Error(`showdownRevision must be ${this.showdownRevision}`);
    }
    const options = params.options;
    if (!isRecord(options)) throw new Error('options must be a JSON object');
    const refereeOptions = structuredClone(options) as unknown as FrozenBattleRefereeOptions;
    const referee = new FrozenBattleReferee(refereeOptions);
    this.binding = {
      episodeId,
      conditionDigest,
      configDigest: digestOptions(refereeOptions),
      showdownRevision: this.showdownRevision,
      refereeProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
    };
    this.referee = referee;
    const snapshot = referee.snapshot();
    return this.bound({ started: true, revision: snapshot.revision, stateHash: snapshot.stateHash });
  }

  private restore(params: Record<string, unknown>): unknown {
    if (this.referee) throw new Error('a referee is already active');
    const snapshot = params.snapshot;
    if (!isRecord(snapshot) || snapshot.protocolVersion !== FROZEN_BATTLE_JSONL_PROTOCOL_VERSION) {
      throw new Error('snapshot protocol is not supported');
    }
    if (!isRecord(snapshot.binding) || !isRecord(snapshot.referee) || typeof snapshot.sha256 !== 'string') {
      throw new Error('snapshot is incomplete');
    }
    const snapshotBody = {
      protocolVersion: snapshot.protocolVersion,
      binding: snapshot.binding,
      referee: snapshot.referee,
    };
    if (canonicalJsonDigest(snapshotBody) !== snapshot.sha256)
      throw new Error('snapshot digest does not match its state');
    const binding = structuredClone(snapshot.binding) as unknown as FrozenBattleProtocolBinding;
    if (
      binding.showdownRevision !== this.showdownRevision ||
      binding.refereeProtocolVersion !== FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION ||
      typeof binding.episodeId !== 'string' ||
      !binding.episodeId ||
      !/^[0-9a-f]{64}$/.test(binding.conditionDigest) ||
      !/^[0-9a-f]{64}$/.test(binding.configDigest)
    ) {
      throw new Error('snapshot binding does not match this referee runtime');
    }
    const refereeSnapshot = structuredClone(snapshot.referee) as unknown as FrozenBattleSnapshot;
    const expectedDigest = digestOptions(refereeSnapshot.options);
    if (expectedDigest !== binding.configDigest) throw new Error('snapshot options do not match their binding');
    this.referee = FrozenBattleReferee.restore(refereeSnapshot);
    this.binding = binding;
    return this.bound({ restored: true });
  }

  private requireReferee(): FrozenBattleReferee {
    if (!this.referee || !this.binding) throw new Error('start or restore a referee first');
    return this.referee;
  }

  private bound(value: unknown): unknown {
    return { binding: structuredClone(this.binding), value };
  }
}
