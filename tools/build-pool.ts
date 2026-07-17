#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPsDir } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { packTeam, validateTeam } from '../src/teams.js';
import { asRecords, text } from '../src/value.js';

async function fetchPaste(url: string): Promise<string> {
  const response = await fetch(`${url.replace(/^http:/, 'https:').replace(/\/$/, '')}/raw`, {
    headers: { 'user-agent': 'vgc-model-league-pool-builder' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

export async function buildPool(manifestFile: string): Promise<string> {
  const manifestPath = path.resolve(manifestFile);
  const poolDir = path.dirname(manifestPath);
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error(`invalid manifest ${manifestPath}`);
  const data = manifest as Record<string, unknown>;
  const poolId = text(data.id);
  const format = text(data.format);
  const sources = asRecords(data.teams);
  if (!poolId || !format || !sources.length) throw new Error(`invalid manifest ${manifestPath}`);
  const names = [...sources.map((team) => `${text(team.id)}.team`), 'pool.json'];
  const existing = names.map((name) => path.join(poolDir, name)).find((file) => fs.existsSync(file));
  if (existing) throw new Error(`refusing to overwrite existing output: ${existing}`);

  const psDir = defaultPsDir();
  const { Teams } = loadShowdown(psDir);
  const seen = new Map<string, string>();
  const teams: Array<{ id: string; packed: string; source: Record<string, unknown> }> = [];
  for (const source of sources) {
    const id = text(source.id);
    if (!id) throw new Error('every source team needs an id');
    const packed = packTeam(await fetchPaste(text(source.paste)), psDir);
    validateTeam(packed, format, psDir);
    const key = (Teams.unpack(packed) ?? [])
      .map((set) => set.species.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .sort()
      .join(',');
    const duplicate = seen.get(key);
    if (duplicate) throw new Error(`${id} duplicates the species set of ${duplicate}: ${key}`);
    seen.set(key, id);
    const { id: _, ...metadata } = source;
    teams.push({ id, packed, source: metadata });
    console.log(`${id}: ok (${key.split(',').length} mons)`);
  }

  const staging = fs.mkdtempSync(path.join(path.dirname(poolDir), `.${path.basename(poolDir)}.`));
  try {
    for (const team of teams) fs.writeFileSync(path.join(staging, `${team.id}.team`), `${team.packed}\n`, 'utf8');
    fs.writeFileSync(
      path.join(staging, 'pool.json'),
      `${JSON.stringify(
        {
          id: poolId,
          format,
          teams: teams.map((team) => ({ id: team.id, file: `${team.id}.team`, source: team.source })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const conflict = names.map((name) => path.join(poolDir, name)).find((file) => fs.existsSync(file));
    if (conflict) throw new Error(`refusing to overwrite existing output: ${conflict}`);
    const published: string[] = [];
    try {
      for (const name of names) {
        const target = path.join(poolDir, name);
        fs.linkSync(path.join(staging, name), target);
        published.push(target);
      }
    } catch (error) {
      for (const target of published.reverse()) fs.rmSync(target, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const output = path.join(poolDir, 'pool.json');
  console.log(`wrote ${output} with ${teams.length} teams`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv[2];
  if (!manifest || process.argv.length !== 3) throw new Error('Usage: npm run build-pool -- teams/<pool>/sources.json');
  await buildPool(manifest);
}
