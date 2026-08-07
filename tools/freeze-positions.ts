#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadGameRecords, verifyGame } from '../src/eval/corpus.js';
import { legalActions, positionDigest } from '../src/eval/fork.js';
import {
  anonymiseLog,
  anonymiseRequest,
  type CandidatePosition,
  gameOf,
  MIN_OPPORTUNITY_SPAN,
  readCandidates,
  type SelectionOptions,
  selectPositions,
  stratumOf,
} from '../src/eval/positions.js';
import { DATA_DIR, defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import type { JsonObject } from '../src/types.js';

interface Settings extends SelectionOptions {
  graded: string;
  out: string;
  privateOut?: string;
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
    else if (flag === '--private-out' && value) settings.privateOut = path.resolve(value);
    else throw new Error(`unknown option or missing value: ${flag}`);
    index += 1;
  }
  for (const [name, value] of [
    ['size', settings.size],
    ['per-game', settings.perGame],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1))
      throw new Error(`--${name} must be a positive integer`);
  }
  if (settings.formats?.some((format) => !format.trim())) throw new Error('--formats cannot contain an empty format');
  return settings;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultPrivateOut(out: string): string {
  const extension = path.extname(out);
  const name = path.basename(out, extension);
  return path.join(path.dirname(out), 'private', `${name}${extension || '.json'}`);
}

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
}

function rowGame(row: JsonObject): string {
  return `${row.run_id}:${row.series_id}:${row.game_number}`;
}

