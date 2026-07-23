import fs from 'node:fs';
import path from 'node:path';

import type { PoolInfo } from './gui/api.js';
import { defaultPsDir, TEAMS_DIR } from './paths.js';
import { loadShowdown } from './showdown.js';
import { asRecords, text } from './value.js';

const POOL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface Team {
  id: string;
  packed: string;
}

export function listPools(teamsDir = TEAMS_DIR): PoolInfo[] {
  const pools: PoolInfo[] = [];
  for (const name of fs.existsSync(teamsDir)
    ? fs
        .readdirSync(teamsDir)
        .filter((entry) => POOL_SLUG.test(entry))
        .sort()
    : []) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(teamsDir, name, 'pool.json'), 'utf8')) as {
        id?: string;
        format?: string;
        teams?: unknown[];
      };
      pools.push({
        name,
        id: manifest.id ?? name,
        format: manifest.format ?? '?',
        teamCount: Array.isArray(manifest.teams) ? manifest.teams.length : 0,
      });
    } catch {}
  }
  return pools;
}

export interface TeamPool {
  id: string;
  format: string;
  teams: Team[];
}

export function loadPool(name = 'test', teamsDir = TEAMS_DIR): TeamPool {
  if (!POOL_SLUG.test(name)) throw new Error('pool name must be lowercase letters, digits, and dashes');
  const poolDir = path.resolve(teamsDir, name);
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
    if (!POOL_SLUG.test(teamId)) throw new Error(`invalid team id ${JSON.stringify(teamId)} in ${manifestPath}`);
    if (!filename) throw new Error(`every team in ${manifestPath} needs a file`);
    if (seen.has(teamId)) throw new Error(`duplicate team id ${JSON.stringify(teamId)} in ${manifestPath}`);
    seen.add(teamId);
    const teamPath = path.resolve(poolDir, filename);
    if (path.dirname(teamPath) !== poolDir || path.basename(teamPath) !== filename) {
      throw new Error(`team file ${JSON.stringify(filename)} escapes its pool directory`);
    }
    const stats = fs.lstatSync(teamPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`team file ${JSON.stringify(filename)} must be a regular file`);
    }
    const packed = fs.readFileSync(teamPath, 'utf8').trim();
    if (!packed) throw new Error(`team ${JSON.stringify(teamId)} is empty`);
    return { id: teamId, packed };
  });
  return { id, format, teams };
}

type ShowdownSets = NonNullable<ReturnType<ReturnType<typeof loadShowdown>['Teams']['unpack']>>;

function enforceBaseFormes(sets: ShowdownSets, psDir = defaultPsDir()): void {
  const { Dex } = loadShowdown(psDir);
  for (const set of sets) {
    const species = Dex.species.get(set.species || set.name);
    if (!species.exists || (!species.isMega && species.forme !== 'Primal')) continue;
    const required = species.requiredItem ?? '';
    const stone = required ? Dex.items.get(required) : undefined;
    const baseName =
      Object.entries(stone?.megaStone ?? {}).find(([, mega]) => id(mega) === id(species.name))?.[0] ??
      species.baseSpecies;
    const base = Dex.species.get(baseName);
    if (!required || id(set.item ?? '') !== id(required)) {
      throw new Error(
        `${species.name} must be entered as ${base.name} holding ${required || 'its trigger item'}: team sheets use base formes`,
      );
    }
    const baseAbilities = Object.values(base.abilities).filter(Boolean);
    if (set.ability && !baseAbilities.some((ability) => id(ability) === id(set.ability))) {
      throw new Error(
        `${species.name} must use one of ${base.name}'s abilities (${baseAbilities.join('/')}), not ${set.ability}`,
      );
    }
    if (!set.name || id(set.name) === id(species.name)) set.name = base.name;
    set.species = base.name;
  }
}

export function normalizePackedTeam(packed: string, psDir = defaultPsDir()): string {
  const { Teams } = loadShowdown(psDir);
  const sets = Teams.unpack(packed);
  if (!sets) throw new Error('packed team does not unpack');
  enforceBaseFormes(sets, psDir);
  const repacked = Teams.pack(sets);
  if (!repacked) throw new Error('Showdown produced an empty packed team');
  return repacked;
}

export function packTeam(exportText: string, psDir = defaultPsDir()): string {
  const { Teams } = loadShowdown(psDir);
  const team = Teams.import(exportText);
  if (!team) throw new Error('Showdown could not parse team export');
  enforceBaseFormes(team, psDir);
  const packed = Teams.pack(team);
  if (!packed) throw new Error('Showdown produced an empty packed team');
  return packed;
}

