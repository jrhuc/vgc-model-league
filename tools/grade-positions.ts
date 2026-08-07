#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { loadGameRecords, verifyGame } from '../src/eval/corpus.js';
import { evaluatePosition, REFERENCE, type RegretOptions } from '../src/eval/regret.js';
import { DATA_DIR } from '../src/paths.js';
import type { JsonObject } from '../src/types.js';

interface Settings extends RegretOptions {
  modes?: string[];
  limit?: number;
  workers: number;
  out: string;
}

interface Shard {
  index: number;
  of: number;
  settings: Settings;
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    workers: Math.max(1, os.availableParallelism() - 1),
    out: path.join(DATA_DIR, 'records', 'positions.jsonl'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--modes' && value) settings.modes = value.split(',');
    else if (flag === '--limit' && value) settings.limit = Number(value);
    else if (flag === '--workers' && value) settings.workers = Math.max(1, Number(value));
    else if (flag === '--horizon' && value)
      settings.horizon = value === 'end' ? Number.POSITIVE_INFINITY : Number(value);
    else if (flag === '--luck' && value) settings.luckSamples = Number(value);
    else if (flag === '--opponents' && value) settings.opponentSamples = Number(value);
    else if (flag === '--shortlist' && value) settings.shortlist = Number(value);
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else continue;
    index += 1;
  }
  return settings;
}

function gradeShard(shard: Shard, emit: (row: JsonObject) => void): void {
  const { settings } = shard;
  const records = loadGameRecords(settings.modes ? { modes: settings.modes } : {});
  const playable = records.filter((record) => !record.skipped).slice(0, settings.limit ?? Number.POSITIVE_INFINITY);

  for (const [index, record] of playable.entries()) {
    if (index % shard.of !== shard.index) continue;
    const game = verifyGame(record);
    if (!game) continue;
    for (const position of game.replay.positions) {
      for (const pid of ['p1', 'p2'] as const) {
        const graded = evaluatePosition(position, pid, settings);
        if (!graded) continue;
        const decision = record.decisions[pid][position.choiceIndex[pid]] ?? {};
        emit({
          run_id: record.runId,
          series_id: record.seriesId,
          game_number: record.gameNumber,
          mode: record.mode,
          format: record.format,
          scaffold: record.scaffold.revision,
          scaffold_components: record.scaffold.components,
          model: record.players[pid],
          opponent: record.players[pid === 'p1' ? 'p2' : 'p1'],
          pid,
          position_index: position.index,
          choice_index: position.choiceIndex[pid],
          turn: graded.turn,
          phase: decision.phase ?? null,
          legal_actions: graded.legal,
          chosen: graded.chosen,
          horizon: graded.horizon === Number.POSITIVE_INFINITY ? 'end' : graded.horizon,
          reference: REFERENCE,
          ex_post: graded.exPost,
          ex_ante: graded.exAnte,
        });
      }
    }
  }
}

function countPlayable(settings: Settings): number {
  const records = loadGameRecords(settings.modes ? { modes: settings.modes } : {});
  return records.filter((record) => !record.skipped).slice(0, settings.limit ?? Number.POSITIVE_INFINITY).length;
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  fs.mkdirSync(path.dirname(settings.out), { recursive: true });
  const stream = fs.createWriteStream(settings.out, { flags: 'w' });
  const games = countPlayable(settings);
  const workers = Math.min(settings.workers, Math.max(1, games));
  process.stdout.write(`grading ${games} verified games across ${workers} workers into ${settings.out}\n`);

  let rows = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: workers }, (_, index) => {
      const shard: Shard = { index, of: workers, settings };
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: shard });
      worker.on('message', (row: JsonObject) => {
        stream.write(`${JSON.stringify(row)}\n`);
        rows += 1;
        if (rows % 100 === 0) {
          const rate = rows / ((Date.now() - started) / 1000);
          process.stdout.write(`  ${rows} decisions graded (${rate.toFixed(1)}/s)\n`);
        }
      });
      return new Promise<void>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', () => resolve());
      });
    }),
  );
  stream.end();
  process.stdout.write(`${rows} decisions graded in ${((Date.now() - started) / 60_000).toFixed(1)} min\n`);
}

if (isMainThread) {
  await main();
} else {
  gradeShard(workerData as Shard, (row) => parentPort?.postMessage(row));
}
