function battleHpPercent(value = ''): string {
  const [raw = '', status] = value.trim().split(/\s+/);
  const match = /^(\d+)\/(\d+)[a-z]*$/i.exec(raw);
  if (match && Number(match[2]))
    return `${Math.round((100 * Number(match[1])) / Number(match[2]))}%${status ? ` ${status}` : ''}`;
  if (raw === '0') return `0%${status ? ` ${status}` : ''}`;
  return value;
}

const PROTECTION_EFFECTS = new Set([
  'Protect',
  'Detect',
  'Spiky Shield',
  'Baneful Bunker',
  "King's Shield",
  'Silk Trap',
  'Burning Bulwark',
  'Obstruct',
  'Mat Block',
  'Crafty Shield',
  'Quick Guard',
  'Wide Guard',
  'Max Guard',
]);

export function summarizeBattleEvents(lines: string[], pov?: 'p1' | 'p2'): string[] {
  const summary: string[] = [];
  const ident = (value = '') => value.replace(/^p[12][a-z]?:\s*/, '');
  const sideLabel = (value = '') => {
    const side = /^(p[12])[ab]?:?/.exec(value)?.[1];
    if (!pov || !side) return value;
    return side === pov ? 'Your side' : "The opponent's side";
  };
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const [, kind = '', ...args] = line.split('|');
    if (kind === 'turn') summary.push(`Turn ${args[0]} begins.`);
    else if ((kind === 'switch' || kind === 'drag' || kind === 'replace') && args.length >= 3)
      summary.push(`${ident(args[0])} entered as ${args[1]!.split(',', 1)[0]} at ${battleHpPercent(args[2])}.`);
    else if (kind === 'move' && args.length >= 2)
      summary.push(`${ident(args[0])} used ${args[1]}${args[2] ? ` into ${ident(args[2])}` : ''}.`);
    else if ((kind === '-damage' || kind === '-heal') && args.length >= 2)
      summary.push(
        `${ident(args[0])} HP became ${battleHpPercent(args[1])}${kind === '-heal' ? ' after healing' : ''}.`,
      );
    else if (kind === 'faint' && args[0]) summary.push(`${ident(args[0])} fainted.`);
    else if (kind === 'cant' && args.length >= 2) {
      const blocked = args.find((arg) => arg.startsWith('[of] '));
      const ability = /^ability: (.+)$/.exec(args[1] ?? '');
      if (ability && args[2] && blocked)
        summary.push(`${ident(blocked.slice(5))}'s ${args[2]} was blocked by ${ident(args[0])}'s ${ability[1]}.`);
      else summary.push(`${ident(args[0])} could not act (${args[1]}).`);
    } else if (kind === '-status' && args.length >= 2) summary.push(`${ident(args[0])} became ${args[1]}.`);
    else if (kind === '-curestatus' && args.length >= 2) summary.push(`${ident(args[0])} was cured of ${args[1]}.`);
    else if (kind === '-ability' && args.length >= 2) {
      const copiedBy = args.find((arg) => arg.startsWith('[from] ability: '))?.slice('[from] ability: '.length);
      const source = args.find((arg) => arg.startsWith('[of] '))?.slice('[of] '.length);
      summary.push(
        copiedBy && source
          ? `${ident(args[0])}'s ${copiedBy} copied ${args[1]} from ${ident(source)}.`
          : `${ident(args[0])} revealed ${args[1]}.`,
      );
    } else if (kind === '-endability' && args[0])
      summary.push(`${ident(args[0])}'s ability${args[1] ? ` ${args[1]}` : ''} was suppressed.`);
    else if (kind === '-mega' && args[0]) summary.push(`${ident(args[0])} Mega Evolved.`);
    else if (kind === '-miss' && args.length >= 2) summary.push(`${ident(args[0])} missed ${ident(args[1])}.`);
    else if (kind === '-prepare' && args.length >= 2)
      summary.push(`${ident(args[0])} is charging ${args[1]}; it releases next turn unless disrupted.`);
    else if (kind === '-immune' && args[0]) summary.push(`${ident(args[0])} was immune.`);
    else if (kind === '-fail' && args[0]) summary.push(`${ident(args[0])}'s action failed.`);
    else if (kind === '-crit' && args[0]) summary.push(`A critical hit landed on ${ident(args[0])}.`);
    else if (kind === '-supereffective' && args[0]) summary.push(`The hit on ${ident(args[0])} was super effective.`);
    else if (kind === '-resisted' && args[0]) summary.push(`${ident(args[0])} resisted the hit.`);
    else if (kind === '-activate' && args.length >= 2) {
      const protection = /^move: (.+)$/.exec(args[1] ?? '');
      summary.push(
        protection && PROTECTION_EFFECTS.has(protection[1]!)
          ? `${ident(args[0])}'s ${protection[1]} blocked the incoming move.`
          : `${ident(args[0])} activated ${args[1]}.`,
      );
    } else if ((kind === '-start' || kind === '-end') && args.length >= 2)
      summary.push(`${ident(args[0])} ${kind === '-start' ? 'gained' : 'lost'} ${args[1]}.`);
    else if ((kind === '-boost' || kind === '-unboost') && args.length >= 3)
      summary.push(`${ident(args[0])} ${args[1]} ${kind === '-boost' ? 'rose' : 'fell'} by ${args[2]}.`);
    else if (kind === '-weather' && !args.includes('[upkeep]')) summary.push(`Weather became ${args[0] || 'none'}.`);
    else if (kind === '-fieldstart' && args[0]) summary.push(`Field started: ${args[0]}.`);
    else if (kind === '-fieldend' && args[0]) summary.push(`Field ended: ${args[0]}.`);
    else if ((kind === '-sidestart' || kind === '-sideend') && args.length >= 2)
      summary.push(
        `${sideLabel(args[0])} ${kind === '-sidestart' ? 'gained' : 'lost'} ${args[1]!.replace(/^move: /, '')}.`,
      );
    else if (kind === 'win' && args[0]) {
      const side = /^(p[12])-/.exec(args[0])?.[1];
      summary.push(pov && side ? `${side === pov ? 'You' : 'The opponent'} won the game.` : `${args[0]} won the game.`);
    } else if (kind === 'tie') summary.push('The game tied.');
    else if (kind === 'timer' && args[0])
      summary.push(
        args[0] === 'autodefault'
          ? 'Move time expired; the simulator chose default actions.'
          : args[0] === 'forfeit'
            ? 'The time bank ran out; the game was lost on time.'
            : 'The game was declared a tie on time.',
      );
  }
  return summary.slice(-200);
}
