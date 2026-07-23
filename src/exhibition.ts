import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LLMEngine, type RandomEngine, scaffoldRevision } from './engines.js';
import { defaultPsDir, RESULTS_PATH } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { parseSpec, validateReasoning } from './providers.js';
import { resolveSeed, seededRng } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import { ShowdownReference } from './reference.js';
import { ROTATION_PROTOCOL_VERSION } from './rotation.js';
import { SeatBridge } from './seat.js';
import { makeEngine, playBo3 } from './series.js';
import { showdownCommit } from './showdown.js';
import type { Team } from './teams.js';
import { loadPool, validatePool } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { Pid } from './types.js';

export interface ExhibitionOptions {
  opponent: string;
  seat?: Pid;
  name?: string;
  pool?: string;
  seed?: number;
  reasoning?: ReasoningLevel;
  port?: number;
  psDir?: string;
  recordsPath?: string;
  agentDir?: string;
  onNotice?: (line: string) => void;
  onReady?: (info: { url: string; agentDir: string }) => void;
}

/** External seat bridge; only that seat's view crosses the process boundary, and the result is unrated. */
export async function runExhibition(runDir: string, options: ExhibitionOptions): Promise<SeriesRecord> {
  const seatSide: Pid = options.seat ?? 'p1';
  const oppSide: Pid = seatSide === 'p1' ? 'p2' : 'p1';
  const seatName = options.name ?? 'cli-agent';
  if (options.opponent !== 'random') validateReasoning(parseSpec(options.opponent), options.reasoning);
  const notice = options.onNotice ?? (() => {});
  const psDir = options.psDir ?? defaultPsDir();
  const pool = loadPool(options.pool ?? 'test');
  validatePool(pool, psDir);
  const seed = resolveSeed(options.seed);
  const random = seededRng(seed);
  const firstTeam = Math.floor(random() * pool.teams.length);
  let secondTeam = Math.floor(random() * (pool.teams.length - 1));
  if (secondTeam >= firstTeam) secondTeam += 1;
  const teams: Record<Pid, Team> = { p1: pool.teams[firstTeam]!, p2: pool.teams[secondTeam]! };
  const gameSeeds = Array.from(
    { length: 3 },
    () => Array.from({ length: 4 }, () => 1 + Math.floor(random() * 0xffff)) as [number, number, number, number],
  );
  const engineSeed = Math.floor(random() * Number.MAX_SAFE_INTEGER);

  const seriesId = randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = path.join(runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const scaffold = scaffoldRevision();
  const players: Record<Pid, string> = { p1: '', p2: '' };
  players[seatSide] = seatName;
  players[oppSide] = options.opponent;
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify(
      {
        mode: 'exhibition',
        protocol_version: ROTATION_PROTOCOL_VERSION,
        scaffold,
        seat: seatSide,
        players,
        seed,
        reasoning: options.reasoning ?? null,
        pool: pool.id,
        format: pool.format,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const reference = new ShowdownReference(pool.format, psDir);
  const toolLog = path.join(seriesDir, `${seatSide}-bridge-tools.jsonl`);
  const bridge = new SeatBridge({
    lookup: (name, args) => reference.lookup(name, args),
    onExchange: (view) =>
      notice(`seat ${view.phase} exchange ${view.id} pending; the agent should run: node seat.mjs wait`),
    onTool: (name, args, result) =>
      fs.appendFileSync(
        toolLog,
        `${JSON.stringify({ timestamp: new Date().toISOString(), name, arguments: args, result })}\n`,
        'utf8',
      ),
  });

  try {
    const url = await bridge.listen(options.port ?? 0);
    const agentDir = options.agentDir ?? path.join(runDir, 'agent');
    writeAgentWorkspace(agentDir, url, bridge.token, seatName);
    bridge.status = {
      state: 'running',
      seat: seatSide,
      players,
      pool: pool.id,
      format: pool.format,
      game: 0,
      score: { p1: 0, p2: 0 },
    };
    options.onReady?.({ url, agentDir });

    const names: Record<Pid, string> = { p1: `p1-${players.p1}`, p2: `p2-${players.p2}` };
    const engines = {
      [seatSide]: new LLMEngine(seatSide, seatName, {
        provider: bridge.provider(),
        decisionLog: path.join(seriesDir, `${seatSide}-decisions.jsonl`),
        traceLog: path.join(seriesDir, `${seatSide}-trace.jsonl`),
        format: pool.format,
        psDir,
        reference,
      }),
      [oppSide]: makeEngine(
        oppSide,
        options.opponent,
        engineSeed,
        path.join(seriesDir, `${oppSide}-decisions.jsonl`),
        path.join(seriesDir, `${oppSide}-trace.jsonl`),
        pool.format,
        psDir,
        options.reasoning,
        reference,
      ),
    } as Record<Pid, LLMEngine | RandomEngine>;

    const result = await playBo3({
      engines,
      names,
      players,
      teams,
      gameSeeds,
      seriesId,
      seriesDir,
      format: pool.format,
      psDir,
      timerScale: DEFAULT_TIMER_SCALE,
      onGameStart: (game) => {
        bridge.status = { ...bridge.status, game };
        notice(`game ${game} started`);
      },
      onGameEnd: (game, winner, turns, score) => {
        bridge.status = { ...bridge.status, game, score };
        notice(`game ${game}: ${winner ?? 'tie'} (${score.p1}-${score.p2}, ${turns} turns)`);
      },
    });

    const winnerSide = result.winnerSide;
    const row: SeriesRecord = {
      schema_version: 1,
      mode: 'exhibition',
      protocol_version: ROTATION_PROTOCOL_VERSION,
      scaffold,
      timestamp: new Date().toISOString(),
      run_id: path.basename(runDir),
      series_id: seriesId,
      series_index: 0,
      format: pool.format,
      pool: pool.id,
      seat: seatSide,
      players,
      teams: { p1: teams.p1.id, p2: teams.p2.id },
      winner: winnerSide ? players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      score: result.score,
      turns: result.games.reduce((sum, game) => sum + Number(game.turns), 0),
      games: result.games,
      run_seed: seed,
      engine_seeds: { [oppSide]: engineSeed },
      reasoning: options.reasoning ?? null,
      decision_stats: Object.fromEntries((['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()])),
      ps_commit: showdownCommit(psDir),
    };
    appendRow(options.recordsPath ?? RESULTS_PATH, row);
    bridge.status = { ...bridge.status, state: 'done', winner: row.winner ?? null };
    return row;
  } finally {
    bridge.close();
  }
}

function writeAgentWorkspace(agentDir: string, url: string, token: string, seatName: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'seat.json'),
    `${JSON.stringify({ url, token, name: seatName }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(agentDir, 'seat.mjs'), SEAT_CLIENT, 'utf8');
  fs.writeFileSync(path.join(agentDir, 'SEAT.md'), SEAT_INSTRUCTIONS, 'utf8');
}

const SEAT_CLIENT = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'seat.json'), 'utf8'));

async function call(route, body) {
  const response = await fetch(config.url + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? response.status + ' ' + response.statusText);
  return data;
}

function printExchange(exchange) {
  console.log('--- ' + exchange.phase + ' exchange ' + exchange.id + ' ---');
  console.log(exchange.prompt);
  console.log('--- reply: write the JSON response to a file, then: node seat.mjs submit <file> ---');
}

const cliArgs = process.argv.slice(2);
const force = cliArgs.includes('--force');
const [command, ...args] = cliArgs.filter((value) => value !== '--force');

const commands = {
  async status() {
    console.log(JSON.stringify(await call('/status'), null, 2));
  },
  async wait() {
    for (;;) {
      const data = await call('/poll', { waitMs: 25000 });
      if (data.exchange) return printExchange(data.exchange);
      if (data.status?.state === 'done') return console.log('Series over; no further exchanges.');
    }
  },
  async show() {
    const data = await call('/poll', { waitMs: 0 });
    if (data.exchange) printExchange(data.exchange);
    else console.log('No exchange pending.');
  },
  async system() {
    const data = await call('/poll', { waitMs: 0 });
    console.log(data.exchange ? data.exchange.system : 'No exchange pending.');
  },
  async messages() {
    console.log(JSON.stringify(await call('/messages'), null, 2));
  },
  async tools() {
    const data = await call('/tools');
    for (const tool of data.tools) {
      console.log(tool.name + ': ' + tool.description);
      console.log('  parameters: ' + JSON.stringify(tool.parameters));
    }
  },
  async tool() {
    const [name, json] = args;
    if (!name) throw new Error("usage: node seat.mjs tool <name> '<json arguments>'");
    const data = await call('/tool', { name, arguments: json ? JSON.parse(json) : {} });
    console.log(data.result);
  },
  async submit() {
    const source = args[0] && args[0] !== '-' ? fs.readFileSync(args[0], 'utf8') : fs.readFileSync(0, 'utf8');
    const current = await call('/poll', { waitMs: 0 });
    if (!current.exchange) throw new Error('no exchange is pending');
    const needed = current.exchange.phase === 'decision' ? '"choices"' : '"summary"';
    if (!source.includes(needed) && !force)
      throw new Error('response contains no ' + needed + ' key; pass --force to submit anyway');
    const data = await call('/submit', { id: current.exchange.id, text: source });
    console.log('Submitted exchange ' + data.id + '.');
  },
};

const run = commands[command];
if (!run) {
  console.log('Usage: node seat.mjs <status|wait|show|system|messages|tools|tool|submit> [args] [--force]');
  process.exitCode = 2;
} else {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
`;

const SEAT_INSTRUCTIONS = `# Seat instructions

You are playing one side of a Pokémon VGC best-of-three hosted by a separate process.
Everything you may know arrives through \`seat.mjs\`. The host holds both sides'
hidden information, so work only inside this directory.

Loop:

1. \`node seat.mjs wait\`: blocks until the host needs your response, then prints the prompt.
2. Think. For mechanics questions use the lookup tools: \`node seat.mjs tools\` lists them,
   \`node seat.mjs tool <name> '<json arguments>'\` runs one.
3. Write your JSON reply to a file, then \`node seat.mjs submit <file>\`.
4. Repeat until \`wait\` reports the series is over or the host is gone.

Two exchange kinds:

- **decision**: pick actions from the numbered menus. The exact required JSON reply format
  is in the system prompt: print it once with \`node seat.mjs system\`.
- **reflection**: after each game, return the requested game-review JSON.

Notes:

- An invalid reply gets one correction exchange; a second invalid reply forfeits that
  decision to a default legal action.
- There is no move timer. Take the time you need, but submit every exchange; the game
  cannot continue without you.
- \`node seat.mjs status\` shows the game number and series score.
- When the host process exits, requests fail with a connection error; the series is over.
`;
