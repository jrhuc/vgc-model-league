#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPsDir } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { packTeam, validateTeam } from '../src/teams.js';
import { asRecords, text } from '../src/value.js';
import { publishPool } from './pool-output.js';

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const STAT_LABELS: Record<(typeof STATS)[number], string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

type Stat = (typeof STATS)[number];
type Spread = Record<Stat, number>;

interface OpenSet {
  species: string;
  item: string;
  ability: string;
  nature: string;
  level: number;
  moves: string[];
}

interface CorpusSet extends OpenSet {
  evs: Spread;
  paste: string;
}

interface ResolvedSpread {
  evs: Spread;
  basis: string;
  from: string;
  itemMatched: boolean;
  shared: number;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function spreadText(evs: Spread): string {
  return (
    STATS.filter((stat) => evs[stat] > 0)
      .map((stat) => `${evs[stat]} ${STAT_LABELS[stat]}`)
      .join(' / ') || '0 HP'
  );
}

function checkSpread(evs: Spread, label: string): void {
  const total = STATS.reduce((sum, stat) => sum + evs[stat], 0);
  if (total > 66) throw new Error(`${label}: ${total} stat points exceeds the Champions limit of 66`);
  for (const stat of STATS) {
    if (evs[stat] > 32) throw new Error(`${label}: ${evs[stat]} ${STAT_LABELS[stat]} exceeds the per-stat cap of 32`);
  }
}

function parseSpread(value: string, label: string): Spread {
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const part of value.split('/')) {
    const match = /^\s*(\d+)\s+([A-Za-z]+)\s*$/.exec(part);
    if (!match) throw new Error(`${label}: could not read stat points from ${JSON.stringify(part)}`);
    const stat = STATS.find((candidate) => STAT_LABELS[candidate].toLowerCase() === match[2]!.toLowerCase());
    if (!stat) throw new Error(`${label}: unknown stat ${JSON.stringify(match[2])}`);
    evs[stat] = Number(match[1]);
  }
  checkSpread(evs, label);
  return evs;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'vgc-model-league-pool-builder', accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchOpenList(url: string): Promise<OpenSet[]> {
  const id = url.replace(/\/$/, '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`could not read a paste id from ${url}`);
  const body: unknown = JSON.parse(
    await fetchText(`https://vrpaste-backend.vercel.app/api/paste/${id}?lang=english`, 'application/json'),
  );
  const record = body as Record<string, unknown>;
  const sets = asRecords(record.teams);
  if (!sets.length) throw new Error(`${url} returned no team`);
  return sets.map((set) => ({
    species: text(set.species),
    item: text(set.item),
    ability: text(set.ability),
    nature: text(set.nature),
    level: typeof set.level === 'number' ? set.level : 50,
    moves: Array.isArray(set.moves) ? set.moves.map(String) : [],
  }));
}

async function fetchCorpus(csvUrl: string, psDir: string): Promise<CorpusSet[]> {
  const { Teams } = loadShowdown(psDir);
  const csv = await fetchText(csvUrl, 'text/csv');
  const pastes = [...new Set(csv.match(/https:\/\/pokepast\.es\/[0-9a-f]+/g) ?? [])].sort();
  if (!pastes.length) throw new Error(`no pokepaste links found in ${csvUrl}`);
  const raw = await Promise.all(
    pastes.map(async (paste) => {
      try {
        return { paste, body: await fetchText(`${paste}/raw`, 'text/plain') };
      } catch {
        return { paste, body: '' };
      }
    }),
  );
  const corpus: CorpusSet[] = [];
  for (const { paste, body } of raw) {
    if (!body.trim()) continue;
    for (const set of Teams.import(body) ?? []) {
      const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
      for (const stat of STATS) evs[stat] = set.evs?.[stat] ?? 0;
      if (STATS.every((stat) => evs[stat] === 0)) continue;
      corpus.push({
        species: set.species || set.name || '',
        item: set.item ?? '',
        ability: set.ability ?? '',
        nature: set.nature ?? '',
        level: set.level ?? 50,
        moves: set.moves ?? [],
        evs,
        paste,
      });
    }
  }
  console.log(`corpus: ${corpus.length} sets with stat points from ${raw.filter((entry) => entry.body).length} pastes`);
  return corpus;
}

function chooseSpread(target: OpenSet, corpus: CorpusSet[]): ResolvedSpread | null {
  const sameSpecies = corpus.filter((entry) => slug(entry.species) === slug(target.species));
  const candidates = sameSpecies.filter((entry) => slug(entry.nature) === slug(target.nature));
  if (!candidates.length) return null;
  const moves = new Set(target.moves.map(slug));
  const overlapOf = (entry: CorpusSet): number => entry.moves.filter((move) => moves.has(slug(move))).length;
  const score = (entry: CorpusSet): number =>
    (slug(entry.item) === slug(target.item) ? 100 : 0) +
    overlapOf(entry) * 10 +
    (entry.moves.length === moves.size ? 1 : 0);
  const best = Math.max(...candidates.map(score));
  const closest = candidates.filter((entry) => score(entry) === best);
  const counts = new Map<string, { count: number; entry: CorpusSet }>();
  for (const entry of closest) {
    const key = spreadText(entry.evs);
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { count: 1, entry });
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const [spread, winner] = ranked[0]!;
  const itemMatched = slug(winner.entry.item) === slug(target.item);
  const shared = overlapOf(winner.entry);
  return {
    evs: winner.entry.evs,
    basis: `${winner.count}/${closest.length} closest ${target.nature} ${target.species} sets ran ${spread}; matched ${shared}/${target.moves.length} moves${itemMatched ? ' and the item' : ` on corpus item ${winner.entry.item || 'none'}`}`,
    from: winner.entry.paste,
    itemMatched,
    shared,
  };
}

function exportSet(set: OpenSet, evs: Spread): string {
  const lines = [
    `${set.species}${set.item ? ` @ ${set.item}` : ''}`,
    `Ability: ${set.ability}`,
    `Level: ${set.level}`,
    `EVs: ${spreadText(evs)}`,
    `${set.nature} Nature`,
    ...set.moves.map((move) => `- ${move}`),
  ];
  return lines.join('\n');
}

async function buildEventPool(manifestFile: string): Promise<string> {
  const manifestPath = path.resolve(manifestFile);
  const poolDir = path.dirname(manifestPath);
  const data: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`invalid manifest ${manifestPath}`);
  const manifest = data as Record<string, unknown>;
  const poolId = text(manifest.id);
  const format = text(manifest.format);
  const event = (manifest.event ?? null) as Record<string, unknown> | null;
  const spreads = (manifest.spreads ?? {}) as Record<string, unknown>;
  const sources = asRecords(manifest.teams);
  if (!poolId || !format || !event || !sources.length) throw new Error(`invalid manifest ${manifestPath}`);

  const psDir = defaultPsDir();
  const corpus = await fetchCorpus(text(spreads.corpus), psDir);
  const teams: Array<{ id: string; packed: string; entry: Record<string, unknown> }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const flagged: string[] = [];

  for (const source of sources) {
    const id = text(source.id);
    if (!id) throw new Error('every source team needs an id');
    const overrides = new Map(
      asRecords(source.overrides).map((override) => [slug(text(override.species)), override] as const),
    );
    const open = await fetchOpenList(text(source.paste));
    const resolved = open.map((set) => {
      const label = `${id} ${set.species}`;
      const override = overrides.get(slug(set.species));
      if (override) {
        const evs = parseSpread(text(override.evs), label);
        return { set, evs, basis: text(override.why), from: 'authored', itemMatched: true, shared: set.moves.length };
      }
      const choice = chooseSpread(set, corpus);
      if (!choice) throw new Error(`${label}: no ${set.nature} ${set.species} in the corpus and no override supplied`);
      checkSpread(choice.evs, label);
      if (!choice.itemMatched || choice.shared < set.moves.length)
        flagged.push(`${label} @ ${set.item}: ${choice.basis}`);
      return { set, ...choice };
    });
    for (const species of overrides.keys()) {
      if (!open.some((set) => slug(set.species) === species)) throw new Error(`${id}: override for absent ${species}`);
    }

    const packed = packTeam(resolved.map((entry) => exportSet(entry.set, entry.evs)).join('\n\n'), psDir, format);
    validateTeam(packed, format, psDir);
    const { id: _id, overrides: _overrides, ...metadata } = source;
    teams.push({ id, packed, entry: { id, file: `${id}.team`, seed: metadata.placement, source: metadata } });
    audit.push({
      team: id,
      sets: resolved.map((entry) => ({
        species: entry.set.species,
        item: entry.set.item,
        nature: entry.set.nature,
        evs: spreadText(entry.evs),
        source: entry.from,
        basis: entry.basis,
      })),
    });
    console.log(`${id}: ok (${resolved.length} sets)`);
  }

  const identical = new Map<string, string>();
  for (const team of teams) {
    const clash = identical.get(team.packed);
    if (clash) throw new Error(`${team.id} is byte-for-byte the same team as ${clash}`);
    identical.set(team.packed, team.id);
  }

  if (flagged.length) {
    console.log(`\n${flagged.length} spread(s) came from an inexact match — review these:`);
    for (const line of flagged) console.log(`  ${line}`);
  }

  const output = publishPool(poolDir, {
    id: poolId,
    format,
    event,
    spreads: { ...spreads, reconstructed: true },
    teams: teams.map((team) => team.entry),
    files: Object.fromEntries(teams.map((team) => [`${team.id}.team`, `${team.packed}\n`])),
    extra: { 'spreads.json': `${JSON.stringify({ pool: poolId, teams: audit }, null, 2)}\n` },
  });
  console.log(`wrote ${output} with ${teams.length} teams`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv[2];
  if (!manifest || process.argv.length !== 3)
    throw new Error('Usage: pnpm run build-event-pool -- teams/<pool>/sources.json');
  await buildEventPool(manifest);
}
