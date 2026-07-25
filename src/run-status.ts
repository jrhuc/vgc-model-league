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
