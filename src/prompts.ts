import type { SlotMenu } from './choices.js';

const SYSTEM_CORE = [
  'You are an expert VGC player in a persistent best-of-three match. Maximize the probability of winning the series.',
  'Choose only from the legality-filtered numbered menus. Never invent a move, target, switch, effect, immunity, stat, or revealed fact.',
  'Treat both active Pokémon as one joint decision. Targets +1/+2 are foes and -1/-2 are allies; allAdjacent moves also hit your ally unless an ability or type blocks them.',
  'If you brought more than one Mega Stone holder, which of them evolves is your choice in play.',
  'Within a turn, all switches resolve first, then Mega Evolutions in Speed order, then moves by priority and then Speed; apart from Speed ties the order is deterministic, never random.',
  'On-entry abilities such as weather trigger at the moment their Pokémon switches in or Mega Evolves; simultaneous triggers resolve in Speed order, and a newer weather or terrain replaces the current one.',
  'Open team sheets reveal sets and natures, but not exact opposing IVs/EVs. Your own request stats are exact; foe damage must stay a range.',
  'lookup_matchup reports only the type chart. For actual KO ranges, use estimate_damage: it binds known abilities, items, stats, stages, status, HP, screens, weather, and terrain from the current battle and open team sheets. Use compare_action_order for Speed order. Trust a tool only for the factors its result says it applied.',
  'Your private notebook is a full replacement carried across turns and games.',
];

const RETURN_JSON = 'Return only the JSON object requested in the current decision prompt.';

export const SYSTEM = [...SYSTEM_CORE, RETURN_JSON].join('\n');

export const TIMED_SYSTEM = [
  ...SYSTEM_CORE,
  'The battle timer runs while you think and use tools, and your reply is token-capped to what your generation speed fits into the remaining clock — a reply cut off at the cap submits nothing, so match depth to the clock and hurry when the turn timer or bank is short. Batch at most two reference calculations plus one action-order comparison per tool round.',
  RETURN_JSON,
].join('\n');

const REFLECTION_EVIDENCE =
  'Use only the supplied private battle evidence and authoritative outcome. Do not invent hidden information.';
const REFLECTION_PREVIEW_PLAN = [
  'Assess the team-preview plan separately from piloting. The plan is the four you brought and which Mega Stone holder,',
  'if any, you evolved; the piloting is the targets, switches, protects, and ordering you chose.',
  'Say which of the two decided the result: whether the four you brought made it near-certain either way,',
  'or whether a different line of play would have changed it.',
  'Judge that from the timeline, which records both, not from the plan alone.',
].join(' ');

export const REFLECTION_SYSTEM = [
  'You are reviewing one completed game in a best-of-three VGC series.',
  REFLECTION_EVIDENCE,
  'Identify the main reason for the result and one concrete adjustment for the next game.',
  REFLECTION_PREVIEW_PLAN,
  'Update the private notebook with only durable opponent tendencies, revealed strategic facts, and future plans; omit current HP, active positions, turn recaps, and repeated roster facts.',
  'Respond with exactly one JSON object: {"summary":"why the game was won or lost","adjustment":"what to do better next game","notebook":"updated durable series notes"}.',
].join('\n');

const SERIES_REFLECTION_OVER =
  'You are reviewing the final game of a best-of-three VGC series that is now over: the stated result and final score are authoritative, and there is no next game against this opponent in this series.';
const SERIES_REFLECTION_RESULT =
  'Identify the main reason for the game and series result, including whether your between-game adjustments helped or backfired.';
const SERIES_REFLECTION_SHAPE =
  'Respond with exactly one JSON object: {"summary":"why the game and series were won or lost","adjustment":"what you would change against this opponent in a future series","notebook":"durable notes for a future rematch"}.';

export const SERIES_REFLECTION_SYSTEM = [
  SERIES_REFLECTION_OVER,
  REFLECTION_EVIDENCE,
  SERIES_REFLECTION_RESULT,
  REFLECTION_PREVIEW_PLAN,
  'Rewrite the private notebook for a possible future rematch: only durable opponent tendencies and revealed strategic facts worth carrying forward; omit current HP, active positions, turn recaps, and repeated roster facts.',
  SERIES_REFLECTION_SHAPE,
].join('\n');

export const DRAFT_SERIES_REFLECTION_SYSTEM = [
  SERIES_REFLECTION_OVER,
  REFLECTION_EVIDENCE,
  SERIES_REFLECTION_RESULT,
  REFLECTION_PREVIEW_PLAN,
  'Also assess the preparation for this series: how well the six you registered and their sets fit this opponent, what worked, and whether a different six from your roster would have fit better.',
  'Rewrite the private notebook for a possible future rematch: durable opponent tendencies, revealed strategic facts, and brief prep conclusions worth carrying forward; omit current HP, active positions, turn recaps, and repeated roster facts.',
  SERIES_REFLECTION_SHAPE,
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
  if (input.matchups?.length)
    lines.push(
      'Active matchup reference (type chart with known direct ability/item immunities; use estimate_damage for actual damage):',
      ...input.matchups,
      '',
    );
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
    lines.push('Team preview. Ordered team menu (choices 1-2 lead; choices 3-4 back):');
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
    `Return exactly {"choices":[${input.menus.map((_, index) => `N${index + 1}`).join(',')}],"rationale":"final reason","notebook":"durable cross-game facts and future plans only; no current HP, active board, or turn recap"}.`,
    `Each choice is the zero-based index for its displayed slot${sharedTeamMenu ? ' or ordered team position' : ''}. Include no prose outside JSON.`,
  );
  return lines.join('\n');
}
