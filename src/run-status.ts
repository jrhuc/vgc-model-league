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

function isRunningStatus(value: unknown): value is RunStatus & { state: 'running'; pid: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return (
    status.state === 'running' &&
    status.error === null &&
    Array.isArray(status.notices) &&
    status.notices.every((notice) => typeof notice === 'string') &&
    typeof status.start_time === 'string' &&
    status.end_time === null &&
    typeof status.pid === 'number' &&
    Number.isSafeInteger(status.pid) &&
    status.pid > 0
  );
}

export function liveRunPid(runDir: string): number | null {
  let status: unknown;
  try {
    status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!isRunningStatus(status)) return null;
  try {
    process.kill(status.pid, 0);
    return status.pid;
  } catch {
    return null;
  }
}

export function findLiveRun(runsDir: string): { runId: string; pid: number } | null {
  let runIds: string[];
  try {
    runIds = fs.readdirSync(runsDir).sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
  for (const runId of runIds) {
    const pid = liveRunPid(path.join(runsDir, runId));
    if (pid !== null) return { runId, pid };
  }
  return null;
}

export function assertRunCanResume(runDir: string): void {
  const pid = liveRunPid(runDir);
  if (pid !== null) {
    throw new Error(`Cannot resume run at ${runDir}: pid ${pid} is still live; only one resume owner is allowed.`);
  }
}

export function writeRunStatus(runDir: string, status: RunStatus): void {
  try {
    fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify(status, null, 1)}\n`, 'utf8');
  } catch {}
}

export async function withRunStatus<T>(runDir: string, task: () => Promise<T>): Promise<T> {
  const startTime = new Date().toISOString();
  const write = (state: RunStatus['state'], error: string | null) =>
    writeRunStatus(runDir, {
      state,
      error,
      notices: [],
      start_time: startTime,
      end_time: state === 'running' ? null : new Date().toISOString(),
      ...(state === 'running' ? { pid: process.pid } : {}),
    });
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const onSignal = (signal: string) => {
    write('stopped', `terminated by ${signal}`);
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
  }
}
