import fs from 'node:fs';
import path from 'node:path';

import type { PoolInfo } from './gui/api.js';
import { defaultPsDir, TEAMS_DIR } from './paths.js';
import { loadShowdown } from './showdown.js';
import type { JsonObject } from './types.js';
import { asRecords, text } from './value.js';

const POOL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface TeamProvenance {
  placement: number | null;
  player: string;
  handle: string;
  swiss: string;
  paste: string;
}

export interface PoolEvent {
  name: string;
  game: string;
  regulation: string;
  location: string;
  dates: string;
  players: number | null;
  structure: string;
  url: string;
  cut: number | null;
  reconstructedSpreads: boolean;
}

/**
 * `provenance` is the normalized reading the views share. `source` keeps the manifest block
 * verbatim because each event names its own extra keys, and republishing must not drop them.
 */
export interface Team {
  id: string;
  packed: string;
  seed?: number;
  provenance?: TeamProvenance;
  source?: JsonObject;
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

/** The manifest blocks a pool cannot be rebuilt from its team files alone. */
export interface PoolMetadata {
  event?: JsonObject;
  spreads?: JsonObject;
}

export interface TeamPool {
  id: string;
  format: string;
  teams: Team[];
  event: PoolEvent | null;
  metadata: PoolMetadata;
}

function block(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function readMetadata(manifest: Record<string, unknown>): PoolMetadata {
  const event = block(manifest.event);
  const spreads = block(manifest.spreads);
  return { ...(event ? { event } : {}), ...(spreads ? { spreads } : {}) };
}

function readEvent(manifest: Record<string, unknown>): PoolEvent | null {
  const event = block(manifest.event);
  if (!event) return null;
  const spreads = block(manifest.spreads) ?? {};
  return {
    name: text(event.name),
    game: text(event.game),
    regulation: text(event.regulation),
    location: text(event.location),
    dates: text(event.dates),
    players: typeof event.players === 'number' ? event.players : null,
    structure: text(event.structure),
    url: text(event.url),
    cut: typeof event.cut === 'number' ? event.cut : null,
    reconstructedSpreads: spreads.reconstructed === true,
  };
}

function readProvenance(entry: Record<string, unknown>): TeamProvenance | undefined {
  const record = block(entry.source);
  if (!record) return undefined;
  return {
    placement: typeof record.placement === 'number' ? record.placement : null,
    player: text(record.player),
    handle: text(record.handle),
    swiss: text(record.swiss),
    paste: text(record.paste),
  };
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
    const provenance = readProvenance(entry);
    const source = block(entry.source);
    return {
      id: teamId,
      packed,
      ...(typeof entry.seed === 'number' ? { seed: entry.seed } : {}),
      ...(provenance ? { provenance } : {}),
      ...(source ? { source } : {}),
    };
  });
  const seeded = teams.filter((team) => team.seed !== undefined);
  if (seeded.length && seeded.length !== teams.length)
    throw new Error(`${manifestPath} seeds only ${seeded.length} of ${teams.length} teams`);
  if (new Set(seeded.map((team) => team.seed)).size !== seeded.length)
    throw new Error(`${manifestPath} repeats a seed`);
  return { id, format, teams, event: readEvent(manifest), metadata: readMetadata(manifest) };
}

type ShowdownSets = NonNullable<ReturnType<ReturnType<typeof loadShowdown>['Teams']['unpack']>>;

function removeUnsupportedMetadata(sets: ShowdownSets, format: string | undefined, psDir: string): void {
  if (!format) return;
  const { Dex } = loadShowdown(psDir);
  if (!Dex.formats.get(format).mod.startsWith('champions')) return;
  for (const set of sets) delete set.teraType;
}

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

