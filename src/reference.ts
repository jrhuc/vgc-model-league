import { execFileSync } from 'node:child_process';

import type { Dex } from 'pokemon-showdown';
import { defaultPsDir } from './paths.js';
import { loadShowdown } from './showdown.js';
import type { ToolDefinition } from './types.js';

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const DEX_TOOLS: ToolDefinition[] = [
  tool(
    'lookup_species',
    'Look up a species: typing, abilities, base stats, forme, Mega Stone outcomes, and optional nature-based Speed range.',
    {
      name: { type: 'string' },
      item: { type: ['string', 'null'] },
      nature: { type: ['string', 'null'] },
    },
    ['name'],
  ),
  tool(
    'lookup_move',
    'Look up a move: type, category, power, accuracy, priority, target, and effect text.',
    { name: { type: 'string' } },
    ['name'],
  ),
  tool('lookup_item', "Look up an item's effect text and mega-stone behaviour.", { name: { type: 'string' } }, [
    'name',
  ]),
  tool('lookup_ability', "Look up an ability's effect text.", { name: { type: 'string' } }, ['name']),
  tool('lookup_nature', 'Look up a Showdown nature/stat alignment (+stat / -stat).', { name: { type: 'string' } }, [
    'name',
  ]),
];

type SpeciesSet = [name: string, item?: string | null, nature?: string | null];

export interface ReferenceQuery {
  speciesItems?: Array<[string, string | null]>;
  speciesSets?: SpeciesSet[];
  moves?: string[];
  items?: string[];
  abilities?: string[];
  natures?: string[];
}

function id(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniqueNames(values: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const clean = value?.trim();
    if (clean) names.set(id(clean), names.get(id(clean)) ?? clean);
  }
  return [...names.values()].sort((a, b) => id(a).localeCompare(id(b)));
}

function cleanDescription(value: unknown): string {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean).join(' ') : '';
}

function baseStats(stats: Dex.StatsTable): string {
  return `base stats HP ${stats.hp}, Atk ${stats.atk}, Def ${stats.def}, SpA ${stats.spa}, SpD ${stats.spd}, Spe ${stats.spe}`;
}

function speedRange(base: number, nature?: { plus?: string; minus?: string }): [number, number] {
  const modifier = nature?.plus === 'spe' ? 1.1 : nature?.minus === 'spe' ? 0.9 : nature ? 1 : undefined;
  const stat = (iv: number, ev: number, multiplier: number) =>
    Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * 50) / 100) + 5) * multiplier);
  return modifier === undefined
    ? [stat(0, 0, 0.9), stat(31, 252, 1.1)]
    : [stat(0, 0, modifier), stat(31, 252, modifier)];
}

export class ShowdownReference {
  private readonly dex;
  private revisionValue?: string;

  constructor(
    readonly format: string,
    readonly psDir = defaultPsDir(),
  ) {
    this.dex = loadShowdown(psDir).Dex.forFormat(format);
  }

  get revision(): string {
    if (this.revisionValue) return this.revisionValue;
    try {
      this.revisionValue =
        execFileSync('git', ['-C', this.psDir, 'rev-parse', '--short=12', 'HEAD'], {
          encoding: 'utf8',
          timeout: 5_000,
        }).trim() || 'unknown';
    } catch {
      this.revisionValue = 'unknown';
    }
    return this.revisionValue;
  }

