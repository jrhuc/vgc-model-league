#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Table from 'cli-table3';
import { Command, Option } from 'commander';
import { runBenchmark } from './arena.js';
import { REPO_ROOT, RESULTS_PATH, RUNS_DIR } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { REASONING_LEVELS } from './providers.js';
import type { SeriesRecord } from './records.js';
import { h2h, loadRows, standings } from './records.js';
import { writeReport } from './report.js';

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('must be an integer');
  return parsed;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('must be an integer of at least 1');
  return parsed;
}

function runDirectory(): string {
  const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace('Z', '000Z');
  const directory = path.join(RUNS_DIR, `${stamp}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const program = new Command()
    .name('vgcbench')
    .description('Benchmark language models in Pokémon Showdown VGC battles');
  let exitCode = 0;
  program.command('selfcheck').action(async () => {
    exitCode = await selfcheck();
  });
  program
    .command('run')
    .requiredOption('--models <models...>')
    .option('--series-per-pair <count>', '', positiveInteger, 1)
    .option('--pool <name>', '', 'test')
    .option('--seed <number>', '', integer)
    .option('--concurrency <count>', '', positiveInteger, 2)
    .addOption(new Option('--reasoning <level>').choices([...REASONING_LEVELS]))
    .action(
      async (options: {
        models: string[];
        seriesPerPair: number;
        pool: string;
        seed?: number;
        concurrency: number;
        reasoning?: ReasoningLevel;
      }) => {
        if (options.models.length < 2) throw new Error('run requires at least two models');
        const rows = await runBenchmark(options.models, options.seriesPerPair, runDirectory(), {
          pool: options.pool,
          concurrency: options.concurrency,
          recordsPath: RESULTS_PATH,
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        });
        printResults(rows);
      },
    );
  program
    .command('standings')
    .option('--pool <name>')
    .action((options: { pool?: string }) =>
      printStandings(loadRows(RESULTS_PATH).filter((row) => options.pool === undefined || row.pool === options.pool)),
    );
  program
    .command('report')
    .option('--out <path>', '', path.join(REPO_ROOT, 'records', 'report.html'))
    .option('--pool <name>')
    .action((options: { out: string; pool?: string }) =>
      console.log(writeReport(RESULTS_PATH, options.out, options.pool)),
    );
  await program.parseAsync(['node', 'vgcbench', ...argv]);
  return exitCode;
}

async function selfcheck(): Promise<number> {
  const directory = runDirectory();
  try {
    const rows = await runBenchmark(['random', 'random'], 1, directory, {
      seed: 1,
      concurrency: 1,
      recordsPath: path.join(directory, 'results.jsonl'),
    });
    printResults(rows);
    return 0;
  } catch (error) {
    console.error(`selfcheck failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printResults(rows: SeriesRecord[]): void {
  for (const row of rows) {
    const score = row.score as Record<string, number>;
    const games = Array.isArray(row.games) ? row.games : [];
    console.log(
      `${row.players.p1} vs ${row.players.p2}: ${row.winner ?? 'tie'} (${score.p1}-${score.p2}, ${games.length} games, ${row.turns} turns)`,
    );
  }
}

function printStandings(rows: SeriesRecord[]): void {
  const table = new Table({ head: ['Model', 'Series', 'W', 'L', 'T', 'Win rate', 'Elo'] });
  for (const item of standings(rows))
    table.push([
      item.spec,
      item.series,
      item.w,
      item.l,
      item.t,
      `${(100 * item.winrate).toFixed(1)}%`,
      item.elo.toFixed(1),
    ]);
  console.log(table.toString());
  const matrix = h2h(rows);
  const specs = Object.keys(matrix);
  if (specs.length < 2) return;
  const head = new Table({ head: ['Model', ...specs] });
  for (const model of specs)
    head.push([model, ...specs.map((opponent) => (model === opponent ? '-' : matrix[model]![opponent]!.join('-')))]);
  console.log(head.toString());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
