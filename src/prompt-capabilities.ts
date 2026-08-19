export const MECHANICS_TOOL_CAPABILITY_PROTOCOL = {
  version: 1,
  available: 'interactive-showdown-dex-tools-v1',
  unavailable: 'prompt-evidence-only-no-interactive-tools-v1',
} as const;

export type MechanicsToolAvailability = 'available' | 'unavailable';

export const NO_INTERACTIVE_MECHANICS_TOOLS_NOTICE = [
  'No interactive mechanics tools are available in this scaffold.',
  'Use only the mechanics, board, rosters, candidate details, and other evidence printed in this prompt. Do not attempt tool calls or assume an omitted lookup was performed.',
].join('\n');

export function mechanicsToolNotice(availability: MechanicsToolAvailability, availableNotice: string): string {
  if (!availableNotice) throw new Error('available mechanics-tool notice must be non-empty');
  if (availability === 'available') return availableNotice;
  if (availability === 'unavailable') return NO_INTERACTIVE_MECHANICS_TOOLS_NOTICE;
  throw new Error(`unknown mechanics-tool availability ${String(availability)}`);
}