export function validateTeam(packed: string, format: string, psDir = defaultPsDir()): void {
  const { Dex, Teams, TeamValidator } = loadShowdown(psDir);
  const sets = Teams.unpack(packed) ?? [];
  for (const set of sets) {
    const species = Dex.species.get(set.species || set.name);
    if (!species.exists || (!species.isMega && species.forme !== 'Primal')) continue;
    const required = species.requiredItem ?? '';
    const stone = required ? Dex.items.get(required) : undefined;
    const baseName =
      Object.entries(stone?.megaStone ?? {}).find(([, mega]) => id(mega) === id(species.name))?.[0] ??
      species.baseSpecies;
    throw new Error(
      `${species.name} must be entered as ${baseName} holding ${required || 'its trigger item'}: team sheets use base formes`,
    );
  }
  const problems = new TeamValidator(format).validateTeam(sets);
  if (problems?.length) throw new Error(problems.join('\n'));
}

export interface TeamDraft {
  id: string;
  paste: string;
}

interface TeamMember {
  species: string;
  item: string;
  ability: string;
  moves: string[];
  teraType: string;
}

interface TeamInspection {
  species: string[];
  problems: string[];
  members: TeamMember[];
}

function unpackTeam(packed: string, psDir: string): { species: string[]; members: TeamMember[] } {
  const { Teams } = loadShowdown(psDir);
  const sets = Teams.unpack(packed) ?? [];
  const species: string[] = [];
  const members: TeamMember[] = [];
  for (const set of sets) {
    const memberSpecies = set.species || set.name || 'Pokémon';
    species.push(memberSpecies);
    members.push({
      species: memberSpecies,
      item: set.item,
      ability: set.ability,
      moves: set.moves,
      teraType: set.teraType ?? '',
    });
  }
  return { species, members };
}

export function inspectTeam(paste: string, format: string, psDir = defaultPsDir()): TeamInspection {
  let packed: string;
  try {
    packed = packTeam(paste, psDir);
  } catch (error) {
    return { species: [], problems: [error instanceof Error ? error.message : String(error)], members: [] };
  }
  const { species, members } = unpackTeam(packed, psDir);
  try {
    validateTeam(packed, format, psDir);
    return { species, problems: [], members };
  } catch (error) {
    return { species, problems: (error instanceof Error ? error.message : String(error)).split('\n'), members };
  }
}

export function createPool(
  name: string,
  format: string,
  drafts: TeamDraft[],
  teamsDir = TEAMS_DIR,
  psDir = defaultPsDir(),
): string {
  if (!POOL_SLUG.test(name)) throw new Error('pool name must be lowercase letters, digits, and dashes');
  if (!format.endsWith('bo3')) throw new Error('format must be a Pokémon Showdown BO3 format id (ending in "bo3")');
  if (drafts.length < 2) throw new Error('a pool needs at least two teams');
  if (drafts.length > 32) throw new Error('a pool supports at most 32 teams');
  const poolDir = path.resolve(teamsDir, name);
  if (fs.existsSync(poolDir))
    throw new Error(`pool ${JSON.stringify(name)} already exists; pools are immutable snapshots, so pick a new name`);
  const seenIds = new Set<string>();
  const seenSpecies = new Map<string, string>();
  const teams = drafts.map((draft) => {
    const id = draft.id.trim();
    if (!POOL_SLUG.test(id))
      throw new Error(`team id ${JSON.stringify(draft.id)} must be lowercase letters, digits, and dashes`);
    if (seenIds.has(id)) throw new Error(`duplicate team id ${JSON.stringify(id)}`);
    seenIds.add(id);
    const packed = packTeam(draft.paste, psDir);
    try {
      validateTeam(packed, format, psDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`team ${JSON.stringify(id)} is not legal in ${format}:\n${detail}`);
    }
    const speciesKey = unpackTeam(packed, psDir)
      .species.map((species) => species.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .sort()
      .join(',');
    const clash = seenSpecies.get(speciesKey);
    if (clash) throw new Error(`team ${JSON.stringify(id)} has the same species set as ${JSON.stringify(clash)}`);
    seenSpecies.set(speciesKey, id);
    return { id, packed };
  });
  fs.mkdirSync(poolDir, { recursive: true });
  for (const team of teams) fs.writeFileSync(path.join(poolDir, `${team.id}.team`), `${team.packed}\n`, 'utf8');
  const manifest = {
    id: name,
    format,
    teams: teams.map((team) => ({ id: team.id, file: `${team.id}.team` })),
  };
  fs.writeFileSync(path.join(poolDir, 'pool.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return poolDir;
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
