#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_ROOT, RESULTS_PATH } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { REASONING_LEVELS } from './providers.js';
import type { SeriesRecord } from './records.js';
import { h2h, loadRows, standings } from './records.js';
import { writeReport } from './report.js';
import { makeRunDirectory, runRotation } from './rotation.js';

const HELP = `Usage: vgcleague <command>

Commands:
  gui [--port <n>]                    serve the browser GUI on 127.0.0.1 (default port 8484)
  selfcheck                           run one random-vs-random series through the simulator
  rotation --models <spec> <spec>...  run the controlled team-rotation protocol
      [--series-per-pair <n>] [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>]
  standings [--pool <name>]           print standings and head-to-head from recorded results
  report [--out <path>] [--pool <name>]  write an HTML report`;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be an integer of at least 1`);
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'selfcheck') return selfcheck();
  if (command === 'gui') {
    const { values } = parseArgs({ args: rest, options: { port: { type: 'string', default: '8484' } } });
    const { GuiServer } = await import('./gui/server.js');
    const url = await new GuiServer().listen(positiveInteger('port', values.port));
    console.log(`VGC Model League GUI at ${url} (ctrl-c to stop)`);
    return 0;
  }
  if (command === 'rotation') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        models: { type: 'string', multiple: true },
        'series-per-pair': { type: 'string', default: '1' },
        pool: { type: 'string', default: 'test' },
        seed: { type: 'string' },
        concurrency: { type: 'string', default: '2' },
        reasoning: { type: 'string' },
      },
    });
    const models = [...(values.models ?? []), ...positionals];
    if (models.length < 2) throw new Error('rotation requires at least two --models');
    const reasoning = values.reasoning as ReasoningLevel | undefined;
    if (reasoning && !REASONING_LEVELS.includes(reasoning))
      throw new Error(`--reasoning must be one of: ${REASONING_LEVELS.join(', ')}`);
    const seed = values.seed === undefined ? undefined : Number(values.seed);
    if (seed !== undefined && !Number.isSafeInteger(seed)) throw new Error('--seed must be an integer');
    const rows = await runRotation(
      models,
      positiveInteger('series-per-pair', values['series-per-pair']),
      makeRunDirectory(),
      {
        pool: values.pool,
        concurrency: positiveInteger('concurrency', values.concurrency),
        recordsPath: RESULTS_PATH,
        ...(seed === undefined ? {} : { seed }),
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    );
    printResults(rows);
    return 0;
  }
  if (command === 'standings' || command === 'report') {
    const { values } = parseArgs({
      args: rest,
      options: {
        pool: { type: 'string' },
        out: { type: 'string', default: path.join(REPO_ROOT, 'records', 'report.html') },
      },
    });
    if (command === 'report') {
      console.log(writeReport(RESULTS_PATH, values.out, values.pool));
      return 0;
    }
    printStandings(loadRows(RESULTS_PATH).filter((row) => values.pool === undefined || row.pool === values.pool));
    return 0;
  }
  console.error(HELP);
  return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
}

async function selfcheck(): Promise<number> {
  const directory = makeRunDirectory();
  try {
    const rows = await runRotation(['random', 'random'], 1, directory, {
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

function renderTable(head: string[], rows: string[][]): string {
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]) => `| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')} |`;
  const rule = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
  return [line(head), rule, ...rows.map(line)].join('\n');
}

function printStandings(rows: SeriesRecord[]): void {
  console.log(
    renderTable(
      ['Model', 'Series', 'W', 'L', 'T', 'Win rate', 'Elo'],
      standings(rows).map((item) => [
        item.spec,
        String(item.series),
        String(item.w),
        String(item.l),
        String(item.t),
        `${(100 * item.winrate).toFixed(1)}%`,
        item.elo.toFixed(1),
      ]),
    ),
  );
  const matrix = h2h(rows);
  const specs = Object.keys(matrix);
  if (specs.length < 2) return;
  console.log('');
  console.log(
    renderTable(
      ['W-L-T', ...specs],
      specs.map((model) => [
        model,
        ...specs.map((opponent) => (model === opponent ? '-' : matrix[model]![opponent]!.join('-'))),
      ]),
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
