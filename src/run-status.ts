import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RunStatus {
  state: 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  error: string | null;
  notices: string[];
  start_time: string;
  end_time: string | null;
  pid?: number;
}

interface LeaseOwner {
  id: string;
  pid: number;
  acquired_at: string;
}

export class LeaseBusyError extends Error {
  constructor(
    readonly leasePath: string,
    readonly pid: number,
  ) {
    super(`${leasePath} is owned by live pid ${pid}`);
  }
}

function ownerAt(file: string): LeaseOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LeaseOwner>;
    return typeof value.id === 'string' && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      ? (value as LeaseOwner)
      : null;
  } catch {
    return null;
  }
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Acquires one atomic process lease, replacing an owner only after its PID is no longer live. */
export function acquireLease(leasePath: string): () => void {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  const owner: LeaseOwner = { id: randomUUID(), pid: process.pid, acquired_at: new Date().toISOString() };
  const stage = `${leasePath}.stage-${owner.id}`;
  try {
    fs.writeFileSync(stage, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });
    for (;;) {
      try {
        fs.linkSync(stage, leasePath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = ownerAt(leasePath);
        if (current && isLive(current.pid)) throw new LeaseBusyError(leasePath, current.pid);
        const stale = `${leasePath}.stale-${randomUUID()}`;
        try {
          fs.renameSync(leasePath, stale);
          fs.rmSync(stale, { force: true });
        } catch (takeoverError) {
          const code = (takeoverError as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EEXIST') throw takeoverError;
        }
      }
    }
  } finally {
    fs.rmSync(stage, { force: true });
  }
  return () => {
    if (ownerAt(leasePath)?.id === owner.id) fs.rmSync(leasePath, { force: true });
  };
}

const runLeases = new Map<string, () => void>();

function holdRunLease(runDir: string): () => void {
  const leasePath = path.join(runDir, '.run.lease');
  if (runLeases.has(leasePath)) throw new LeaseBusyError(leasePath, process.pid);
  const releaseFile = acquireLease(leasePath);
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    runLeases.delete(leasePath);
    releaseFile();
  };
  runLeases.set(leasePath, release);
  return release;
}

export function writeRunStatus(runDir: string, status: RunStatus): void {
  const leasePath = path.join(runDir, '.run.lease');
  const active = status.state === 'running' || status.state === 'paused';
  if (active && !runLeases.has(leasePath)) holdRunLease(runDir);
  try {
    fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify(status, null, 1)}\n`, 'utf8');
  } catch {}
  if (!active) runLeases.get(leasePath)?.();
}

export async function withRunStatus<T>(runDir: string, task: () => Promise<T>): Promise<T> {
  const release = holdRunLease(runDir);
  const startTime = new Date().toISOString();
  const write = (state: RunStatus['state'], error: string | null) =>
    writeRunStatus(runDir, {
      state,
      error,
      notices: [],
      start_time: startTime,
      end_time: state === 'running' ? null : new Date().toISOString(),
    });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const onSignal = (signal: string) => {
    write('stopped', `terminated by ${signal}`);
    release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  write('running', null);
  for (const signal of signals) process.once(signal, onSignal);
  try {
    const result = await task();
    write('done', null);
    return result;
  } catch (error) {
    write('failed', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
    release();
  }
}
