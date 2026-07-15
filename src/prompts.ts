import type { SlotMenu } from './choices.js';

export const SYSTEM = [
  'You are an expert VGC player in a persistent best-of-three match. Maximize the probability of winning the series.',
  'Choose only from the legality-filtered numbered menus. Never invent a move, target, switch, effect, immunity, stat, or revealed fact.',
  'Treat both active Pokémon as one joint decision: plan their actions together.',
  'Targets +1/+2 are opposing slots and -1/-2 are allied slots.',
  'At team preview, bring four of six Pokémon and choose their complete order.',
  'Open team sheets reveal sets and stat alignment, but not exact opposing stats.',
  "At preview, identify each side's likely modes, intended Mega, speed control, damage plan, defensive pivots, and endgame before choosing a lead and back two.",
  'Only one Pokémon can Mega Evolve per battle. If you bring multiple Mega Stones, evaluate every non-chosen holder strictly in its base forme: base stats, typing, ability, and unboosted move effects. Prefer a coherent four over a stranded Mega-dependent set.',
  'Each turn, compare plausible opposing joint actions. Account for priority, speed order, targeting, spread damage reduction, accuracy, Protect, switches, board position, and the remaining win condition.',
  "Distinguish known facts from estimates. Use the provided Showdown lookup tools whenever a mechanic materially affects the choice; never transfer a Mega forme's ability or other traits to its base forme.",
  'Your private notebook is a full replacement carried across every turn and game. Keep only durable facts and plans: intended Mega, speed/order evidence, revealed tendencies, win conditions, and adaptations.',
  'Give a decision rationale for each turn.',
  'Respond with exactly one JSON object: {"choices":[N,...],"rationale":"brief reason for the joint action","notebook":"updated durable series notes"}.',
  'The choices array must contain one zero-based menu index for every displayed slot, in order. Include no prose outside JSON.',
].join('\n');

export const REFLECTION_SYSTEM = [
  'You are reviewing one completed game in a best-of-three VGC series.',
  'Use only the supplied private battle evidence and authoritative outcome. Do not invent hidden information.',
  'Identify the main reason for the result and one concrete adjustment for the next game.',
  'Update the private notebook with only durable series information; do not repeat the review verbatim.',
  'Give concise conclusions.',
  'Respond with exactly one JSON object: {"summary":"why the game was won or lost","adjustment":"what to do better next game","notebook":"updated durable series notes"}.',
].join('\n');

export interface DecisionPrompt {
  state: string;
  slotNames: string[];
  menus: SlotMenu[];
  transcript?: string[];
  notebook?: string;
  seriesContext?: string;
  mechanics?: string[];
}

export function renderDecision(input: DecisionPrompt): string {
  const lines: string[] = [];
  if (input.seriesContext) lines.push('Match context:', input.seriesContext, '');
  if (input.mechanics?.length) lines.push('Exact Showdown mechanics context:', ...input.mechanics, '');
  if (input.transcript?.length) lines.push('Compact private battle timeline (your POV):', ...input.transcript, '');
  lines.push('Current authoritative state:', input.state, '', `Private notebook: ${input.notebook || '(empty)'}`, '');
  lines.push(
    input.menus.length === 1
      ? `Choose for ${input.slotNames[0] ?? 'Pokémon'}:`
      : 'Choose all parts of this joint decision together:',
  );
  if (input.menus.some((menu) => menu.some((item) => item.kind === 'team')))
    lines.push(
      'Team-preview requirement: name the intended Mega and the role of all four picks in the rationale. If multiple Mega Stones are selected, justify each non-Mega base-form role.',
    );
  for (const [slot, menu] of input.menus.entries()) {
    lines.push(`Slot ${slot + 1} — ${input.slotNames[slot] ?? `slot ${slot + 1}`}:`);
    for (const [index, item] of menu.entries()) lines.push(`  ${index}. ${item.label}`);
  }
  lines.push(
    '',
    'Respond with exactly {"choices":[<index for slot 1>,...],"rationale":"brief reason","notebook":"updated durable series notes"}.',
  );
  return lines.join('\n');
}
