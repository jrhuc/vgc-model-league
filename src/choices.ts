import type { BattleRequest, JsonObject } from './types.js';

import { afterColon, asRecords, text } from './value.js';

export type MenuKind = 'move' | 'switch' | 'team' | 'pass';
export interface MenuItem {
  label: string;
  part: string;
  kind: MenuKind;
}
export type SlotMenu = MenuItem[];
export type TargetNames = Record<'foe' | 'ally', Record<number, string>>;

const SELECTED_TARGETS = new Set(['normal', 'any', 'adjacentFoe']);
const SPREAD_TARGETS = new Set(['allySide', 'foeSide', 'all', 'allAdjacent', 'allAdjacentFoes', 'allies']);

function pokemonName(pokemon: JsonObject): string {
  return afterColon(text(pokemon.ident)) || text(pokemon.details, 'Pokémon').split(',', 1)[0]!;
}

function switches(request: BattleRequest, reviving = false): SlotMenu {
  const menu: SlotMenu = [];
  for (const [index, pokemon] of (request.side?.pokemon ?? []).entries()) {
    const fainted = text(pokemon.condition).endsWith(' fnt');
    if (pokemon.active || fainted !== reviving) continue;
    menu.push({ label: `Switch to ${pokemonName(pokemon)}`, part: `switch ${index + 1}`, kind: 'switch' });
  }
  return menu;
}

function moveItems(
  move: JsonObject,
  moveSlot: number,
  slot: number,
  activeCount: number,
  hasAlly: boolean,
  mega: boolean,
  names?: TargetNames,
): SlotMenu {
  const target = text(move.target);
  const targetLabel = (side: 'foe' | 'ally', number: number) => {
    const species = names?.[side][number];
    return ` -> ${side} ${number}${species ? ` (${species})` : ''}`;
  };
  let targets: Array<[string, string]> = [['', '']];
  if (activeCount > 1 && SELECTED_TARGETS.has(target)) {
    targets = [1, 2].map((number) => [` +${number}`, targetLabel('foe', number)]);
    if ((target === 'normal' || target === 'any') && hasAlly) {
      const ally = slot === 1 ? 2 : 1;
      targets.push([` -${ally}`, targetLabel('ally', ally)]);
    }
  } else if (activeCount > 1 && target === 'adjacentAlly') {
    const ally = slot === 1 ? 2 : 1;
    targets = hasAlly ? [[` -${ally}`, targetLabel('ally', ally)]] : [];
  } else if (activeCount > 1 && target === 'adjacentAllyOrSelf') {
    const ally = slot === 1 ? 2 : 1;
    targets = [[` -${slot}`, ' -> itself']];
    if (hasAlly) targets.push([` -${ally}`, targetLabel('ally', ally)]);
  }

  const name = text(move.move, `Move ${moveSlot}`);
  const spread = SPREAD_TARGETS.has(target) ? ' (spread)' : '';
  return targets.flatMap(([targetPart, label]) => {
    const part = `move ${moveSlot}${targetPart}`;
    const item: MenuItem = { label: `${name}${spread}${label}`, part, kind: 'move' };
    return mega ? [item, { label: `${item.label} + Mega Evolve`, part: `${part} mega`, kind: 'move' }] : [item];
  });
}

export function buildMenus(request: BattleRequest, names?: TargetNames): SlotMenu[] {
  const pokemon = request.side?.pokemon ?? [];
  if (request.wait) return [];
  if (request.teamPreview) {
    const count = request.maxChosenTeamSize || pokemon.length;
    const base = pokemon.map(
      (mon, index): MenuItem => ({ label: `Pick ${pokemonName(mon)}`, part: String(index + 1), kind: 'team' }),
    );
    return Array.from({ length: count }, () => base.map((item) => ({ ...item })));
  }
  if (request.forceSwitch) {
    const active = pokemon.filter((mon) => mon.active);
    const menus = request.forceSwitch.map((forced, slot): SlotMenu => {
      if (!forced) return [{ label: 'Pass', part: 'pass', kind: 'pass' }];
      const menu = switches(request, Boolean(active[slot]?.reviving));
      return menu.length ? menu : [{ label: 'Pass', part: 'pass', kind: 'pass' }];
    });
    const forced = request.forceSwitch.flatMap((value, index) => (value ? [index] : []));
    const targets = new Set(
      menus.flatMap((menu) => menu.filter((item) => item.kind === 'switch').map((item) => item.part)),
    );
    if (targets.size < forced.length) {
      for (const index of forced) {
        const menu = menus[index]!;
        if (!menu.some((item) => item.kind === 'pass')) menu.push({ label: 'Pass', part: 'pass', kind: 'pass' });
      }
    }
    return menus;
  }
  if (request.active) {
    const activePokemon = pokemon.filter((mon) => mon.active);
    return request.active.map((active, slotIndex): SlotMenu => {
      const slot = slotIndex + 1;
      const current = activePokemon[slotIndex] ?? {};
      if (!active || current.commanding || text(current.condition).endsWith(' fnt')) {
        return [{ label: 'Pass', part: 'pass', kind: 'pass' }];
      }
      const moves = asRecords(active.moves);
      const menu = moves.flatMap((move, index) =>
        move.disabled
          ? []
          : moveItems(
              move,
              index + 1,
              slot,
              request.active!.length,
              request.active!.length > 1 && request.active![slot === 1 ? 1 : 0] !== null,
              Boolean(active.canMegaEvo),
              names,
            ),
      );
      if (moves.length && moves.every((move) => move.disabled))
        menu.push({ label: 'Struggle', part: 'move 1', kind: 'move' });
      if (!active.trapped) menu.push(...switches(request));
      return menu.length ? menu : [{ label: 'Pass', part: 'pass', kind: 'pass' }];
    });
  }
  return [[{ label: 'Pass', part: 'pass', kind: 'pass' }]];
}

export function compose(parts: string[]): string {
  return parts.join(', ');
}
