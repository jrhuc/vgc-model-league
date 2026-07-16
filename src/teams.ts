import fs from 'node:fs';
import path from 'node:path';

import { defaultPsDir, TEAMS_DIR } from './paths.js';
import { loadShowdown } from './showdown.js';
import { asRecords, text } from './value.js';

export interface Team {
  id: string;
  packed: string;
}

export interface TeamPool {
  id: string;
  format: string;
  teams: Team[];
}

export function loadPool(name = 'test', teamsDir = TEAMS_DIR): TeamPool {
  const poolDir = path.join(teamsDir, name);
  const manifestPath = path.join(poolDir, 'pool.json');
  const data: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`invalid pool manifest ${manifestPath}`);
  }
  const manifest = data as Record<string, unknown>;
  const id = text(manifest.id);
  const format = text(manifest.format);
  const entries = asRecords(manifest.teams);
  if (!id) throw new Error(`${manifestPath} needs a pool id`);
  if (!format.endsWith('bo3')) throw new Error(`${manifestPath} needs a Pokémon Showdown BO3 format`);
  if (entries.length < 2) throw new Error(`${manifestPath} must contain at least two teams`);

  const seen = new Set<string>();
  const teams = entries.map((entry) => {
    const teamId = text(entry.id);
    const filename = text(entry.file);
    if (!teamId) throw new Error(`every team in ${manifestPath} needs an id`);
    if (!filename) throw new Error(`every team in ${manifestPath} needs a file`);
    if (seen.has(teamId)) throw new Error(`duplicate team id ${JSON.stringify(teamId)} in ${manifestPath}`);
    seen.add(teamId);
    const packed = fs.readFileSync(path.join(poolDir, filename), 'utf8').trim();
    if (!packed) throw new Error(`team ${JSON.stringify(teamId)} is empty`);
    return { id: teamId, packed };
  });
  return { id, format, teams };
}

export function packTeam(exportText: string, psDir = defaultPsDir()): string {
  const { Teams } = loadShowdown(psDir);
  const team = Teams.import(exportText);
  if (!team) throw new Error('Showdown could not parse team export');
  const packed = Teams.pack(team);
  if (!packed) throw new Error('Showdown produced an empty packed team');
  return packed;
}

export function validateTeam(packed: string, format: string, psDir = defaultPsDir()): void {
  const { Teams, TeamValidator } = loadShowdown(psDir);
  const problems = new TeamValidator(format).validateTeam(Teams.unpack(packed));
  if (problems?.length) throw new Error(problems.join('\n'));
}

export function validatePool(pool: TeamPool, psDir = defaultPsDir()): void {
  for (const team of pool.teams) {
    try {
      validateTeam(team.packed, pool.format, psDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid team ${JSON.stringify(team.id)}: ${detail}`);
    }
  }
}
