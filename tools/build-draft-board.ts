#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARDS_DIR, defaultPsDir } from '../src/paths.js';
import { loadShowdown } from '../src/showdown.js';

const SOURCE_COSTS = path.join(BOARDS_DIR, 'sources', 'draft-costs.json');

const REGMB_ADDITIONS: Array<{ name: string; cost: number; anchor: string }> = [
  { name: 'Metagross-Mega', cost: 17, anchor: 'Smogon B; BST 700 matches Mega Tyranitar (17)' },
  { name: 'Swampert-Mega', cost: 15, anchor: 'Smogon B; rain sweeper above Mega Gyarados (14)' },
  {
    name: 'Blaziken-Mega',
    cost: 12,
    anchor: 'Smogon C+; Speed Boost, between Mega Medicham (12) and Mega Lucario (15)',
  },
  { name: 'Mawile-Mega', cost: 12, anchor: 'Smogon C+; Huge Power mirrors Mega Medicham (12)' },
  { name: 'Raichu-Mega-Y', cost: 12, anchor: 'Smogon B-; fast electric above Mega Manectric (10)' },
  { name: 'Staraptor-Mega', cost: 12, anchor: 'Smogon B-; flying attacker above Mega Pidgeot (7)' },
  { name: 'Pyroar-Mega', cost: 11, anchor: 'Smogon C+; special fire above Mega Chandelure (9)' },
  { name: 'Sceptile-Mega', cost: 10, anchor: 'unranked; fast frail special, cf. Mega Alakazam (12)' },
  { name: 'Eelektross-Mega', cost: 10, anchor: 'unranked; cf. Mega Manectric (10)' },
  { name: 'Raichu-Mega-X', cost: 9, anchor: 'unranked, unlike its Y forme; cf. Mega Altaria (9)' },
  { name: 'Barbaracle-Mega', cost: 8, anchor: 'unranked; cf. Mega Crabominable (8)' },
  { name: 'Dragalge-Mega', cost: 8, anchor: 'unranked; cf. Mega Drampa (8)' },
  { name: 'Scolipede-Mega', cost: 8, anchor: 'unranked; Speed Boost, cf. Mega Sharpedo (7)' },
  { name: 'Meowstic-F-Mega', cost: 8, anchor: 'unranked; just under Mega Meowstic (9)' },
  { name: 'Scrafty-Mega', cost: 7, anchor: 'Smogon C-; cf. Mega Heracross (7)' },
  { name: 'Malamar-Mega', cost: 7, anchor: 'unranked; cf. Mega Victreebel (7)' },
  { name: 'Falinks-Mega', cost: 7, anchor: 'unranked; cf. Mega Pinsir (7)' },
  { name: 'Grimmsnarl', cost: 15, anchor: 'Smogon B+; Prankster screens, under Whimsicott (19)' },
  { name: 'Gholdengo', cost: 14, anchor: 'Smogon B; blocks Prankster status, cf. Corviknight (13)' },
  { name: 'Annihilape', cost: 11, anchor: 'Smogon C+; Rage Fist, above Krookodile (9)' },
  { name: 'Houndstone', cost: 6, anchor: 'Smogon C; cf. Spiritomb (6)' },
  { name: 'Blaziken', cost: 6, anchor: 'Smogon C-; Speed Boost carries the unmegaed forme, cf. Blastoise (9)' },
  { name: 'Metagross', cost: 6, anchor: 'base of a 17-point mega, cf. Blastoise (9)' },
  { name: 'Swampert', cost: 6, anchor: 'base of a 15-point mega, cf. Blastoise (9)' },
  { name: 'Staraptor', cost: 4, anchor: 'Smogon C-; Intimidate/Final Gambit utility, cf. Starmie (4)' },
  { name: 'Vileplume', cost: 4, anchor: 'Smogon C-; cf. Roserade (4)' },
  { name: 'Overqwil', cost: 4, anchor: 'unranked; cf. Toxicroak (4)' },
  { name: 'Sceptile', cost: 3, anchor: 'base of a 10-point mega, cf. Decidueye (3)' },
  { name: 'Eelektross', cost: 3, anchor: 'unranked; cf. Flapple (3)' },
  { name: 'Barbaracle', cost: 3, anchor: 'unranked; cf. Crabominable (3)' },
  { name: 'Dragalge', cost: 3, anchor: 'unranked; cf. Toxapex (3)' },
  { name: 'Scrafty', cost: 3, anchor: 'unranked base of a 7-point mega, cf. Passimian (3)' },
  { name: 'Scolipede', cost: 3, anchor: 'unranked base of an 8-point mega, cf. Ariados (2)' },
  { name: 'Malamar', cost: 3, anchor: 'unranked; cf. Trevenant (3)' },
  { name: 'Musharna', cost: 3, anchor: 'unranked; cf. Audino (3)' },
  { name: 'Pyroar', cost: 2, anchor: 'base of an 11-point mega, cf. Tauros (2)' },
  { name: 'Falinks', cost: 2, anchor: 'unranked base of a 7-point mega, cf. Morpeko (2)' },
  { name: 'Mawile', cost: 2, anchor: 'the Huge Power mega is the draw, cf. Aggron (2)' },
  { name: 'Qwilfish', cost: 2, anchor: 'unranked; cf. Sandaconda (2)' },
];