  render(query: ReferenceQuery = {}): string[] {
    const speciesSets: SpeciesSet[] = [
      ...(query.speciesSets ?? []),
      ...(query.speciesItems ?? []).map(([name, item]): SpeciesSet => [name, item]),
    ];
    const moves = uniqueNames(query.moves ?? []);
    const items = uniqueNames([...(query.items ?? []), ...speciesSets.map((set) => set[1])]);
    const abilities = uniqueNames(query.abilities ?? []);
    const natures = uniqueNames([...(query.natures ?? []), ...speciesSets.map((set) => set[2])]);
    const lines: string[] = [];

    const speciesGroups = new Map<string, { species: Dex.Species; sets: SpeciesSet[] }>();
    for (const set of speciesSets) {
      const species = this.dex.species.get(set[0]);
      if (!species.exists) continue;
      const group = speciesGroups.get(species.id) ?? { species, sets: [] };
      if (!group.sets.some((current) => JSON.stringify(current.slice(1)) === JSON.stringify(set.slice(1))))
        group.sets.push(set);
      speciesGroups.set(species.id, group);
    }
    for (const { species, sets } of [...speciesGroups.values()].sort((a, b) =>
      id(a.species.name).localeCompare(id(b.species.name)),
    )) {
      const abilityNames = uniqueNames(Object.values(species.abilities));
      const details = [
        species.types.join('/'),
        baseStats(species.baseStats),
        ...(abilityNames.length ? [`abilities ${abilityNames.join('/')}`] : []),
      ];
      if (species.forme) details.push(`forme ${species.forme}`);
      for (const [, , natureName] of sets) {
        const nature = natureName ? this.dex.natures.get(natureName) : undefined;
        const knownNature = nature?.exists ? nature : undefined;
        const [low, high] = speedRange(species.baseStats.spe, knownNature);
        const detail = knownNature
          ? `Speed ${low}-${high} with ${knownNature.name} alignment (full legal IV/EV range)`
          : `Speed ${low}-${high} (full legal IV/EV/nature range)`;
        if (!details.includes(detail)) details.push(detail);
      }
      for (const itemName of uniqueNames(sets.map((set) => set[1]))) {
        const item = this.dex.items.get(itemName);
        if (!item.exists || !item.megaStone) continue;
        for (const formeName of species.otherFormes ?? []) {
          const mega = this.dex.species.get(formeName);
          if (!mega.exists || !/^Mega(?:-|$)/.test(mega.forme)) continue;
          const target = typeof item.megaStone === 'string' ? item.megaStone : item.megaStone[species.name];
          if (id(target ?? '') !== id(mega.name)) continue;
          const ranges = sets.flatMap(([, visibleItem, natureName]) => {
            if (id(visibleItem ?? '') !== id(itemName)) return [];
            const nature = natureName ? this.dex.natures.get(natureName) : undefined;
            const knownNature = nature?.exists ? nature : undefined;
            const [low, high] = speedRange(mega.baseStats.spe, knownNature);
            return [`Speed ${low}-${high}${knownNature ? ` with ${knownNature.name} alignment` : ''}`];
          });
          const megaAbilities = uniqueNames(Object.values(mega.abilities));
          for (const ability of megaAbilities)
            if (!abilities.some((current) => id(current) === id(ability))) abilities.push(ability);
          details.push(
            `with ${item.name} -> ${mega.name} (${mega.types.join('/')}, ${baseStats(mega.baseStats)}, abilities ${megaAbilities.join('/')}${ranges.length ? `; ${[...new Set(ranges)].sort().join(', ')}` : ''})`,
          );
        }
      }
      lines.push(`- Species ${species.name}: ${details.join('; ')}`);
    }

    for (const name of moves) {
      const move = this.dex.moves.get(name);
      if (!move.exists) continue;
      const details = [
        move.type,
        move.category,
        move.basePower ? `BP ${move.basePower}` : 'BP —',
        move.accuracy === true ? 'always hits' : `acc ${move.accuracy}%`,
        `priority ${move.priority >= 0 ? '+' : ''}${move.priority}`,
        `target ${move.target}`,
      ];
      // Prefer Showdown's complete mechanics text. Some short descriptions omit
      // strategically important clauses such as consecutive-use failure rates.
      const description = cleanDescription(move.desc || move.shortDesc);
      if (description) details.push(description);
      lines.push(`- Move ${move.name}: ${details.join('; ')}`);
    }
    for (const name of items) {
      const item = this.dex.items.get(name);
      const description = item.exists ? cleanDescription(item.shortDesc || item.desc) : '';
      if (description) lines.push(`- Item ${item.name}: ${description}`);
    }
    for (const name of abilities) {
      const ability = this.dex.abilities.get(name);
      const description = ability.exists ? cleanDescription(ability.shortDesc || ability.desc) : '';
      if (description) lines.push(`- Ability ${ability.name}: ${description}`);
    }
    for (const name of natures) {
      const nature = this.dex.natures.get(name);
      if (!nature.exists) continue;
      lines.push(
        nature.plus && nature.minus
          ? `- Stat alignment ${nature.name} (Showdown Nature): +${nature.plus}, -${nature.minus}`
          : `- Stat alignment ${nature.name} (Showdown Nature): neutral`,
      );
    }
    return lines.length ? [`Showdown reference (${this.format}, commit ${this.revision}):`, ...lines] : [];
  }

  lookup(name: string, args: Record<string, unknown> = {}): string {
    const value = typeof args.name === 'string' ? args.name : '';
    if (name === 'lookup_species') return this.lookupSpecies(value, args.item, args.nature);
    if (name === 'lookup_move') return this.lookupOne('Move', value, { moves: [value] });
    if (name === 'lookup_item') return this.lookupOne('Item', value, { items: [value] });
    if (name === 'lookup_ability') return this.lookupOne('Ability', value, { abilities: [value] });
    if (name === 'lookup_nature') return this.lookupOne('Nature', value, { natures: [value] }, '- Stat alignment ');
    return `Unknown tool: ${name}`;
  }

  lookupSpecies(name: string, item?: unknown, nature?: unknown): string {
    if (!name.trim()) return 'Species name is required.';
    const lines = this.render({
      speciesSets: [
        [
          name,
          typeof item === 'string' && item.trim() ? item : null,
          typeof nature === 'string' && nature.trim() ? nature : null,
        ],
      ],
    });
    return (
      lines.find((line) => line.startsWith('- Species ')) ??
      `No species data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }

  private lookupOne(kind: string, name: string, query: ReferenceQuery, prefix = `- ${kind} `): string {
    if (!name.trim()) return `${kind} name is required.`;
    return (
      this.render(query).find((line) => line.startsWith(prefix)) ??
      `No ${kind.toLowerCase()} data for ${JSON.stringify(name)} in ${this.format}.`
    );
  }
}
