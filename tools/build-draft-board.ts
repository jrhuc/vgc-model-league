#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARDS_DIR, defaultPsDir } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';

// Tiers from Smogon's "VGC Regulation M-B Viability Rankings"
// (https://www.smogon.com/forums/threads/vgc-regulation-m-b-viability-rankings.3785289/),
// keyed by effective form: a held mega stone ranks the mega. Species absent
// from the rankings default to C-.
const TIERS: Record<string, string> = {
  Basculegion: 'S',
  'Charizard-Mega-Y': 'S',
  Garchomp: 'S',
  Kingambit: 'S',
  'Floette-Mega': 'A+',
  Incineroar: 'A+',
  'Aerodactyl-Mega': 'A',
  Sinistcha: 'A',
  Whimsicott: 'A',
  'Delphox-Mega': 'A-',
  Farigiraf: 'A-',
  Sneasler: 'A-',
  Sylveon: 'A-',
  'Blastoise-Mega': 'B+',
  Grimmsnarl: 'B+',
  Pelipper: 'B+',
  Venusaur: 'B+',
  Aerodactyl: 'B',
  Archaludon: 'B',
  'Gengar-Mega': 'B',
  Gholdengo: 'B',
  'Metagross-Mega': 'B',
  'Swampert-Mega': 'B',
  Toxapex: 'B',
  'Venusaur-Mega': 'B',
  'Froslass-Mega': 'B-',
  Hydreigon: 'B-',
  Maushold: 'B-',
  'Maushold-Four': 'B-',
  Milotic: 'B-',
  'Ninetales-Alola': 'B-',
  Politoed: 'B-',
  'Raichu-Mega-Y': 'B-',
  'Staraptor-Mega': 'B-',
  Talonflame: 'B-',
  Torkoal: 'B-',
  'Tyranitar-Mega': 'B-',
  Annihilape: 'C+',
  'Blaziken-Mega': 'C+',
  Ceruledge: 'C+',
  Dragonite: 'C+',
  'Dragonite-Mega': 'C+',
  Excadrill: 'C+',
  Glimmora: 'C+',
  'Lycanroc-Dusk': 'C+',
  Mamoswine: 'C+',
  'Mawile-Mega': 'C+',
  'Pyroar-Mega': 'C+',
  'Scovillain-Mega': 'C+',
  Vivillon: 'C+',
  'Arcanine-Hisui': 'C',
  Corviknight: 'C',
  'Gardevoir-Mega': 'C',
  Houndstone: 'C',
  'Kangaskhan-Mega': 'C',
  'Kommo-o': 'C',
  'Rotom-Wash': 'C',
  Sableye: 'C',
  Tsareena: 'C',
  Volcarona: 'C',
  Weavile: 'C',
  Aegislash: 'C-',
  Blaziken: 'C-',
  'Camerupt-Mega': 'C-',
  'Charizard-Mega-X': 'C-',
  Clefable: 'C-',
  'Garchomp-Mega': 'C-',
  'Glimmora-Mega': 'C-',
  Ninetales: 'C-',
  Palafin: 'C-',
  Primarina: 'C-',
  'Rotom-Heat': 'C-',
  'Samurott-Hisui': 'C-',
  'Scrafty-Mega': 'C-',
  Staraptor: 'C-',
  Vileplume: 'C-',
};

const COSTS: Record<string, number> = {
  S: 20,
  'A+': 17,
  A: 15,
  'A-': 13,
  'B+': 11,
  B: 9,
  'B-': 7,
  'C+': 5,
  C: 4,
  'C-': 3,
};

export function buildBoard(poolName: string): string {
  const psDir = defaultPsDir();
  const { Dex, Teams } = loadShowdown(psDir);
  const pool = loadPool(poolName);
  const seen = new Set<string>();
  const mons = [];
  for (const team of pool.teams) {
    for (const set of Teams.unpack(team.packed) ?? []) {
      const species = Dex.species.get(set.species || set.name);
      if (!seen.has(species.baseSpecies)) {
        seen.add(species.baseSpecies);
        // This Showdown fork types megaStone as a base-species → mega-forme map.
        const item = Dex.items.get(set.item) as unknown as { megaStone?: Record<string, string> };
        const effective = item.megaStone?.[species.name] ?? item.megaStone?.[species.baseSpecies] ?? species.name;
        const tier = TIERS[effective.replaceAll(' ', '-')] ?? TIERS[species.name.replaceAll(' ', '-')] ?? 'C-';
        mons.push({
          id: effective.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          name: effective,
          species: species.name,
          tier,
          cost: COSTS[tier]!,
          packed: Teams.pack([set]),
        });
      }
    }
  }
  mons.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  const board = {
    id: pool.id,
    format: pool.format,
    budget: 70,
    picks: 6,
    source:
      `Sets from the ${pool.id} tournament-team pool; tiers from Smogon's ` +
      "'VGC Regulation M-B Viability Rankings' (smogon.com/forums/threads/3785289), unranked species default to C-.",
    mons,
  };
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const file = path.join(BOARDS_DIR, `${pool.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = process.argv[2] ?? 'regmb-202607';
  const file = buildBoard(pool);
  const board = JSON.parse(fs.readFileSync(file, 'utf8')) as { mons: unknown[] };
  console.log(`${file}: ${board.mons.length} draftable sets`);
}
