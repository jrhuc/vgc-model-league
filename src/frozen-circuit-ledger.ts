import {
  type DomainDefault,
  FROZEN_CIRCUIT_MAX_PROMPT_BYTES,
  type FrozenCircuitPhase,
  type FrozenCircuitSubmissionResult,
  type PendingInternal,
  type TurnReceipt,
} from './frozen-circuit-model.js';
import { sha256 } from './frozen-circuit-setup.js';

export class FrozenCircuitLedger {
  revision = 0;
  readonly pending = new Map<string, PendingInternal>();
  readonly attempts = new Map<string, number>();
  readonly retryProblems = new Map<string, string[]>();
  readonly publicReceipts: TurnReceipt[] = [];
  readonly privateReceipts: Array<TurnReceipt & { response: string }> = [];
  readonly defaults: DomainDefault[] = [];
  private turnCounter = 0;

  constructor(
    private readonly configDigest: string,
    private readonly currentState: () => { phase: FrozenCircuitPhase; stateHash: string },
  ) {}

  attempt(key: string): number {
    return this.attempts.get(key) ?? 1;
  }

  problems(key: string): string[] {
    return this.retryProblems.get(key) ?? [];
  }

  addPending(input: Omit<PendingInternal, 'turnId'>): void {
    const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
    if (promptBytes > FROZEN_CIRCUIT_MAX_PROMPT_BYTES) {
      throw new Error(`connected prompt exceeds ${FROZEN_CIRCUIT_MAX_PROMPT_BYTES} encoded bytes (${promptBytes})`);
    }
    const turnId = `circuit-turn-${++this.turnCounter}-${sha256(
      `${this.configDigest}:${input.kind}:${input.seatId}:${this.turnCounter}:${input.attempt}`,
    ).slice(0, 16)}`;
    this.pending.set(turnId, { ...input, turnId });
  }

  withRetry(prompt: string, attempt: number, maximum: number, problems: readonly string[]): string {
    return problems.length
      ? `${prompt}

RETRY ${attempt}/${maximum}: ${problems.join('; ')}`
      : prompt;
  }

  setRetry(key: string, attempt: number, problems: string[]): void {
    this.attempts.set(key, attempt);
    this.retryProblems.set(key, [...problems]);
  }

  clearRetry(key: string): void {
    this.attempts.delete(key);
    this.retryProblems.delete(key);
  }

  recordDefault(turn: PendingInternal, seriesIndex: number | null, selected: string, diagnostic: string): void {
    if (turn.kind === 'notebook') return;
    this.defaults.push({
      turnId: turn.turnId,
      seatId: turn.seatId,
      kind: turn.kind,
      seriesIndex,
      selectedDigest: sha256(selected),
      diagnostic,
    });
  }

  finishSubmission(
    turn: PendingInternal,
    response: string,
    accepted: boolean,
    advanced: boolean,
    defaulted: boolean,
    diagnostic: string | null,
    problems?: string[],
  ): FrozenCircuitSubmissionResult {
    const { phase, stateHash } = this.currentState();
    const receipt: TurnReceipt = {
      turnId: turn.turnId,
      seatId: turn.seatId,
      kind: turn.kind,
      attempt: turn.attempt,
      responseSha256: sha256(response),
      accepted,
      advanced,
      defaulted,
      diagnostic,
    };
    this.publicReceipts.push(receipt);
    this.privateReceipts.push({ ...receipt, response });
    return {
      accepted,
      advanced,
      defaulted,
      diagnostic,
      ...(problems?.length ? { problems } : {}),
      phase,
      revision: this.revision,
      stateHash,
      terminal: phase === 'terminal',
    };
  }
}
