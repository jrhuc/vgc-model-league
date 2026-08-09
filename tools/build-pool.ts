#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPsDir } from '../src/paths.js';
import { packTeam, validateTeam } from '../src/teams.js';
import { asRecords, text } from '../src/value.js';
import { publishPool } from './pool-output.js';

async function fetchPaste(url: string): Promise<string> {
  const response = await fetch(`${url.replace(/^http:/, 'https:').replace(/\/$/, '')}/raw`, {
    headers: { 'user-agent': 'vgc-model-league-pool-builder' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function buildPool(manifestFile: string): Promise<string> {
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
  const psDir = defaultPsDir();
  const seen = new Map<string, string>();
  const teams: Array<{ id: string; packed: string; source: Record<string, unknown> }> = [];
  for (const source of sources) {
    const id = text(source.id);
    if (!id) throw new Error('every source team needs an id');
    const packed = packTeam(await fetchPaste(text(source.paste)), psDir, format);
    validateTeam(packed, format, psDir);
    const duplicate = seen.get(packed);
    if (duplicate) throw new Error(`${id} is byte-for-byte the same team as ${duplicate}`);
    seen.set(packed, id);
    const { id: _, ...metadata } = source;
    teams.push({ id, packed, source: metadata });
    console.log(`${id}: ok`);
  }

  const output = publishPool(poolDir, {
    id: poolId,
    format,
    teams: teams.map((team) => ({ id: team.id, file: `${team.id}.team`, source: team.source })),
    files: Object.fromEntries(teams.map((team) => [`${team.id}.team`, `${team.packed}\n`])),
  });
  console.log(`wrote ${output} with ${teams.length} teams`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv[2];
  if (!manifest || process.argv.length !== 3)
    throw new Error('Usage: pnpm run build-pool -- teams/<pool>/sources.json');
  await buildPool(manifest);
}
