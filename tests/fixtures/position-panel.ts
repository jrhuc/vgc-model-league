import { acceptedBattleActionEntries } from '../../src/eval/fork.js';
import { loadShowdown } from '../../src/showdown.js';
import type { BattleRequest } from '../../src/types.js';

const Showdown = loadShowdown();
type PokemonSet = NonNullable<Parameters<typeof Showdown.Teams.pack>[0]>[number];

function panelSet(name: string, moves: string[]): PokemonSet {
  return {
    name,
    species: 'Mew',
    item: '',
    ability: 'Synchronize',
    moves,
    nature: 'Serious',
    gender: '',
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: 50,
  };
}

export function minimalPanelBattle(
  opponentMoves: string[] = ['Protect'],
  sourceMoves: string[] = ['Protect', 'Tailwind'],
): {
  format: string;
  snapshot: string;
  requests: Record<'p1' | 'p2', BattleRequest>;
  actions: Record<'p1' | 'p2', string[]>;
} {
  const format = 'gen9customgame';
  const battle = new Showdown.Battle({ formatid: format, seed: '7,11,13,17' });
  battle.setPlayer('p1', { name: 'panel-p1', team: Showdown.Teams.pack([panelSet('One', sourceMoves)]) });
  battle.setPlayer('p2', { name: 'panel-p2', team: Showdown.Teams.pack([panelSet('Two', opponentMoves)]) });
  if (!battle.choose('p1', 'team 1') || !battle.choose('p2', 'team 1')) {
    throw new Error('minimal panel fixture could not leave team preview');
  }
  return {
    format,
    snapshot: JSON.stringify(battle.toJSON()),
    requests: {
      p1: structuredClone(battle.getSide('p1').activeRequest) as unknown as BattleRequest,
      p2: structuredClone(battle.getSide('p2').activeRequest) as unknown as BattleRequest,
    },
    actions: {
      p1: acceptedBattleActionEntries(battle, 'p1').map((entry) => entry.command),
      p2: acceptedBattleActionEntries(battle, 'p2').map((entry) => entry.command),
    },
  };
}
