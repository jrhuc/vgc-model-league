import type { SlotMenu } from './choices.js';

export const SYSTEM = [
  'You are one player in a persistent best-of-three VGC match.',
  'Choose only from the legality-filtered numbered menus and play to win without assuming hidden information.',
  'Treat both active Pokémon as one joint decision: plan their actions together.',
  'Targets +1/+2 are opposing slots and -1/-2 are allied slots.',
  'At team preview, bring four of six Pokémon and choose their complete order.',
  'Open team sheets reveal sets and stat alignment, but not exact opposing stats.',
  'Mega Evolution, when offered, can be used only once per battle.',
  'Your private notebook is carried across every turn and game in the series.',
  'Look up move, species, item, ability, or nature facts with the provided tools when you need them.',
  'Reason internally. Respond with exactly one JSON object: {"choices":[N,...],"notes":"brief private notebook"}.',
  'The choices array must contain one zero-based menu index for every displayed slot, in order. Include no prose outside JSON.',
].join('\n');

export interface DecisionPrompt {
  state: string;
  slotNames: string[];
  menus: SlotMenu[];
  transcript?: string[];
  notebook?: string;
  seriesContext?: string;
}

export function renderDecision(input: DecisionPrompt): string {
  const lines: string[] = [];
  if (input.seriesContext) lines.push('Match context:', input.seriesContext, '');
  if (input.transcript?.length) lines.push('Persistent private match transcript (your POV):', ...input.transcript, '');
  lines.push('Current authoritative state:', input.state, '', `Private notebook: ${input.notebook || '(empty)'}`, '');
  lines.push(
    input.menus.length === 1
      ? `Choose for ${input.slotNames[0] ?? 'Pokémon'}:`
      : 'Choose all parts of this joint decision together:',
  );
  for (const [slot, menu] of input.menus.entries()) {
    lines.push(`Slot ${slot + 1} — ${input.slotNames[slot] ?? `slot ${slot + 1}`}:`);
    for (const [index, item] of menu.entries()) lines.push(`  ${index}. ${item.label}`);
  }
  lines.push('', 'Respond with exactly {"choices":[<index for slot 1>,...],"notes":"updated brief private notebook"}.');
  return lines.join('\n');
}