/** Reprice prior Reg M-A entries against Reg M-B ladder usage by quantile-matching usage rank to the
 * board's cost distribution and moving halfway to the target. */
const USAGE_ADJUSTMENTS: Array<{ name: string; cost: number; usage: string }> = [
  { name: 'Farigiraf', cost: 18, usage: '#7 at 20.72%' },
  { name: 'Pelipper', cost: 18, usage: '#8 at 18.58%' },
  { name: 'Grimmsnarl', cost: 16, usage: '#13 at 14.74%' },
  { name: 'Staraptor-Mega', cost: 14, usage: '#14 at 14.65%' },
  { name: 'Gholdengo', cost: 16, usage: '#18 at 11.61%' },
  { name: 'Mawile-Mega', cost: 14, usage: '#19 at 10.03%' },
  { name: 'Raichu-Mega-Y', cost: 14, usage: '#21 at 9.54%' },
  { name: 'Sableye', cost: 14, usage: '#24 at 5.87%' },
  { name: 'Annihilape', cost: 14, usage: '#28 at 4.97%' },
  { name: 'Pyroar-Mega', cost: 13, usage: '#31 at 4.67%' },
  { name: 'Froslass-Mega', cost: 17, usage: '#33 at 3.87%' },
  { name: 'Gengar-Mega', cost: 18, usage: '#35 at 3.35%' },
  { name: 'Staraptor', cost: 10, usage: '#37 at 3.07%' },
  { name: 'Scrafty-Mega', cost: 11, usage: '#39 at 2.99%' },
  { name: 'Ceruledge', cost: 12, usage: '#42 at 2.66%' },
  { name: 'Sceptile-Mega', cost: 12, usage: '#46 at 2.46%' },
  { name: 'Tyranitar-Mega', cost: 16, usage: '#47 at 2.45%' },
  { name: 'Eelektross-Mega', cost: 12, usage: '#48 at 2.41%' },
  { name: 'Toxapex', cost: 8, usage: '#50 at 2.25%' },
  { name: 'Kangaskhan', cost: 10, usage: '#53 at 1.97%' },
  { name: 'Tsareena', cost: 11, usage: '#54 at 1.97%' },
  { name: 'Typhlosion-Hisui', cost: 11, usage: '#55 at 1.89%' },
  { name: 'Vivillon', cost: 12, usage: '#56 at 1.82%' },
  { name: 'Vileplume', cost: 8, usage: '#57 at 1.79%' },
  { name: 'Raichu-Mega-X', cost: 11, usage: '#59 at 1.68%' },
  { name: 'Gardevoir-Mega', cost: 16, usage: '#60 at 1.67%' },
  { name: 'Dragalge-Mega', cost: 10, usage: '#65 at 1.60%' },
  { name: 'Dragonite', cost: 14, usage: '#68 at 1.55%' },
  { name: 'Lycanroc-Dusk', cost: 8, usage: '#69 at 1.50%' },
  { name: 'Dragapult', cost: 14, usage: '#70 at 1.50%' },
  { name: 'Glimmora-Mega', cost: 14, usage: '#71 at 1.48%' },
  { name: 'Kangaskhan-Mega', cost: 15, usage: '#72 at 1.46%' },
  { name: 'Gallade', cost: 10, usage: '#74 at 1.42%' },
  { name: 'Aegislash', cost: 14, usage: '#76 at 1.36%' },
  { name: 'Volcarona', cost: 14, usage: '#77 at 1.33%' },
  { name: 'Arcanine-Hisui', cost: 13, usage: '#78 at 1.21%' },
  { name: 'Tyranitar', cost: 14, usage: '#79 at 1.21%' },
  { name: 'Meganium-Mega', cost: 12, usage: '#82 at 1.06%' },
  { name: 'Scizor-Mega', cost: 13, usage: '#86 at 0.84%' },
  { name: 'Lopunny-Mega', cost: 14, usage: '#87 at 0.75%' },
  { name: 'Gyarados-Mega', cost: 12, usage: '#99 at 0.51%' },
  { name: 'Charizard-Mega-X', cost: 12, usage: '#107 at 0.46%' },
  { name: 'Gyarados', cost: 11, usage: '#109 at 0.44%' },
  { name: 'Garchomp-Mega', cost: 12, usage: '#110 at 0.42%' },
  { name: 'Starmie-Mega', cost: 12, usage: '#116 at 0.37%' },
  { name: 'Rotom-Mow', cost: 10, usage: '#122 at 0.34%' },
  { name: 'Arcanine', cost: 11, usage: '#131 at 0.27%' },
  { name: 'Tauros-Paldea-Aqua', cost: 9, usage: '#140 at 0.23%' },
  { name: 'Golurk-Mega', cost: 8, usage: '#144 at 0.23%' },
  { name: 'Lucario-Mega', cost: 11, usage: '#147 at 0.22%' },
  { name: 'Clefable-Mega', cost: 10, usage: '#154 at 0.19%' },
  { name: 'Greninja-Mega', cost: 10, usage: '#155 at 0.19%' },
  { name: 'Skarmory-Mega', cost: 9, usage: '#157 at 0.19%' },
  { name: 'Liepard', cost: 8, usage: '#159 at 0.18%' },
  { name: 'Hawlucha-Mega', cost: 8, usage: '#164 at 0.15%' },
  { name: 'Manectric-Mega', cost: 8, usage: '#186 at 0.10%' },
  { name: 'Excadrill-Mega', cost: 9, usage: '#188 at 0.09%' },
  { name: 'Alakazam-Mega', cost: 8, usage: '#190 at 0.09%' },
  { name: 'Gallade-Mega', cost: 8, usage: '#192 at 0.08%' },
  { name: 'Floette-Eternal', cost: 8, usage: '#206 at 0.06%' },
  { name: 'Salazzle', cost: 7, usage: '#208 at 0.06%' },
  { name: 'Medicham-Mega', cost: 8, usage: '#209 at 0.06%' },
];

