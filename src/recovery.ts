import type { ProviderFailureKind } from './providers.js';

export interface RecoveryPause {
  model: string;
  kind: ProviderFailureKind;
  message: string;
  since: number;
}

type RecoveryListener = (pause: RecoveryPause | undefined) => void;

export class RecoveryGate {
  private currentPause: RecoveryPause | undefined;
  private readonly listeners = new Set<RecoveryListener>();
  private readonly waiters = new Set<() => void>();

  get paused(): RecoveryPause | undefined {
    return this.currentPause;
  }

  onChange(listener: RecoveryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async pause(model: string, kind: ProviderFailureKind, message: string, signal?: AbortSignal): Promise<void> {
    if (!this.currentPause) {
      this.currentPause = { model, kind, message, since: Date.now() };
      this.emit();
    }
    await this.wait(signal);
  }

  wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.currentPause) return Promise.resolve();
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
    return promise;
  }

  resume(): boolean {
    if (!this.currentPause) return false;
    this.currentPause = undefined;
    for (const settle of [...this.waiters]) settle();
    this.emit();
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.currentPause);
  }
}
