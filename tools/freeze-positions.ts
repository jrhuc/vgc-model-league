#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadGameRecords, verifyGame } from '../src/eval/corpus.js';
import { legalActions } from '../src/eval/fork.js';
import {
  type CandidatePosition,
  gameOf,
  readCandidates,
  type SelectionOptions,
  selectPositions,
} from '../src/eval/positions.js';
import { DATA_DIR } from '../src/paths.js';
import type { JsonObject } from '../src/types.js';

interface Settings extends SelectionOptions {
  graded: string;
  out: string;
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    graded: path.join(DATA_DIR, 'records', 'positions.jsonl'),
    out: path.join(DATA_DIR, 'records', 'position-set.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--size' && value) settings.size = Number(value);
    else if (flag === '--seed' && value) settings.seed = value;
    else if (flag === '--per-game' && value) settings.perGame = Number(value);
    else if (flag === '--formats' && value) settings.formats = value.split(',');
    else if (flag === '--graded' && value) settings.graded = path.resolve(value);
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else continue;
    index += 1;
  }
  return settings;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const rows = fs
    .readFileSync(settings.graded, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonObject);
  const selection = selectPositions(readCandidates(rows), settings);
  process.stdout.write(
    `selected ${selection.positions.length} positions from ${selection.games} games across ${selection.strata.length} strata\n`,
  );
  for (const stratum of selection.strata) {
    process.stdout.write(`  ${stratum.key.padEnd(34)} ${String(stratum.taken).padStart(4)} of ${stratum.available}\n`);
  }

  const wanted = new Map<string, CandidatePosition[]>();
  for (const position of selection.positions) {
    wanted.set(gameOf(position), [...(wanted.get(gameOf(position)) ?? []), position]);
  }

  const records = new Map(
    loadGameRecords().map((record) => [`${record.runId}:${record.seriesId}:${record.gameNumber}`, record]),
  );
  const frozen: JsonObject[] = [];
  let missing = 0;
  for (const [game, positions] of wanted) {
    const record = records.get(game);
    const verified = record ? verifyGame(record) : null;
    if (!record || !verified) {
      missing += positions.length;
      continue;
    }
    for (const position of positions) {
      const live = verified.replay.positions[position.positionIndex];
      if (!live) {
        missing += 1;
        continue;
      }
      const request = live.requests[position.pid];
      frozen.push({
        id: digest([game, position.positionIndex, position.pid, live.snapshot]),
        source: {
          run_id: position.runId,
          series_id: position.seriesId,
          game_number: position.gameNumber,
          position_index: position.positionIndex,
          pid: position.pid,
          scaffold: position.scaffold,
          played_by: record.players[position.pid],
          played: position.played,
        },
        format: position.format,
        stratum: `${position.phase}/${position.turn}/${position.value.toFixed(2)}`,
        phase: position.phase,
        turn: live.turn,
        request,
        legal: legalActions(request),
        seen: verified.replay.pov[position.pid].slice(0, live.seen[position.pid]),
        opponent_request: live.requests[position.pid === 'p1' ? 'p2' : 'p1'],
        spread: position.spread,
        value: position.value,
        snapshot: live.snapshot,
      });
    }
  }

  const set = {
    id: digest(frozen.map((entry) => entry.id)),
    frozen_from: path.basename(settings.graded),
    criteria: { size: settings.size ?? 500, seed: settings.seed ?? 'position-set', per_game: settings.perGame ?? 3 },
    strata: selection.strata,
    positions: frozen,
  };
  fs.mkdirSync(path.dirname(settings.out), { recursive: true });
  fs.writeFileSync(settings.out, `${JSON.stringify(set, null, 2)}\n`);
  process.stdout.write(
    `\nfroze ${frozen.length} positions as ${set.id} into ${settings.out}${missing ? ` (${missing} could not be reopened)` : ''}\n`,
  );
}

await main();