const BOARD_ALIASES: Record<string, string> = {
  'Mega Charizard X': 'Charizard-Mega-X',
  'Mega Charizard Y': 'Charizard-Mega-Y',
  'Basculegion-Male': 'Basculegion',
  'Basculegion-Female': 'Basculegion-F',
  'Meowstic-Male': 'Meowstic',
  'Meowstic-Female': 'Meowstic-F',
  'Paldean Tauros': 'Tauros-Paldea-Combat',
  'Paldean Tauros Aqua': 'Tauros-Paldea-Aqua',
  'Paldean Tauros Blaze': 'Tauros-Paldea-Blaze',
};

function dexNameFor(boardName: string): string {
  const alias = BOARD_ALIASES[boardName];
  if (alias) return alias;
  const name = boardName.startsWith('Mega ') ? `${boardName.slice(5)}-Mega` : boardName;
  return name
    .replace(/^Hisuian (.+)$/, '$1-Hisui')
    .replace(/^Alolan (.+)$/, '$1-Alola')
    .replace(/^Galarian (.+)$/, '$1-Galar');
}

interface BoardEntrySource {
  name: string;
  cost: number;
  origin: 'base' | 'regmb';
  anchor?: string;
}

function displayName(dexName: string): string {
  const mega = /^(.+?)-Mega(?:-([XY]))?$/.exec(dexName);
  if (!mega) return dexName;
  return `Mega ${mega[1]}${mega[2] ? ` ${mega[2]}` : ''}`;
}

