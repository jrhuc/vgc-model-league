import type { ProviderFailureKind } from './types.js';

export interface RecoveryPause {
  model: string;
  kind: ProviderFailureKind;
  message: string;
  since: number;
  scope: string;
}

type RecoveryListener = (pause: RecoveryPause | undefined) => void;

/** Quota and rate-limit failures drain a budget every seat on that provider shares, so they pause the
 * whole provider; any other failure is one seat's trouble and pauses only that model. */
export function pauseScope(model: string, kind: ProviderFailureKind): string {
  return kind === 'quota' || kind === 'rate_limit' ? (model.split(':', 1)[0] ?? model) : model;
}

export class RecoveryGate {
  private readonly pauses = new Map<string, RecoveryPause>();
  private readonly listeners = new Set<RecoveryListener>();
  private readonly waiters = new Set<() => void>();

  get paused(): RecoveryPause | undefined {
    return this.pauses.values().next().value;
  }

  onChange(listener: RecoveryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private blocking(model?: string): RecoveryPause | undefined {
    if (model === undefined) return this.paused;
    return this.pauses.get(model) ?? this.pauses.get(model.split(':', 1)[0] ?? model);
  }

  async pause(model: string, kind: ProviderFailureKind, message: string, signal?: AbortSignal): Promise<void> {
    const scope = pauseScope(model, kind);
    if (!this.pauses.has(scope)) {
      const entry: RecoveryPause = { model, kind, message, since: Date.now(), scope };
      this.pauses.set(scope, entry);
      this.emit(entry);
    }
    await this.wait(model, signal);
  }

  async wait(model?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    while (this.blocking(model)) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const settle = () => {
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(settle);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(settle);
        reject(signal?.reason);
      };
      this.waiters.add(settle);
      signal?.addEventListener('abort', abort, { once: true });
      await promise;
    }
  }

  resume(scope?: string): boolean {
    if (scope === undefined) {
      if (!this.pauses.size) return false;
      this.pauses.clear();
    } else if (!this.pauses.delete(scope)) {
      return false;
    }
    for (const settle of [...this.waiters]) settle();
    this.emit(this.paused);
    return true;
  }

  /** New pauses emit themselves; resumes emit whichever pause remains (or none), so listeners that
   * only care whether anything is paused can keep reading the argument as a boolean. */
  private emit(pause: RecoveryPause | undefined): void {
    for (const listener of this.listeners) listener(pause);
  }
}
