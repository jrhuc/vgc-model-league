import crypto from 'node:crypto';

import type { JsonObject } from '../types.js';

function rowGame(row: JsonObject): string {
  return `${row.run_id}:${row.series_id}:${row.game_number}`;
}

export function completedPositionScores(rows: JsonObject[], manifest: JsonObject): JsonObject[] {
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

export function canonicalScoreDigest(rows: JsonObject[]): string {
  const canonical = rows.map((row) => JSON.stringify(row)).sort();
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