function completedScores(rows: JsonObject[], manifest: JsonObject): JsonObject[] {
  const expectedGames = Number(manifest.source_games);
  if (!Number.isInteger(expectedGames) || expectedGames < 0)
    throw new Error('graded manifest has no valid source_games');
  const markers = new Map<string, JsonObject>();
  const scores = new Map<string, JsonObject>();
  const perGame = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind === 'game_complete' && row.complete === true) {
      const game = rowGame(row);
      if (markers.has(game)) throw new Error(`graded input has duplicate completion marker for ${game}`);
      markers.set(game, row);
      continue;
    }
    if (row.kind !== 'position_score') continue;
    if (JSON.stringify(row.counterfactual) !== JSON.stringify(manifest.counterfactual)) {
      throw new Error(`position score ${rowGame(row)} mixes a different counterfactual protocol`);
    }
    const game = rowGame(row);
    const key = `${game}#${row.position_index}#${row.pid}`;
    const prior = scores.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error(`conflicting duplicate score ${key}`);
    scores.set(key, row);
    const keys = perGame.get(game) ?? new Set<string>();
    keys.add(key);
    perGame.set(game, keys);
  }
  if (markers.size !== expectedGames) {
    throw new Error(
      `graded input is incomplete: ${markers.size} of ${expectedGames} source games have completion markers`,
    );
  }
  for (const [game, keys] of perGame) {
    const marker = markers.get(game);
    if (!marker) throw new Error(`graded input has scores for incomplete game ${game}`);
    if (Number(marker.decisions) !== keys.size) {
      throw new Error(`completion marker for ${game} reports ${marker.decisions} scores but ${keys.size} are present`);
    }
  }
  return [...scores.values()];
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const gradedManifestPath = `${settings.graded}.manifest.json`;
  const gradedManifest = readJson(gradedManifestPath);
  if (Number(gradedManifest.schema_version) < 3) throw new Error('graded manifest predates the sealed corpus protocol');
  if (gradedManifest.showdown_commit !== showdownCommit(defaultPsDir())) {
    throw new Error('graded manifest does not match the current Pokémon Showdown checkout');
  }
  const rows = fs
    .readFileSync(settings.graded, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonObject);
  const selection = selectPositions(readCandidates(completedScores(rows, gradedManifest)), settings);
  const requested = settings.size ?? 500;
  if (selection.positions.length !== requested) {
    throw new Error(
      `requested ${requested} positions but only ${selection.positions.length} satisfy the filters and per-game cap`,
    );
  }
  process.stdout.write(
    `selected ${selection.positions.length} positions from ${selection.games} games across ${selection.strata.length} strata
`,
  );
  for (const stratum of selection.strata) {
    process.stdout.write(`  ${stratum.key.padEnd(34)} ${String(stratum.taken).padStart(4)} of ${stratum.available}
`);
  }

  const wanted = new Map<string, CandidatePosition[]>();
  for (const position of selection.positions) {
    wanted.set(gameOf(position), [...(wanted.get(gameOf(position)) ?? []), position]);
  }
  const records = new Map(
    loadGameRecords().map((record) => [`${record.runId}:${record.seriesId}:${record.gameNumber}`, record]),
  );
  const publicPositions: JsonObject[] = [];
  const privatePositions: JsonObject[] = [];
  for (const [game, positions] of wanted) {
    const record = records.get(game);
    const verified = record ? verifyGame(record) : null;
    if (!record || !verified) throw new Error(`selected source game ${game} no longer replays uniquely`);
    for (const position of positions) {
      const live = verified.replay.positions[position.positionIndex];
      if (!live) throw new Error(`selected source position ${game}#${position.positionIndex} is missing`);
      const request = live.requests[position.pid];
      if (!request)
        throw new Error(`selected source decision ${game}#${position.positionIndex}#${position.pid} is missing`);
      const liveDigest = positionDigest(live, position.pid);
      if (liveDigest !== position.positionDigest) {
        throw new Error(
          `selected source decision ${game}#${position.positionIndex}#${position.pid} changed after grading`,
        );
      }
      const id = digest([game, position.positionIndex, position.pid, liveDigest]);
      publicPositions.push({
        id,
        format: position.format,
        phase: position.phase,
        turn: live.turn,
        request: anonymiseRequest(request, record.names),
        legal: legalActions(request),
        seen: anonymiseLog(verified.replay.pov[position.pid].slice(0, live.seen[position.pid]), record.names),
      });
      privatePositions.push({
        id,
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
        snapshot: live.snapshot,
        opponent_request: live.requests[position.pid === 'p1' ? 'p2' : 'p1'] ?? null,
        selection_stratum: stratumOf(position),
        opportunity_span: position.spread,
        state_value: position.value,
      });
    }
  }

  const gradedChecksum = crypto.createHash('sha256').update(fs.readFileSync(settings.graded)).digest('hex');
  const criteria = {
    size: requested,
    seed: settings.seed ?? 'position-set',
    per_game: settings.perGame ?? 3,
    formats: settings.formats ?? null,
  };
  const publicPayload = {
    schema_version: 3,
    grader_manifest: gradedManifest,
    graded_checksum: gradedChecksum,
    selection_protocol: { version: 1, minimum_opportunity_span: MIN_OPPORTUNITY_SPAN },
    criteria,
    positions: publicPositions,
  };
  const setId = digest(publicPayload);
  const publicSet = { ...publicPayload, id: setId };
  const privateSet = {
    schema_version: 3,
    id: setId,
    public_checksum: digest(publicSet),
    strata: selection.strata,
    positions: privatePositions,
  };
  const privateOut = settings.privateOut ?? defaultPrivateOut(settings.out);
  if (path.resolve(privateOut) === path.resolve(settings.out))
    throw new Error('public and private output paths must differ');
  if (
    fs.existsSync(privateOut) &&
    fs.existsSync(settings.out) &&
    fs.realpathSync(privateOut) === fs.realpathSync(settings.out)
  ) {
    throw new Error('public and private output paths resolve to the same file');
  }
  fs.mkdirSync(path.dirname(settings.out), { recursive: true });
  fs.mkdirSync(path.dirname(privateOut), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const publicTemp = `${settings.out}.${nonce}.tmp`;
  const privateTemp = `${privateOut}.${nonce}.tmp`;
  fs.writeFileSync(
    publicTemp,
    `${JSON.stringify(publicSet, null, 2)}
`,
  );
  fs.writeFileSync(
    privateTemp,
    `${JSON.stringify(privateSet, null, 2)}
`,
  );
  fs.renameSync(privateTemp, privateOut);
  fs.renameSync(publicTemp, settings.out);
  process.stdout.write(`
froze ${publicPositions.length} public tasks as ${setId} into ${settings.out}
`);
  process.stdout.write(`wrote sealed grader state to ${privateOut}; never pass that file to a model
`);
}

await main();