export function normalizePackedTeam(packed: string, psDir = defaultPsDir(), format?: string): string {
  const { Teams } = loadShowdown(psDir);
  const sets = Teams.unpack(packed);
  if (!sets) throw new Error('packed team does not unpack');
  enforceBaseFormes(sets, psDir);
  removeUnsupportedMetadata(sets, format, psDir);
  const repacked = Teams.pack(sets);
  if (!repacked) throw new Error('Showdown produced an empty packed team');
  return repacked;
}

export function packTeam(exportText: string, psDir = defaultPsDir(), format?: string): string {
  const { Teams } = loadShowdown(psDir);
  const team = Teams.import(exportText);
  if (!team) throw new Error('Showdown could not parse team export');
  enforceBaseFormes(team, psDir);
  removeUnsupportedMetadata(team, format, psDir);
  const packed = Teams.pack(team);
  if (!packed) throw new Error('Showdown produced an empty packed team');
  return packed;
}

export function exportTeam(packed: string, format: string, psDir = defaultPsDir()): string {
  const { Teams } = loadShowdown(psDir);
  const sets = Teams.unpack(packed);
  if (!sets) throw new Error('packed team does not unpack');
  removeUnsupportedMetadata(sets, format, psDir);
  return Teams.export(sets);
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
  seed?: number;
  source?: JsonObject;
}

export interface PoolContents extends PoolMetadata {
  teams: TeamDraft[];
}

interface TeamMember {
  species: string;
  item: string;
  ability: string;
  moves: string[];
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
    });
  }
  return { species, members };
}

export function inspectTeam(paste: string, format: string, psDir = defaultPsDir()): TeamInspection {
  let packed: string;
  try {
    packed = packTeam(paste, psDir, format);
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
  contents: PoolContents,
  teamsDir = TEAMS_DIR,
  psDir = defaultPsDir(),
): string {
  const drafts = contents.teams;
  if (!POOL_SLUG.test(name)) throw new Error('pool name must be lowercase letters, digits, and dashes');
  if (!format.endsWith('bo3')) throw new Error('format must be a Pokémon Showdown BO3 format id (ending in "bo3")');
  if (drafts.length < 2) throw new Error('a pool needs at least two teams');
  if (drafts.length > 32) throw new Error('a pool supports at most 32 teams');
  const poolDir = path.resolve(teamsDir, name);
  if (fs.existsSync(poolDir))
    throw new Error(`pool ${JSON.stringify(name)} already exists; pools are immutable snapshots, so pick a new name`);
  const seenIds = new Set<string>();
  const seenTeams = new Map<string, string>();
  const teams = drafts.map((draft) => {
    const id = draft.id.trim();
    if (!POOL_SLUG.test(id))
      throw new Error(`team id ${JSON.stringify(draft.id)} must be lowercase letters, digits, and dashes`);
    if (seenIds.has(id)) throw new Error(`duplicate team id ${JSON.stringify(id)}`);
    seenIds.add(id);
    const packed = packTeam(draft.paste, psDir, format);
    try {
      validateTeam(packed, format, psDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`team ${JSON.stringify(id)} is not legal in ${format}:\n${detail}`);
    }
    const clash = seenTeams.get(packed);
    if (clash) throw new Error(`team ${JSON.stringify(id)} is byte-for-byte the same team as ${JSON.stringify(clash)}`);
    seenTeams.set(packed, id);
    return { id, packed, draft };
  });
  fs.mkdirSync(poolDir, { recursive: true });
  for (const team of teams) fs.writeFileSync(path.join(poolDir, `${team.id}.team`), `${team.packed}\n`, 'utf8');
  const manifest = {
    id: name,
    format,
    ...(contents.event ? { event: contents.event } : {}),
    ...(contents.spreads ? { spreads: contents.spreads } : {}),
    teams: teams.map((team) => ({
      id: team.id,
      file: `${team.id}.team`,
      ...(typeof team.draft.seed === 'number' ? { seed: team.draft.seed } : {}),
      ...(team.draft.source ? { source: team.draft.source } : {}),
    })),
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
