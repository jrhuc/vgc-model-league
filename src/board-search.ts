import type { DraftBoard, DraftBoardMon } from './draft.js';
import { loadShowdown } from './showdown.js';
import type { JsonObject, ToolDefinition } from './types.js';

const SORTS = ['cost', 'bst', 'name'] as const;
type Sort = (typeof SORTS)[number];

export const BOARD_SEARCH_TOOL: ToolDefinition = {
  name: 'search_board',
  description:
    'Filter and sort the draft board. Searches every entry on the board, including ones already drafted, so check ' +
    'the drafted list before picking. Combine any filters; omit them all to re-sort the whole board.',
  parameters: {
    type: 'object',
    properties: {
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Entries carrying every listed type. ["Fire"] matches Fire/Flying; ["Fire","Flying"] matches only both.',
      },
      max_cost: { type: 'integer' },
      min_cost: { type: 'integer' },
      learns: { type: 'string', description: 'Move name. Entries whose legal movepool in this format contains it.' },
      ability: { type: 'string', description: 'Ability name, matched against every ability slot.' },
      min_bst: { type: 'integer', description: 'Minimum base stat total.' },
      sort: { type: 'string', enum: [...SORTS], description: 'cost and bst sort high to low, name A to Z. Defaults to cost.' },
      limit: { type: 'integer', description: 'Rows returned, 1 to 100. Defaults to 40.' },
    },
    required: [],
    additionalProperties: false,
  },
};

export interface BoardSearch {
  definition: ToolDefinition;
  run(args: JsonObject): string;
}

export function boardRow(mon: DraftBoardMon, dex: ReturnType<ReturnType<typeof loadShowdown>['Dex']['mod']>): string {
  const species = dex.species.get(mon.forme ?? mon.species);
  const stats = species.baseStats;
  const abilities = Object.values(species.abilities ?? {})
    .filter(Boolean)
    .join('/');
  return (
    `- ${mon.id} | ${mon.cost} | ${mon.name} | ${mon.types.join('/')} | ` +
    `${stats.hp}/${stats.atk}/${stats.def}/${stats.spa}/${stats.spd}/${stats.spe} | ${abilities}` +
    (mon.item ? ` | holds ${mon.item}` : '')
  );
}

function baseStatTotal(stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }): number {
  return stats.hp + stats.atk + stats.def + stats.spa + stats.spd + stats.spe;
}

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function readString(args: JsonObject, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readInteger(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function createBoardSearch(board: DraftBoard, psDir: string): BoardSearch {
  const { Dex } = loadShowdown(psDir);
  const dex = Dex.mod(Dex.formats.get(board.format).mod || 'base');
  const movePools = new Map<string, Set<string>>();
  const movePool = (mon: DraftBoardMon): Set<string> => {
    const key = mon.forme ?? mon.species;
    let pool = movePools.get(key);
    if (!pool) {
      pool = new Set(dex.species.getMovePool(dex.species.get(key).id));
      movePools.set(key, pool);
    }
    return pool;
  };

  return {
    definition: BOARD_SEARCH_TOOL,
    run(args: JsonObject): string {
      const rawTypes = Array.isArray(args.types) ? args.types : [];
      const types = rawTypes.filter((value): value is string => typeof value === 'string').map((value) => normalize(value));
      const maxCost = readInteger(args, 'max_cost');
      const minCost = readInteger(args, 'min_cost');
      const minBst = readInteger(args, 'min_bst');
      const learns = readString(args, 'learns');
      const ability = readString(args, 'ability');
      const sortValue = readString(args, 'sort');
      if (sortValue && !SORTS.includes(sortValue as Sort)) return `sort must be one of ${SORTS.join(', ')}.`;
      const sort = (sortValue || 'cost') as Sort;
      const limit = Math.min(Math.max(readInteger(args, 'limit') ?? 40, 1), 100);

      let move = '';
      if (learns) {
        const resolved = dex.moves.get(learns);
        if (!resolved.exists) return `No move data for ${JSON.stringify(learns)} in ${board.format}.`;
        move = resolved.id;
      }
      let abilityName = '';
      if (ability) {
        const resolved = dex.abilities.get(ability);
        if (!resolved.exists) return `No ability data for ${JSON.stringify(ability)} in ${board.format}.`;
        abilityName = resolved.name;
      }

      const matched = board.mons.filter((mon) => {
        if (maxCost !== undefined && mon.cost > maxCost) return false;
        if (minCost !== undefined && mon.cost < minCost) return false;
        const species = dex.species.get(mon.forme ?? mon.species);
        if (types.length && !types.every((type) => species.types.some((own: string) => normalize(own) === type)))
          return false;
        if (minBst !== undefined && baseStatTotal(species.baseStats) < minBst) return false;
        if (abilityName && !Object.values(species.abilities ?? {}).includes(abilityName)) return false;
        if (move && !movePool(mon).has(move)) return false;
        return true;
      });

      matched.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'bst') {
          const left = baseStatTotal(dex.species.get(a.forme ?? a.species).baseStats);
          const right = baseStatTotal(dex.species.get(b.forme ?? b.species).baseStats);
          if (left !== right) return right - left;
          return b.cost - a.cost || a.name.localeCompare(b.name);
        }
        return b.cost - a.cost || a.name.localeCompare(b.name);
      });

      if (!matched.length) return 'No board entries match those filters.';
      const shown = matched.slice(0, limit);
      const heading =
        `Board search: ${matched.length} match${matched.length === 1 ? '' : 'es'}` +
        (matched.length > shown.length ? `, showing the first ${shown.length} by ${sort}` : ` sorted by ${sort}`) +
        ' (id | cost | name | types | base stats | abilities):';
      return [heading, ...shown.map((mon) => boardRow(mon, dex))].join('\n');
    },
  };
}
