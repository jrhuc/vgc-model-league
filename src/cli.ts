#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuthService } from './auth.js';
import { GuiServer } from './gui/server.js';
import { AUTH_DB_PATH, prepareDataDirectories, RESULTS_PATH } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { REASONING_LEVELS } from './providers.js';
import type { SeriesRecord } from './records.js';
import { h2h, loadRows, scopeRows, standings, TEST_POOL } from './records.js';
import { writeReport } from './report.js';
import { restartGui, stopGui } from './restart.js';
import { makeRunDirectory, runRotation } from './rotation.js';
import { parseTimerScale } from './timer.js';
import type { TimerScale } from './types.js';

const HELP = `Usage: vgcleague <command>

Commands:
  gui [--port <n>] [--host <address>] [--origin <url>]  serve the browser GUI
  restart [--port <n>] [--host <address>] [--force] [--skip-build]
      rebuild, stop any GUI on the port, and start a fresh detached one (refuses while a run is active)
  stop [--port <n>] [--force]         stop the GUI on the port (refuses while a run is active)
  selfcheck                           run one random-vs-random series through the simulator
  rotation --models <spec> <spec>...  run the controlled team-rotation protocol
      [--series-per-pair <n>] [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>]
      [--timer-scale <n|off>]
  tournament --models <spec> <spec>...  play a single-elimination BO3 bracket; each model keeps one team
      [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
  draft --models <spec> <spec>...     snake-draft rosters from a board, then round robin and playoffs
      [--board <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
  exhibition --opponent <spec>        host one bo3 where a terminal agent plays a seat over a local bridge
      [--seat p1|p2] [--name <label>] [--pool <name>] [--seed <n>] [--port <n>] [--reasoning <level>]
      [--agent-dir <path>]
  standings [--pool <name>]           print standings and head-to-head from recorded results
  report [--out <path>] [--pool <name>]  write an HTML report

Without --pool, standings and report cover every pool except the disposable "test" pool
and keep only rotation rows; pass --pool <name> to inspect everything in one pool.
Draft, exhibition, and tournament rows record their mode and never rate the rotation ladder.`;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be an integer of at least 1`);
  return parsed;
}

function optionalInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function reasoningLevel(value: string | undefined): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  const level = value as ReasoningLevel;
  if (!REASONING_LEVELS.includes(level)) {
    throw new Error(`--reasoning must be one of: ${REASONING_LEVELS.join(', ')}`);
  }
  return level;
}

function timerScaleOption(value: string | undefined): TimerScale | undefined {
  if (value === undefined) return undefined;
  try {
    return parseTimerScale(value);
  } catch (error) {
    throw new Error(`--timer-scale ${error instanceof Error ? error.message : String(error)}`);
  }
}

function environmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  prepareDataDirectories();
  const [command, ...rest] = argv;
  if (command === 'selfcheck') return selfcheck();
  if (command === 'restart' || command === 'stop') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string', default: process.env.PORT ?? '8484' },
        host: { type: 'string' },
        force: { type: 'boolean', default: false },
        'skip-build': { type: 'boolean', default: false },
      },
    });
    const port = positiveInteger('port', values.port);
    if (command === 'stop') return stopGui({ port, force: values.force });
    return restartGui({ port, host: values.host, force: values.force, build: !values['skip-build'] });
  }
  if (command === 'gui') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string', default: process.env.PORT ?? '8484' },
        host: { type: 'string' },
        origin: { type: 'string' },
      },
    });
    const publicOrigin = values.origin ?? process.env.VGC_LEAGUE_PUBLIC_ORIGIN;
    const host = values.host ?? process.env.VGC_LEAGUE_HOST;
    const maxRunMinutes = environmentInteger('VGC_LEAGUE_MAX_RUN_MINUTES', 240, 1, 1440);
    const logger = publicOrigin ? (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)) : undefined;
    const githubClientId = process.env.GITHUB_CLIENT_ID?.trim();
    const githubClientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
    if (Boolean(githubClientId) !== Boolean(githubClientSecret)) {
      throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together');
    }
    if (githubClientId && !publicOrigin) throw new Error('GitHub OAuth requires VGC_LEAGUE_PUBLIC_ORIGIN');
    const auth =
      githubClientId && githubClientSecret && publicOrigin
        ? new AuthService({
            dbPath: AUTH_DB_PATH,
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            publicOrigin,
            operatorSubjects: (process.env.VGC_LEAGUE_OPERATOR_GITHUB_IDS ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          })
        : undefined;
    const gui = new GuiServer({
      ...(host ? { host } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
      mutationsEnabled: !publicOrigin || process.env.VGC_LEAGUE_ENABLE_MUTATIONS === 'true',
      ...(logger ? { logger } : {}),
      ...(auth ? { auth } : {}),
      maxRunMs: maxRunMinutes * 60_000,
    });
    const url = await gui.listen(positiveInteger('port', values.port));
    if (logger) logger({ timestamp: new Date().toISOString(), level: 'info', event: 'server_started', url });
    else console.log(`VGC Model League GUI at ${url} (Ctrl-C to stop)`);
    let stopping = false;
    const shutdown = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger?.({ timestamp: new Date().toISOString(), level: 'info', event: 'server_stopping', signal });
      void (async () => {
        try {
          await gui.shutdown();
        } catch (error) {
          logger?.({
            timestamp: new Date().toISOString(),
            level: 'error',
            event: 'shutdown_error',
            error: error instanceof Error ? error.message : String(error),
          });
          process.exitCode = 1;
        } finally {
          auth?.close();
          // A wedged run task must not outlive the server: exit instead of draining the event loop.
          process.exit(process.exitCode ?? 0);
        }
      })();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    return 0;
  }
  if (command === 'rotation') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        models: { type: 'string', multiple: true },
        'series-per-pair': { type: 'string', default: '2' },
        pool: { type: 'string', default: 'test' },
        seed: { type: 'string' },
        concurrency: { type: 'string', default: '2' },
        reasoning: { type: 'string' },
        'timer-scale': { type: 'string' },
      },
    });
    const models = [...(values.models ?? []), ...positionals];
    if (models.length < 2) throw new Error('rotation requires at least two --models');
    const reasoning = reasoningLevel(values.reasoning);
    const timerScale = timerScaleOption(values['timer-scale']);
    const seed = optionalInteger('seed', values.seed);
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
        ...(timerScale === undefined ? {} : { timerScale }),
      },
    );
    printResults(rows);
    return 0;
  }
  if (command === 'tournament') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        models: { type: 'string', multiple: true },
        pool: { type: 'string', default: 'test' },
        seed: { type: 'string' },
        concurrency: { type: 'string', default: '2' },
        reasoning: { type: 'string' },
        'timer-scale': { type: 'string' },
      },
    });
    const models = [...(values.models ?? []), ...positionals];
    if (models.length < 2) throw new Error('tournament requires at least two --models');
    const reasoning = reasoningLevel(values.reasoning);
    const timerScale = timerScaleOption(values['timer-scale']);
    const seed = optionalInteger('seed', values.seed);
    const { runTournament } = await import('./tournament.js');
    const rows = await runTournament(models, makeRunDirectory(), {
      pool: values.pool,
      concurrency: positiveInteger('concurrency', values.concurrency),
      recordsPath: RESULTS_PATH,
      ...(seed === undefined ? {} : { seed }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(timerScale === undefined ? {} : { timerScale }),
      onNotice: (line) => console.log(line),
    });
    printResults(rows);
    const champion = rows[rows.length - 1];
    if (champion) console.log(`Champion: ${String(champion.advanced ?? champion.winner)}`);
    return 0;
  }
  if (command === 'draft') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        models: { type: 'string', multiple: true },
        board: { type: 'string', default: 'regmb-202607' },
        seed: { type: 'string' },
        concurrency: { type: 'string', default: '2' },
        reasoning: { type: 'string' },
        'timer-scale': { type: 'string' },
      },
    });
    const models = [...(values.models ?? []), ...positionals];
    if (models.length < 2) throw new Error('draft requires at least two --models');
    const reasoning = reasoningLevel(values.reasoning);
    const timerScale = timerScaleOption(values['timer-scale']);
    const seed = optionalInteger('seed', values.seed);
    const { runDraftLeague } = await import('./draftleague.js');
    const runDir = makeRunDirectory();
    const rows = await runDraftLeague(models, runDir, {
      board: values.board,
      concurrency: positiveInteger('concurrency', values.concurrency),
      recordsPath: RESULTS_PATH,
      ...(seed === undefined ? {} : { seed }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(timerScale === undefined ? {} : { timerScale }),
      onEvent: (event) => {
        if (event.type === 'draft' && event.draft.phase === 'draft' && event.draft.picks.length > 0) {
          const pick = event.draft.picks[event.draft.picks.length - 1]!;
          console.log(
            `pick ${pick.pick}: ${event.draft.entrants[pick.entrant]} takes ${pick.mon}${pick.fallback ? ' (fallback)' : ''}`,
          );
        }
      },
    });
    printResults(rows);
    const champion = rows[rows.length - 1]?.advanced;
    if (typeof champion !== 'string' || !champion) throw new Error('draft final did not identify a champion');
    console.log(`Champion: ${champion}`);
    console.log(`Draft logs: ${path.join(runDir, 'draft')}`);
    return 0;
  }
  if (command === 'exhibition') {
    const { values } = parseArgs({
      args: rest,
      options: {
        opponent: { type: 'string' },
        seat: { type: 'string', default: 'p1' },
        name: { type: 'string', default: 'cli-agent' },
        pool: { type: 'string', default: 'test' },
        seed: { type: 'string' },
        port: { type: 'string' },
        reasoning: { type: 'string' },
        'agent-dir': { type: 'string' },
      },
    });
    if (!values.opponent) throw new Error('exhibition requires --opponent <spec|random>');
    if (values.seat !== 'p1' && values.seat !== 'p2') throw new Error('--seat must be p1 or p2');
    const reasoning = reasoningLevel(values.reasoning);
    const seed = optionalInteger('seed', values.seed);
    const { runExhibition } = await import('./exhibition.js');
    const row = await runExhibition(makeRunDirectory(), {
      opponent: values.opponent,
      seat: values.seat,
      name: values.name,
      pool: values.pool,
      recordsPath: RESULTS_PATH,
      ...(seed === undefined ? {} : { seed }),
      ...(values.port === undefined ? {} : { port: positiveInteger('port', values.port) }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(values['agent-dir'] === undefined ? {} : { agentDir: values['agent-dir'] }),
      onNotice: (line) => console.log(line),
      onReady: ({ url, agentDir }) => {
        console.log(`Seat bridge listening at ${url}`);
        console.log(`Agent workspace: ${agentDir}`);
        console.log('Start the terminal agent with that directory as its working directory and have it read SEAT.md.');
      },
    });
    printResults([row]);
    return 0;
  }
  if (command === 'standings' || command === 'report') {
    const { values } = parseArgs({
      args: rest,
      options: {
        pool: { type: 'string' },
        out: { type: 'string', default: path.join(path.dirname(RESULTS_PATH), 'report.html') },
      },
    });
    if (command === 'report') {
      console.log(writeReport(RESULTS_PATH, values.out, values.pool));
      return 0;
    }
    if (values.pool === undefined) console.log(`All pools except ${JSON.stringify(TEST_POOL)}; use --pool for one.\n`);
    printStandings(scopeRows(loadRows(RESULTS_PATH), values.pool));
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
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
