#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AuthService } from './auth.js';
import { GuiServer } from './gui/server.js';
import { AUTH_DB_PATH, makeRunDirectory, prepareDataDirectories, RESULTS_PATH, RUNS_DIR, TEAMS_DIR } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { nitroSpec, REASONING_LEVELS } from './providers.js';
import type { SeriesRecord } from './records.js';
import { loadRows, ratingGroups, scopeRows, TEST_POOL } from './records.js';
import { RecoveryGate } from './recovery.js';
import { writeReport } from './report.js';
import { restartGui, stopGui } from './restart.js';
import { runRotation } from './rotation.js';
import { withRunStatus } from './run-status.js';
import { parseTimerScale } from './timer.js';
import type { TimerScale } from './types.js';

const EXPERIMENT_CLI_OPTIONS = {
  models: { type: 'string', multiple: true },
  seed: { type: 'string' },
  concurrency: { type: 'string', default: '2' },
  reasoning: { type: 'string' },
  'timer-scale': { type: 'string' },
  nitro: { type: 'boolean', default: false },
} as const;

interface ExperimentCliValues {
  seed?: string;
  concurrency: string;
  reasoning?: string;
  'timer-scale'?: string;
  nitro: boolean;
}

const HELP = `Usage: vgcleague <command>

Commands:
  gui [--port <n>] [--host <address>] [--origin <url>]  serve the browser GUI
  restart [--port <n>] [--host <address>] [--force] [--skip-build]
      rebuild, stop any GUI on the port, and start a fresh detached one (refuses while a run is active)
  stop [--port <n>] [--force]         stop the GUI on the port (refuses while a run is active)
  selfcheck                           run one random-vs-random series through the simulator
  rotation --models <spec> <spec>...  run the controlled team-rotation protocol
      [--series-per-pair <n>] [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>]
      [--timer-scale <n|off>] [--nitro]
  tournament --models <spec> <spec>...  play a single-elimination BO3 bracket; each model keeps one team
      [--pool <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
      [--nitro]
  draft --models <spec> <spec>...     snake-draft rosters from a board, then a weekly round robin and playoffs
      each coach drafts 10 within a 100-point budget, then picks 6 and builds every set before each match
      [--board <name>] [--seed <n>] [--concurrency <n>] [--reasoning <level>] [--timer-scale <n|off>]
      [--nitro] [--through-week <n>] [--resume <run-dir>] [--sequential-weeks] [--closed-sheets]
      [--trade-window <week|off>]
      --through-week stops cleanly after that round-robin week; --resume continues a stored league
      round-robin series run concurrently with blind teambuilds; --sequential-weeks restores
      week-by-week play (implied by --through-week); --closed-sheets hides opposing team sheets
      the free-agent window defaults to week 3 (or the last week in shorter leagues); pass off for locked rosters
      (models, board, seed, and trade window come from the run's config on resume)
  exhibition --opponent <spec>        host one bo3 where a terminal agent plays a seat over a local bridge
      [--seat p1|p2] [--name <label>] [--pool <name>] [--seed <n>] [--port <n>] [--reasoning <level>]
      [--agent-dir <path>]
  standings [--pool <name>]           print standings and head-to-head from recorded results
  report [--out <path>] [--pool <name>]  write an HTML report
  publish [--to <origin>] [--pool <name>] [--include-test] [--dry-run]
      send completed local series, their decision logs, and any missing team pool to a deployment

Runs stay alive through transient provider failures (rate limits, upstream
outages, exhausted quotas): the affected seat pauses, then retries with backoff
instead of failing the run. Credential and request errors still fail fast.

--nitro adds the :nitro throughput-routing variant to every OpenRouter spec that
does not already carry a routing variant. Faster, usually pricier; skip it when
slower seats set the pace anyway.

While a run is live, writing {"models": {"<spec>": "<replacement>"}} to
<run-dir>/overrides.json reroutes that seat's calls to the replacement provider
from its next decision on — no restart, nothing replayed. Meant for moving the
same model to a healthier route (a rerouted seat uses environment API keys);
records keep the seat's original spec. Delete the entry to route it back.

publish needs VGC_LEAGUE_PUBLISH_ORIGIN (or --to) and VGC_LEAGUE_IMPORT_TOKEN, which must
match the token the deployment runs with. It is idempotent: series the deployment already
holds are reported and skipped.

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

function experimentModels(
  command: string,
  models: string[] | undefined,
  positionals: string[],
  nitro = false,
): string[] {
  const selected = [...(models ?? []), ...positionals];
  if (selected.length < 2) throw new Error(`${command} requires at least two --models`);
  return nitro ? selected.map(nitroSpec) : selected;
}

function experimentExecution(values: ExperimentCliValues) {
  const reasoning = reasoningLevel(values.reasoning);
  const timerScale = timerScaleOption(values['timer-scale']);
  const seed = optionalInteger('seed', values.seed);
  return {
    recordsPath: RESULTS_PATH,
    ...(seed === undefined ? {} : { seed }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timerScale === undefined ? {} : { timerScale }),
    recovery: autoResumeGate(),
  };
}

function armModelOverrides(runDir: string): void {
  process.env.VGC_MODEL_OVERRIDES ??= path.join(runDir, 'overrides.json');
}

function autoResumeGate(): RecoveryGate {
  const gate = new RecoveryGate();
  const scheduled = new Set<string>();
  const streaks = new Map<string, { count: number; lastPause: number }>();
  gate.onChange((pause) => {
    if (!pause || scheduled.has(pause.scope)) return;
    scheduled.add(pause.scope);
    const now = Date.now();
    const streak = streaks.get(pause.scope);
    const count = streak && now - streak.lastPause <= 10 * 60_000 ? streak.count : 0;
    streaks.set(pause.scope, { count: count + 1, lastPause: now });
    const ceiling = pause.kind === 'rate_limit' ? 60_000 : 5 * 60_000;
    const delay = Math.min(ceiling, 30_000 * 2 ** count);
    console.error(
      `paused ${pause.scope} on ${pause.model} (${pause.kind}): ${pause.message} auto-resume in ${Math.round(delay / 1000)}s`,
    );
    setTimeout(() => {
      scheduled.delete(pause.scope);
      gate.resume(pause.scope);
    }, delay);
  });
  return gate;
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
    const importToken = process.env.VGC_LEAGUE_IMPORT_TOKEN?.trim();
    const gui = new GuiServer({
      ...(host ? { host } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
      ...(importToken ? { importToken } : {}),
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
          /** A wedged run task must not outlive the server: exit instead of draining the event loop. */
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
        ...EXPERIMENT_CLI_OPTIONS,
        'series-per-pair': { type: 'string', default: '2' },
        pool: { type: 'string', default: 'test' },
      },
    });
    const models = experimentModels(command, values.models, positionals, values.nitro);
    const execution = experimentExecution(values);
    const runDir = makeRunDirectory();
    armModelOverrides(runDir);
    const rows = await withRunStatus(runDir, () =>
      runRotation(models, positiveInteger('series-per-pair', values['series-per-pair']), runDir, {
        pool: values.pool,
        concurrency: positiveInteger('concurrency', values.concurrency),
        ...execution,
      }),
    );
    printResults(rows);
    return 0;
  }
  if (command === 'tournament') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        ...EXPERIMENT_CLI_OPTIONS,
        pool: { type: 'string', default: 'test' },
      },
    });
    const models = experimentModels(command, values.models, positionals, values.nitro);
    const execution = experimentExecution(values);
    const { runTournament } = await import('./tournament.js');
    const runDir = makeRunDirectory();
    armModelOverrides(runDir);
    const rows = await withRunStatus(runDir, () =>
      runTournament(models, runDir, {
        pool: values.pool,
        concurrency: positiveInteger('concurrency', values.concurrency),
        ...execution,
      }),
    );
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
        ...EXPERIMENT_CLI_OPTIONS,
        board: { type: 'string', default: 'regmb-202607' },
        'through-week': { type: 'string' },
        resume: { type: 'string' },
        'sequential-weeks': { type: 'boolean', default: false },
        'closed-sheets': { type: 'boolean', default: false },
        'trade-window': { type: 'string' },
      },
    });
    const { runDraftLeague, roundRobinWeeks } = await import('./draftleague.js');
    const resumeDir = values.resume ? path.resolve(values.resume) : undefined;
    const storedConfig = resumeDir
      ? (JSON.parse(fs.readFileSync(path.join(resumeDir, 'config.json'), 'utf8')) as {
          models: string[];
          seed: number;
          board: string;
          concurrency?: number;
          reasoning?: string | null;
          timer_scale?: number | 'off';
          sequential_weeks?: boolean;
          closed_sheets?: boolean;
          trade_window?: { after_week?: number } | null;
        })
      : undefined;
    const models = storedConfig
      ? storedConfig.models
      : experimentModels(command, values.models, positionals, values.nitro);
    let execution: ReturnType<typeof experimentExecution>;
    if (storedConfig) {
      const storedReasoning = storedConfig.reasoning ? reasoningLevel(storedConfig.reasoning) : undefined;
      execution = {
        recordsPath: RESULTS_PATH,
        seed: storedConfig.seed,
        ...(storedReasoning === undefined ? {} : { reasoning: storedReasoning }),
        ...(storedConfig.timer_scale === undefined ? {} : { timerScale: storedConfig.timer_scale }),
        recovery: autoResumeGate(),
      };
    } else {
      execution = experimentExecution(values);
    }
    const throughWeek =
      values['through-week'] === undefined ? undefined : positiveInteger('through-week', values['through-week']);
    const tradeWindowValue = storedConfig
      ? storedConfig.trade_window === undefined || storedConfig.trade_window === null
        ? null
        : { afterWeek: positiveInteger('trade-window', String(storedConfig.trade_window.after_week)) }
      : values['trade-window'] === undefined
        ? undefined
        : values['trade-window'] === 'off'
          ? null
          : { afterWeek: positiveInteger('trade-window', values['trade-window']) };
    const runDir = resumeDir ?? makeRunDirectory();
    armModelOverrides(runDir);
    let lastTeambuilds = 0;
    const rows = await withRunStatus(runDir, () =>
      runDraftLeague(models, runDir, {
        board: storedConfig ? storedConfig.board : values.board,
        concurrency: storedConfig?.concurrency ?? positiveInteger('concurrency', values.concurrency),
        ...(throughWeek === undefined ? {} : { throughWeek }),
        ...(resumeDir ? { resume: true } : {}),
        ...((storedConfig ? storedConfig.sequential_weeks === true : values['sequential-weeks'])
          ? { sequentialWeeks: true }
          : {}),
        ...((storedConfig ? storedConfig.closed_sheets === true : values['closed-sheets'])
          ? { closedSheets: true }
          : {}),
        ...(tradeWindowValue === undefined ? {} : { tradeWindow: tradeWindowValue }),
        ...execution,
        onEvent: (event) => {
          if (event.type !== 'draft') return;
          if (event.draft.phase === 'draft' && event.draft.picks.length > 0) {
            const pick = event.draft.picks[event.draft.picks.length - 1]!;
            const coach = event.draft.teamNames[pick.entrant] || event.draft.entrants[pick.entrant];
            console.log(`pick ${pick.pick}: ${coach} takes ${pick.mon}${pick.fallback ? ' (fallback)' : ''}`);
          }
          if (event.draft.teambuilds.length > lastTeambuilds) {
            lastTeambuilds = event.draft.teambuilds.length;
            const build = event.draft.teambuilds[lastTeambuilds - 1]!;
            const repaired = build.sets.filter((set) => set.repaired).length;
            console.log(
              `teambuild: ${event.draft.teamNames[build.entrant] || event.draft.entrants[build.entrant]} vs ` +
                `${event.draft.teamNames[build.opponent] || event.draft.entrants[build.opponent]} — ` +
                `${build.brought.join(', ')}${repaired ? ` (${repaired} repaired)` : ''}`,
            );
          }
        },
      }),
    );
    printResults(rows);
    const totalSeries = roundRobinWeeks(models.length).flat().length + (models.length >= 5 ? 3 : 1);
    if (rows.length < totalSeries) {
      console.log(`League paused after ${rows.length} of ${totalSeries} series.`);
      console.log(`Resume with: vgcleague draft --resume ${runDir}`);
    } else {
      const champion = rows[rows.length - 1]?.advanced;
      if (typeof champion !== 'string' || !champion) throw new Error('draft final did not identify a champion');
      console.log(`Champion: ${champion}`);
    }
    console.log(`Draft logs: ${path.join(runDir, 'draft')}`);
    console.log(`Teambuild logs: ${path.join(runDir, 'teambuild')}`);
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
    const opponent = values.opponent;
    const seat = values.seat;
    const reasoning = reasoningLevel(values.reasoning);
    const seed = optionalInteger('seed', values.seed);
    const { runExhibition } = await import('./exhibition.js');
    const runDir = makeRunDirectory();
    const row = await withRunStatus(runDir, () =>
      runExhibition(runDir, {
        opponent,
        seat,
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
          console.log(
            'Start the terminal agent with that directory as its working directory and have it read SEAT.md.',
          );
        },
      }),
    );
    printResults([row]);
    return 0;
  }
  if (command === 'publish') {
    const { values } = parseArgs({
      args: rest,
      options: {
        to: { type: 'string' },
        pool: { type: 'string' },
        'include-test': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
    const origin = (values.to ?? process.env.VGC_LEAGUE_PUBLISH_ORIGIN ?? '').trim();
    const token = (process.env.VGC_LEAGUE_IMPORT_TOKEN ?? '').trim();
    if (!origin) throw new Error('publish needs --to <origin> or VGC_LEAGUE_PUBLISH_ORIGIN');
    if (!token && !values['dry-run']) throw new Error('publish needs VGC_LEAGUE_IMPORT_TOKEN');
    const { publishRecords } = await import('./publish.js');
    const summary = await publishRecords({
      origin,
      token,
      recordsPath: RESULTS_PATH,
      runsDir: RUNS_DIR,
      teamsDir: TEAMS_DIR,
      ...(values.pool === undefined ? {} : { pool: values.pool }),
      includeTest: values['include-test'],
      dryRun: values['dry-run'],
      log: (line) => console.log(line),
    });
    if (!values['dry-run']) {
      console.log(
        `${summary.published} published, ${summary.duplicates} already present${summary.poolsCreated.length ? `, pools created: ${summary.poolsCreated.join(', ')}` : ''}`,
      );
    }
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
  for (const [index, { label, count, standings: table, h2h: matrix }] of ratingGroups(rows).entries()) {
    if (index) console.log('');
    console.log(`${label} (${count} series)`);
    console.log(
      renderTable(
        ['Model', 'Series', 'W', 'L', 'T', 'Win rate', 'Elo'],
        table.map((item) => [
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
    const specs = Object.keys(matrix);
    if (specs.length < 2) continue;
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
