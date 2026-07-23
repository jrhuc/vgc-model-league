import type { SlotMenu } from './choices.js';

export const SYSTEM = [
  'You are an expert VGC player in a persistent best-of-three match. Maximize the probability of winning the series.',
  'Choose only from the legality-filtered numbered menus. Never invent a move, target, switch, effect, immunity, stat, or revealed fact.',
  "Ground every capability claim in a listed move or ability: a Pokémon's typing says what it resists, not what it can attack with.",
  'Treat both active Pokémon as one joint decision. Targets +1/+2 are foes and -1/-2 are allies; allAdjacent moves also hit your ally unless an ability or type blocks them.',
  'At team preview, compare complete four-Pokémon modes against the opponent before choosing one coherent lead and endgame. Name one intended Mega; evaluate every other Mega Stone holder strictly in its base forme.',
  'Open team sheets reveal sets and natures, but not exact opposing IVs/EVs. Your own request stats are exact; foe damage must stay a range.',
  'Each turn, compare the few opposing joint actions that materially change your line. Account for priority, speed order, targeting, spread reduction, accuracy, Protect odds, switches, and the remaining win condition.',
  'Do not take a free super-effective hit when Protect, switching, redirecting, or KOing the threat first is available, especially when you move second.',
  "Verify type effectiveness with lookup_matchup, KO ranges with estimate_damage, and speed order with compare_action_order instead of recalling them: the tools compute from the simulator's own data and are authoritative when they disagree with your memory. Pass your own Pokémon's exact stats to estimate_damage on either side of a calculation to narrow the range. Under a battle timer, batch at most two reference calculations plus one action-order comparison per tool round; without a timer, verify as widely as the decision warrants.",
  'When the decision prompt shows a battle timer, it runs while you think and use tools, and your reply is token-capped to what your generation speed fits into the remaining clock — a reply cut off at the cap submits nothing, so match depth to the clock and hurry when the turn timer or bank is short. Without a timer, reason as deeply as the decision warrants and then commit.',
  'Your private notebook is a full replacement carried across turns and games. Keep only durable opponent tendencies, revealed strategic facts, and future plans. Omit current HP, active positions, turn recaps, and roster facts already present in state.',
  'Return only the JSON object requested in the current decision prompt.',
].join('\n');

export const REFLECTION_SYSTEM = [
  'You are reviewing one completed game in a best-of-three VGC series.',
  'Use only the supplied private battle evidence and authoritative outcome. Do not invent hidden information.',
  'Identify the main reason for the result and one concrete adjustment for the next game.',
  'Question the team-preview plan itself — whether the four brought and the intended Mega suited this opponent — not only how the game was piloted.',
  'Update the private notebook with only durable opponent tendencies, revealed strategic facts, and future plans; omit current HP, active positions, turn recaps, and repeated roster facts.',
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
  matchups?: string[];
}

export function renderDecision(input: DecisionPrompt): string {
  const lines: string[] = [];
  if (input.seriesContext) lines.push('Match context:', input.seriesContext, '');
  lines.push('Authoritative battle state and roster reference:', input.state, '');
  if (input.matchups?.length) lines.push('Active type matchups (chart only):', ...input.matchups, '');
  lines.push(`Private notebook: ${input.notebook || '(empty)'}`, '');
  if (input.transcript?.length) lines.push('Compact private battle timeline (your POV):', ...input.transcript, '');

  const sharedTeamMenu =
    input.menus.length > 1 &&
    input.menus.every(
      (menu) =>
        menu.every((item) => item.kind === 'team') &&
        menu.length === input.menus[0]?.length &&
        menu.every((item, index) => item.label === input.menus[0]?.[index]?.label),
    );
  if (sharedTeamMenu) {
    lines.push(
      'Team preview: compare complete modes, then choose one. Do not combine a lead whose purpose depends on one Mega with a backline built around another. In the rationale, name the intended Mega, the lead pair’s turn-one job, and how the back two complete the plan. Treat any other Mega Stone holder as its base forme.',
      'Ordered team menu (choices 1-2 lead; choices 3-4 back):',
    );
    for (const [index, item] of input.menus[0]!.entries()) lines.push(`  ${index}. ${item.label}`);
  } else {
    lines.push(
      input.menus.length === 1
        ? `Choose for ${input.slotNames[0] ?? 'Pokémon'}:`
        : 'Choose all parts of this joint decision together:',
    );
    for (const [slot, menu] of input.menus.entries()) {
      lines.push(`Slot ${slot + 1}: ${input.slotNames[slot] ?? `slot ${slot + 1}`}:`);
      for (const [index, item] of menu.entries()) lines.push(`  ${index}. ${item.label}`);
    }
  }
  lines.push(
    '',
    `Return exactly {"threats":["up to 3 short likely opposing lines"],"candidates":["2-3 short joint lines"],"choices":[${input.menus.map((_, index) => `N${index + 1}`).join(',')}],"rationale":"final reason, at most 500 characters","notebook":"durable cross-game facts and future plans only; no current HP, active board, or turn recap; at most 1600 characters"}.`,
    `Each choice is the zero-based index for its displayed slot${sharedTeamMenu ? ' or ordered team position' : ''}. Include no prose outside JSON.`,
  );
  return lines.join('\n');
}
