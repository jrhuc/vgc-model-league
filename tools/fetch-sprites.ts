#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPsDir, REPO_ROOT } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';

const SPRITE_DIR = path.join(REPO_ROOT, 'src', 'gui', 'client', 'public', 'sprites');
const SOURCE = 'https://play.pokemonshowdown.com/sprites/gen5';
const CONCURRENCY = 6;

async function download(spriteId: string): Promise<Buffer | undefined> {
  const response = await fetch(`${SOURCE}/${spriteId}.png`, {
    headers: { 'user-agent': 'vgc-model-league-sprite-fetch' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return undefined;
  return Buffer.from(await response.arrayBuffer());
}

interface SpriteTarget {
  id: string;
  fallback: string;
}

function spriteTargets(format = 'gen9championsvgc2026regmbbo3', psDir = defaultPsDir()): SpriteTarget[] {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(format).mod || 'base');
  const targets = new Map<string, SpriteTarget>();
  for (const species of dex.species.all()) {
    if (species.isNonstandard) continue;
    const base = dex.species.get(species.baseSpecies);
    targets.set(species.spriteid, { id: species.spriteid, fallback: base.spriteid });
  }
  return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchSprites(): Promise<{ written: number; substituted: string[]; missing: string[] }> {
  fs.mkdirSync(SPRITE_DIR, { recursive: true });
  const targets = spriteTargets();
  const substituted: string[] = [];
  const missing: string[] = [];
  let written = 0;

  const queue = [...targets];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const file = path.join(SPRITE_DIR, `${next.id}.png`);
      if (fs.existsSync(file)) {
        written += 1;
        continue;
      }
      let data = await download(next.id);
      if (!data && next.fallback !== next.id) {
        data = await download(next.fallback);
        if (data) substituted.push(`${next.id} -> ${next.fallback}`);
      }
      if (!data) {
        missing.push(next.id);
        continue;
      }
      fs.writeFileSync(file, data);
      written += 1;
    }
  });
  await Promise.all(workers);
  return { written, substituted: substituted.sort(), missing: missing.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { written, substituted, missing } = await fetchSprites();
  const bytes = fs
    .readdirSync(SPRITE_DIR)
    .filter((entry) => entry.endsWith('.png'))
    .reduce((sum, entry) => sum + fs.statSync(path.join(SPRITE_DIR, entry)).size, 0);
  console.log(`${SPRITE_DIR}: ${written} sprites, ${Math.round(bytes / 1024)} KB`);
  if (substituted.length) console.log(`borrowed a base forme for ${substituted.length}: ${substituted.join(', ')}`);
  if (missing.length) console.log(`no sprite found for ${missing.length}: ${missing.join(', ')}`);
}