function buildBoard(boardId = 'regmb-202607', format = 'gen9championsvgc2026regmbbo3'): string {
  const psDir = defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const resolvedFormat = Dex.formats.get(format);
  if (!resolvedFormat.exists) throw new Error(`unknown format ${format}`);
  const dex = Dex.mod(resolvedFormat.mod || 'base');

  const stoneFor = new Map<string, { item: string; from: string }>();
  for (const item of dex.items.all()) {
    const map = item.megaStone;
    if (!map || typeof map === 'string') continue;
    for (const [from, to] of Object.entries(map)) stoneFor.set(to, { item: item.name, from });
  }

  const baseCosts = JSON.parse(fs.readFileSync(SOURCE_COSTS, 'utf8')) as Array<{ name: string; cost: number }>;
  const sources: BoardEntrySource[] = [
    ...baseCosts.map((entry): BoardEntrySource => ({ name: entry.name, cost: entry.cost, origin: 'base' })),
    ...REGMB_ADDITIONS.map((entry): BoardEntrySource => ({ ...entry, origin: 'regmb' })),
  ];

  const adjustments = new Map<string, { cost: number; usage: string }>();
  for (const entry of USAGE_ADJUSTMENTS) {
    if (!dex.species.get(entry.name).exists) throw new Error(`usage adjustment ${entry.name} is not in the dex`);
    adjustments.set(entry.name, { cost: entry.cost, usage: entry.usage });
  }

  const seen = new Set<string>();
  const mons = [];
  for (const source of sources) {
    const species = dex.species.get(dexNameFor(source.name));
    if (!species.exists) throw new Error(`board entry ${JSON.stringify(source.name)} is not in the format dex`);
    if (species.isNonstandard) throw new Error(`board entry ${JSON.stringify(source.name)} is not standard`);
    if (seen.has(species.name)) throw new Error(`duplicate board entry for ${species.name}`);
    seen.add(species.name);

    const stone = stoneFor.get(species.name);
    const registered = stone ? dex.species.get(stone.from) : species;
    const adjusted = adjustments.get(species.name);
    if (adjusted) adjustments.delete(species.name);
    mons.push({
      id: species.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: source.origin === 'base' ? source.name : displayName(species.name),
      species: registered.name,
      ...(stone ? { forme: species.name, item: stone.item } : {}),
      base: registered.baseSpecies,
      types: species.types,
      cost: adjusted ? adjusted.cost : source.cost,
      origin: source.origin,
      ...(source.anchor ? { anchor: source.anchor } : {}),
      ...(adjusted ? { listed: source.cost, usage: adjusted.usage } : {}),
    });
  }
  if (adjustments.size) throw new Error(`unused usage adjustments: ${[...adjustments.keys()].join(', ')}`);
  mons.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));

  const board = {
    id: boardId,
    format,
    budget: 100,
    picks: 10,
    source:
      'Costs 1-20 from a prior Regulation M-A draft board. Reg M-B additions are priced against comparable entries; each carries its anchor.',
    mons,
  };
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const file = path.join(BOARDS_DIR, `${boardId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = buildBoard();
  const board = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    mons: Array<{ cost: number; origin: string; item?: string }>;
  };
  const added = board.mons.filter((mon) => mon.origin === 'regmb').length;
  const megas = board.mons.filter((mon) => mon.item).length;
  console.log(
    `${file}: ${board.mons.length} entries (${board.mons.length - added} base, ${added} Reg M-B), ${megas} megas, costs ${Math.min(...board.mons.map((mon) => mon.cost))}-${Math.max(...board.mons.map((mon) => mon.cost))}`,
  );
}
