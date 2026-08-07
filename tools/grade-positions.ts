#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

import { type GameRecord, loadGameRecords, verifyGame } from '../src/eval/corpus.js';
import { evaluatePosition, REFERENCE, type RegretOptions } from '../src/eval/regret.js';
import { DATA_DIR } from '../src/paths.js';
import type { JsonObject } from '../src/types.js';

interface Settings extends RegretOptions {
  modes?: string[];
  limit?: number;
  workers: number;
  out: string;
  restart?: boolean;
}

interface Shard {
  index: number;
  of: number;
  settings: Settings;
  done: string[];
}

interface GradedGame {
  game: string;
  rows: JsonObject[];
}

function defaultWorkers(): number {
  return Math.max(1, Math.floor(os.availableParallelism() / 3));
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    workers: defaultWorkers(),
    out: path.join(DATA_DIR, 'records', 'positions.jsonl'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--restart') {
      settings.restart = true;
      continue;
    }
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

function gameKey(record: GameRecord): string {
  return `${record.runId}:${record.seriesId}:${record.gameNumber}`;
}

function gradedGames(file: string): Set<string> {
  const done = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return done;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as JsonObject;
      if (row.complete === true) done.add(`${row.run_id}:${row.series_id}:${row.game_number}`);
    } catch {}
  }
  return done;
}

function playableRecords(settings: Settings): GameRecord[] {
  const records = loadGameRecords(settings.modes ? { modes: settings.modes } : {});
  return records.filter((record) => !record.skipped).slice(0, settings.limit ?? Number.POSITIVE_INFINITY);
}

function gradeShard(shard: Shard, emit: (graded: GradedGame) => void): void {
  const { settings } = shard;
  const done = new Set(shard.done);

  for (const [index, record] of playableRecords(settings).entries()) {
    if (index % shard.of !== shard.index) continue;
    const key = gameKey(record);
    if (done.has(key)) continue;
    const game = verifyGame(record);
    if (!game) continue;
    const rows: JsonObject[] = [];
    for (const position of game.replay.positions) {
      for (const pid of ['p1', 'p2'] as const) {
        const graded = evaluatePosition(position, pid, settings);
        if (!graded) continue;
        const decision = record.decisions[pid][position.choiceIndex[pid]] ?? {};
        rows.push({
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
    const last = rows.at(-1);
    if (last) last.complete = true;
    emit({ game: key, rows });
  }
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  fs.mkdirSync(path.dirname(settings.out), { recursive: true });
  if (settings.restart) fs.rmSync(settings.out, { force: true });
  const done = gradedGames(settings.out);
  const total = playableRecords(settings).length;
  const remaining = playableRecords(settings).filter((record) => !done.has(gameKey(record))).length;
  const workers = Math.min(settings.workers, Math.max(1, remaining));
  process.stdout.write(
    `${remaining} of ${total} verified games left to grade across ${workers} workers into ${settings.out}\n`,
  );
  if (!remaining) return;

  const stream = fs.createWriteStream(settings.out, { flags: 'a' });
  let rows = 0;
  let games = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: workers }, (_, index) => {
      const shard: Shard = { index, of: workers, settings, done: [...done] };
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: shard });
      worker.on('message', (graded: GradedGame) => {
        for (const row of graded.rows) stream.write(`${JSON.stringify(row)}\n`);
        rows += graded.rows.length;
        games += 1;
        const rate = rows / ((Date.now() - started) / 1000);
        process.stdout.write(`  ${games}/${remaining} games · ${rows} decisions (${rate.toFixed(1)}/s)\n`);
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
  gradeShard(workerData as Shard, (graded) => parentPort?.postMessage(graded));
}
