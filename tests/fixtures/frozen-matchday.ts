import fs from 'node:fs';
import path from 'node:path';
import { FROZEN_MATCHDAY_FORMAT, type FrozenMatchdayRefereeOptions } from '../../src/frozen-matchday-referee.js';
import { TEAMS_DIR } from '../../src/paths.js';
import { loadShowdown } from '../../src/showdown.js';
import { type TeamBuildSubmissionValidation, validateTeamBuildSubmission } from '../../src/teambuild.js';

const Showdown = loadShowdown();
export const MATCHDAY_FORMAT = FROZEN_MATCHDAY_FORMAT;
export const MATCHDAY_TEAM_A = fs
  .readFileSync(path.join(TEAMS_DIR, 'test', 'jpnats-mega-swampert.team'), 'utf8')
  .trim();
export const MATCHDAY_TEAM_B = fs
  .readFileSync(path.join(TEAMS_DIR, 'test', 'rios-mega-raichu-x-venusaur.team'), 'utf8')
  .trim();
export const MATCHDAY_SEEDS = [
  [101, 202, 303, 404],
  [501, 602, 703, 804],
  [901, 1002, 1103, 1204],
] as const;

export function acceptedMatchdayConstruction(packed: string, model: string): TeamBuildSubmissionValidation {
  const unpacked = Showdown.Teams.unpack(packed);
  if (!unpacked) throw new Error('matchday fixture team must unpack');
  const candidates = unpacked.map((set, index) => {
    const species = Showdown.Dex.species.get(set.species);
    const item = Showdown.Dex.items.get(set.item);
    const formeName = item.megaStone?.[species.name];
    const forme = formeName ? Showdown.Dex.species.get(formeName) : undefined;
    return {
      id: `${model}-${index}`,
      name: forme?.name ?? species.name,
      species: species.name,
      ...(forme ? { forme: forme.name, item: item.name } : {}),
      base: species.name,
      types: [...(forme ?? species).types],
    };
  });
  const task = {
    id: `${model}-construction`,
    model,
    format: MATCHDAY_FORMAT,
    sheetPolicy: 'open' as const,
    executionPolicy: 'strict' as const,
    constraint: { kind: 'frozen-candidate-pool' as const, id: 'fixture', teamSize: 6, candidates },
    objective: { kind: 'general' as const },
    notebook: `${model} initial notebook`,
    provenance: { source: 'frozen-matchday-test' },
  };
  const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
  const response = JSON.stringify({
    sets: unpacked.map((set, index) => ({
      id: candidates[index]?.id,
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: [...set.moves],
      evs: Object.fromEntries(stats.map((stat) => [stat, set.evs?.[stat] ?? 0])),
      note: '',
    })),
  });
  const result = validateTeamBuildSubmission(task, response, {
    attempts: 1,
    createdAt: '2026-08-08T00:00:00.000Z',
  });
  if (result.status !== 'accepted') {
    throw new Error(`matchday fixture must be an accepted construction: ${JSON.stringify(result)}`);
  }
  return result;
}

export function frozenMatchdayOptions(): FrozenMatchdayRefereeOptions {
  return {
    format: MATCHDAY_FORMAT,
    gameSeeds: MATCHDAY_SEEDS,
    seats: [
      { pid: 'p1', name: 'alpha', construction: acceptedMatchdayConstruction(MATCHDAY_TEAM_A, 'alpha') },
      { pid: 'p2', name: 'beta', construction: acceptedMatchdayConstruction(MATCHDAY_TEAM_B, 'beta') },
    ],
  };
}
