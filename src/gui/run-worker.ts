import { runRotation } from '../rotation.js';
import { redactSecrets } from '../sanitize.js';
import { runTournament } from '../tournament.js';
import type { RunWorkerInput, RunWorkerOutput, RunWorkerStart } from './run-worker-protocol.js';

let controller: AbortController | undefined;
let started = false;

process.on('message', (value: unknown) => {
  const message = value as RunWorkerInput;
  if (message?.type === 'abort') {
    controller?.abort();
    return;
  }
  if (message?.type !== 'start' || started) return;
  started = true;
  void execute(message);
});

async function execute(message: RunWorkerStart): Promise<void> {
  controller = new AbortController();
  try {
    if (message.mode === 'draft') {
      const { runDraftLeague } = await import('../draftleague.js');
      await runDraftLeague(message.models, message.runDir, {
        concurrency: message.concurrency,
        recordsPath: message.recordsPath,
        apiKeys: message.apiKeys,
        signal: controller.signal,
        ...(message.board === undefined ? {} : { board: message.board }),
        ...(message.seed === undefined ? {} : { seed: message.seed }),
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
        ...(message.contributor === undefined ? {} : { contributor: message.contributor }),
        onEvent: (event) => send({ type: 'event', event }),
        onNotice: (notice) => send({ type: 'notice', message: notice }),
      });
    } else if (message.mode === 'tournament') {
      await runTournament(message.models, message.runDir, {
        concurrency: message.concurrency,
        recordsPath: message.recordsPath,
        apiKeys: message.apiKeys,
        signal: controller.signal,
        ...(message.teams === undefined ? {} : { teams: message.teams }),
        ...(message.format === undefined ? {} : { format: message.format }),
        ...(message.pool ? { pool: message.pool } : {}),
        ...(message.seed === undefined ? {} : { seed: message.seed }),
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
        ...(message.contributor === undefined ? {} : { contributor: message.contributor }),
        onEvent: (event) => send({ type: 'event', event }),
        onNotice: (notice) => send({ type: 'notice', message: notice }),
      });
    } else {
      await runRotation(message.models, message.seriesPerPair, message.runDir, {
        pool: message.pool,
        concurrency: message.concurrency,
        recordsPath: message.recordsPath,
        apiKeys: message.apiKeys,
        signal: controller.signal,
        ...(message.seed === undefined ? {} : { seed: message.seed }),
        ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
        ...(message.contributor === undefined ? {} : { contributor: message.contributor }),
        onEvent: (event) => send({ type: 'event', event }),
        onNotice: (notice) => send({ type: 'notice', message: notice }),
      });
    }
    finish({ type: 'done' }, 0);
  } catch (error) {
    const detail = redactSecrets(
      error instanceof Error ? error.message : String(error),
      Object.values(message.apiKeys),
    );
    finish({ type: 'failed', error: detail }, 1);
  } finally {
    for (const model of Object.keys(message.apiKeys)) delete message.apiKeys[model];
  }
}

function send(message: RunWorkerOutput): void {
  process.send?.(message);
}

function finish(message: RunWorkerOutput, exitCode: number): void {
  if (!process.send) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}
