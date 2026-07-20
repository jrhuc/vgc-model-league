import type { SlotMenu } from './choices.js';

export const SYSTEM = [
  'You are an expert VGC player in a persistent best-of-three match. Maximize the probability of winning the series.',
  'Choose only from the legality-filtered numbered menus. Never invent a move, target, switch, effect, immunity, stat, or revealed fact.',
  'Treat both active Pokémon as one joint decision: plan their actions together.',
  'Targets +1/+2 are opposing slots and -1/-2 are allied slots. Spreads that hit allAdjacent also hit your ally unless an ability/type blocks them.',
  'At team preview, bring four of six Pokémon and choose their complete order. Menus use species names, not nicknames.',
  'Open team sheets reveal sets and natures, but not exact opposing IVs/EVs. Your own request stats are exact; foe damage must stay a range.',
  "At preview, identify each side's likely modes, intended Mega, speed control, damage plan, defensive pivots, and endgame before choosing a lead and back two.",
  'Only one Pokémon can Mega Evolve per battle. If you bring multiple Mega Stones, evaluate every non-chosen holder strictly in its base forme.',
  'Each turn, compare plausible opposing joint actions before locking in. Account for priority, speed/Trick Room order, targeting, spread reduction, accuracy, Protect odds, switches, and the remaining win condition.',
  'Do not take a free super-effective hit when Protect, switching, redirecting, or KOing the threat first is available, especially when you move second.',
  'Use lookup_matchup and estimate_damage before committing to damaging moves when type interaction or KO chance matters. Use other Showdown lookup tools for unclear mechanics. Never transfer Mega-only traits to a base forme.',
  'Use the per-turn timer fully when the line is non-obvious. You may lock in once the joint action is clear; do not idle until the bank is empty.',
  'Your private notebook is a full replacement carried across every turn and game. Keep only durable facts and plans.',
  'Respond with exactly one JSON object:',
  '{"threats":["likely opposing joint actions or KO threats"],"candidates":["2-3 joint lines considered"],"choices":[N,...],"rationale":"brief final reason","notebook":"updated durable series notes"}.',
  'threats and candidates must be string arrays. choices must contain one zero-based menu index per displayed slot, in order. Include no prose outside JSON.',
].join('\n');

export const REFLECTION_SYSTEM = [
  'You are reviewing one completed game in a best-of-three VGC series.',
  'Use only the supplied private battle evidence and authoritative outcome. Do not invent hidden information.',
  'Identify the main reason for the result and one concrete adjustment for the next game.',
  'Question the team-preview plan itself — whether the four brought and the intended Mega suited this opponent — not only how the game was piloted.',
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
  matchups?: string[];
}

export function renderDecision(input: DecisionPrompt): string {
  const lines: string[] = [];
  if (input.seriesContext) lines.push('Match context:', input.seriesContext, '');
  lines.push('Current authoritative state:', input.state, '');
  if (input.matchups?.length) lines.push('Active type matchups (chart only):', ...input.matchups, '');
  lines.push(`Private notebook: ${input.notebook || '(empty)'}`, '');
  if (input.transcript?.length) lines.push('Compact private battle timeline (your POV):', ...input.transcript, '');
  if (input.mechanics?.length) lines.push('Compact Showdown reference (active/bench):', ...input.mechanics, '');
  lines.push(
    input.menus.length === 1
      ? `Choose for ${input.slotNames[0] ?? 'Pokémon'}:`
      : 'Choose all parts of this joint decision together:',
  );
  if (input.menus.some((menu) => menu.some((item) => item.kind === 'team')))
    lines.push(
      "Team-preview requirement: first work out how your own six are built to win — the team's gameplan, primary win condition, and each member's part in it — and record that plus the intended Mega in the notebook.",
      'In the rationale name the intended Mega and the role of all four picks. If multiple Mega Stones are selected, justify each non-chosen holder using only its base forme (base ability and stats).',
    );
  for (const [slot, menu] of input.menus.entries()) {
    lines.push(`Slot ${slot + 1}: ${input.slotNames[slot] ?? `slot ${slot + 1}`}:`);
    for (const [index, item] of menu.entries()) lines.push(`  ${index}. ${item.label}`);
  }
  lines.push(
    '',
    'Respond with exactly {"threats":[...],"candidates":[...],"choices":[<index for slot 1>,...],"rationale":"brief final reason","notebook":"updated durable series notes"}.',
  );
  return lines.join('\n');
}
