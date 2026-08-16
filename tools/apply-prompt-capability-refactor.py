from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new))


def replace_block(path: str, start: str, end: str, new: str) -> None:
    text = read(path)
    begin = text.find(start)
    if begin < 0:
        raise RuntimeError(f"{path}: missing block start {start!r}")
    finish = text.find(end, begin)
    if finish < 0:
        raise RuntimeError(f"{path}: missing block end {end!r}")
    write(path, text[:begin] + new + text[finish:])


replace_once(
    "src/draft.ts",
    "import { BOARDS_DIR, defaultPsDir } from './paths.js';\nimport { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
    "import { BOARDS_DIR, defaultPsDir } from './paths.js';\n"
    "import {\n"
    "  mechanicsToolNotice,\n"
    "  type MechanicsToolAvailability,\n"
    "} from './prompt-capabilities.js';\n"
    "import { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
)
replace_once(
    "src/draft.ts",
    "const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;\n",
    "const BOARD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;\n\n"
    "const DRAFT_AVAILABLE_MECHANICS_TOOLS = [\n"
    "  'You have the Showdown dex tools. Use them to check anything the board summary does not answer: what a Mega',\n"
    "  'becomes, how a type matchup reads, what a spread outruns, or roughly how hard an attack hits. They compute',\n"
    "  'from the simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;',\n"
    "  'a hypothetical damage result does not imply omitted abilities or field effects. search_board filters and re-sorts the',\n"
    "  'board itself by type, price, ability, base stat total, or which entries legally learn a given move.',\n"
    "].join('\\n');\n",
)
replace_block(
    "src/draft.ts",
    "function draftSystemPrompt(",
    "\n\nexport function draftUserPrompt",
    """function draftSystemPrompt(
  board: DraftBoard,
  models: string[],
  drafter: number,
  psDir: string,
  rosterPolicy: string,
  mechanicsTools: MechanicsToolAvailability,
): string {
  const values: Record<string, string> = {
    model: models[drafter]!,
    format: board.format,
    coaches: String(models.length),
    picks: String(board.picks),
    budget: String(board.budget),
    board: draftBoardTable(board, psDir),
    rosterPolicy,
  };
  const rendered = DRAFT_PROMPT_POLICY.systemTemplate
    .map((line) =>
      Object.entries(values).reduce(
        (current, [name, value]) => current.replaceAll(`{{${name}}}`, value),
        line as string,
      ),
    )
    .join('\\n');
  return rendered.replace(
    DRAFT_AVAILABLE_MECHANICS_TOOLS,
    mechanicsToolNotice(mechanicsTools, DRAFT_AVAILABLE_MECHANICS_TOOLS),
  );
}""",
)
replace_block(
    "src/draft.ts",
    "export function connectedDraftPromptRevision(",
    "\n\nexport function renderDraftPickPrompt",
    """export function connectedDraftPromptRevision(
  mechanicsTools: MechanicsToolAvailability = 'available',
): string {
  return createHash('sha256')
    .update(JSON.stringify([draftScaffoldRevision(), CONNECTED_DRAFT_PROMPT_POLICY, mechanicsTools]))
    .digest('hex')
    .slice(0, 12);
}""",
)
replace_block(
    "src/draft.ts",
    "export function renderDraftPickPrompt(",
    "\n\ninterface ParsedPick",
    """export function renderDraftPickPrompt(
  state: DraftState,
  drafter: number,
  models: string[],
  pickNumber: number,
  notebook: string,
  options: {
    psDir?: string;
    rosterPolicy: string;
    mechanicsTools?: MechanicsToolAvailability;
  },
): string {
  const psDir = options.psDir ?? defaultPsDir();
  const rosterPolicy = options.rosterPolicy;
  const mechanicsTools = options.mechanicsTools ?? 'available';
  const legalBoard: DraftBoard = { ...state.board, mons: legalPicks(state, drafter) };
  return [
    draftSystemPrompt(legalBoard, models, drafter, psDir, rosterPolicy, mechanicsTools),
    '',
    draftUserPrompt(state, drafter, models, pickNumber, notebook),
  ].join('\\n');
}""",
)

replace_once(
    "src/teambuild.ts",
    "import { defaultPsDir } from './paths.js';\nimport { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
    "import { defaultPsDir } from './paths.js';\n"
    "import {\n"
    "  mechanicsToolNotice,\n"
    "  type MechanicsToolAvailability,\n"
    "} from './prompt-capabilities.js';\n"
    "import { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
)
replace_once(
    "src/teambuild.ts",
    "const TEAMBUILD_PROMPT_POLICY = {\n",
    "const MATCHUP_AVAILABLE_MECHANICS_TOOLS = [\n"
    "  'You have the Showdown dex tools. Use them while you build: check what an item or ability actually does here,',\n"
    "  'what a spread outruns, and how hard an attack lands. They compute from the',\n"
    "  'simulator this league runs on. Trust the mechanics and factors each result explicitly says it applied;',\n"
    "  'a hypothetical damage result does not imply omitted abilities or field effects.',\n"
    "].join('\\n');\n\n"
    "const GENERAL_AVAILABLE_MECHANICS_TOOLS = [\n"
    "  'You have the Showdown dex tools. Use them while you build: check legal moves, items, abilities, speed benchmarks,',\n"
    "  'and damage against representative threats. The tools compute from the simulator this task validates against.',\n"
    "].join('\\n');\n\n"
    "const TEAMBUILD_PROMPT_POLICY = {\n",
)
replace_block(
    "src/teambuild.ts",
    "function systemPrompt(",
    "\n\nfunction userPrompt",
    """function systemPrompt(
  task: TeamBuildTask,
  dex: DexLike,
  evLimit: number,
  evMax: number,
  mechanicsTools: MechanicsToolAvailability,
): string {
  const values: Record<string, string> = {
    model: task.model,
    format: task.format,
    picks: String(task.constraint.candidates.length),
    teamSize: String(task.constraint.teamSize),
    evLimit: String(evLimit),
    evMax: String(evMax),
    items: `  ${legalItems(dex).join(', ')}`,
    teamSheetRule: teamSheetRule(task.sheetPolicy),
  };
  const rendered = renderPromptTemplate(
    task.objective.kind === 'matchup'
      ? TEAMBUILD_PROMPT_POLICY.systemTemplate
      : GENERAL_TEAMBUILD_PROMPT_POLICY.systemTemplate,
    values,
  );
  const availableNotice =
    task.objective.kind === 'matchup'
      ? MATCHUP_AVAILABLE_MECHANICS_TOOLS
      : GENERAL_AVAILABLE_MECHANICS_TOOLS;
  return rendered.replace(availableNotice, mechanicsToolNotice(mechanicsTools, availableNotice));
}""",
)
replace_block(
    "src/teambuild.ts",
    "export function connectedTeamBuildPromptRevision(",
    "\n\nexport function renderStrictTeamBuildPrompt",
    """export function connectedTeamBuildPromptRevision(
  objective: TeamBuildObjective,
  sheetPolicy: TeamBuildSheetPolicy,
  mechanicsTools: MechanicsToolAvailability = 'available',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        teamBuildScaffoldRevision(objective, sheetPolicy, 'strict'),
        'system-blank-line-user-v1',
        mechanicsTools,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
}""",
)
replace_block(
    "src/teambuild.ts",
    "export function renderStrictTeamBuildPrompt(",
    "\n\ninterface ParsedTeamBuild",
    """export function renderStrictTeamBuildPrompt(
  task: TeamBuildTask,
  options: Pick<TeamBuildRefereeOptions, 'psDir'> & {
    mechanicsTools?: MechanicsToolAvailability;
  } = {},
): string {
  const canonical = strictTask(task);
  validateTeamBuildTask(canonical);
  const psDir = options.psDir ?? defaultPsDir();
  const { Dex } = loadShowdown(psDir);
  const format = Dex.formats.get(canonical.format);
  const dex = Dex.mod(format.mod || 'base') as unknown as DexLike;
  const rules = Dex.formats.getRuleTable(format);
  return [
    systemPrompt(canonical, dex, rules.evLimit ?? 508, 32, options.mechanicsTools ?? 'available'),
    '',
    userPrompt(canonical, dex),
  ].join('\\n');
}""",
)

replace_once(
    "src/trade-window.ts",
    "import type { DraftTableRow } from './gui/api.js';\nimport { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
    "import type { DraftTableRow } from './gui/api.js';\n"
    "import {\n"
    "  mechanicsToolNotice,\n"
    "  type MechanicsToolAvailability,\n"
    "} from './prompt-capabilities.js';\n"
    "import { FORMAT_AUTHORITY_NOTICE } from './prompts.js';\n",
)
replace_once(
    "src/trade-window.ts",
    "export const MAX_TRADE_SWAPS = 6;\n",
    "export const MAX_TRADE_SWAPS = 6;\n\n"
    "const FREE_AGENCY_AVAILABLE_MECHANICS_TOOLS =\n"
    "  'You have the same Showdown dex tools as during the draft. Use them only where the supplied evidence and board do not answer the question.';\n"
    "const TRADE_OFFER_AVAILABLE_MECHANICS_TOOLS =\n"
    "  'You have the same Showdown dex tools as during the draft. Use them only where the supplied evidence and rosters do not answer the question.';\n",
)
replace_block(
    "src/trade-window.ts",
    "function systemPrompt(",
    "\n\nfunction userPrompt",
    """function systemPrompt(
  state: TradeWindowState,
  entrant: number,
  mechanicsTools: MechanicsToolAvailability,
): string {
  const rendered = renderTemplate(TRADE_WINDOW_PROMPT_POLICY.systemTemplate, {
    ...promptValues(state, entrant),
    maxSwaps: String(MAX_TRADE_SWAPS),
  });
  return rendered.replace(
    FREE_AGENCY_AVAILABLE_MECHANICS_TOOLS,
    mechanicsToolNotice(mechanicsTools, FREE_AGENCY_AVAILABLE_MECHANICS_TOOLS),
  );
}""",
)
replace_block(
    "src/trade-window.ts",
    "function offerSystemPrompt(",
    "\n\n/** Every seat prompt",
    """function offerSystemPrompt(
  state: TradeWindowState,
  entrant: number,
  mechanicsTools: MechanicsToolAvailability,
): string {
  const rendered = renderTemplate(TRADE_OFFER_PROMPT_POLICY.systemTemplate, promptValues(state, entrant));
  return rendered.replace(
    TRADE_OFFER_AVAILABLE_MECHANICS_TOOLS,
    mechanicsToolNotice(mechanicsTools, TRADE_OFFER_AVAILABLE_MECHANICS_TOOLS),
  );
}

function responseSystemPrompt(
  state: TradeWindowState,
  entrant: number,
  mechanicsTools: MechanicsToolAvailability,
): string {
  const rendered = renderTemplate(TRADE_OFFER_PROMPT_POLICY.responseSystemTemplate, promptValues(state, entrant));
  return mechanicsTools === 'available'
    ? rendered
    : `${rendered}\\n\\n${mechanicsToolNotice(mechanicsTools, TRADE_OFFER_AVAILABLE_MECHANICS_TOOLS)}`;
}""",
)
replace_block(
    "src/trade-window.ts",
    "export function connectedTradeWindowPromptRevision(",
    "\n\nfunction rosterArtifact",
    """export function connectedTradeWindowPromptRevision(
  mechanicsTools: MechanicsToolAvailability = 'available',
): string {
  return createHash('sha256')
    .update(JSON.stringify([tradeWindowScaffoldRevision(), 'system-blank-line-user-v1', mechanicsTools]))
    .digest('hex')
    .slice(0, 12);
}

export interface TradePromptRenderOptions {
  mechanicsTools?: MechanicsToolAvailability;
}

export function renderTradeOfferPrompt(
  state: TradeWindowState,
  entrant: number,
  psDir: string,
  options: TradePromptRenderOptions = {},
): string {
  validateLeagueRosterState(state);
  return [
    offerSystemPrompt(state, entrant, options.mechanicsTools ?? 'available'),
    '',
    offerUserPrompt(state, entrant, psDir),
  ].join('\\n');
}

export function renderTradeResponsePrompt(
  state: TradeWindowState,
  offer: { to: number; give: string; get: string; message: string },
  from: number,
  psDir: string,
  options: TradePromptRenderOptions = {},
): string {
  validateLeagueRosterState(state);
  const error = validateOfferTerms(state, from, offer);
  if (error) throw new Error(`invalid trade offer: ${error}`);
  return [
    responseSystemPrompt(state, offer.to, options.mechanicsTools ?? 'available'),
    '',
    responseUserPrompt(state, offer, from, psDir),
  ].join('\\n');
}

export function renderFreeAgencyPrompt(
  state: TradeWindowState,
  entrant: number,
  psDir: string,
  options: TradePromptRenderOptions = {},
): string {
  validateLeagueRosterState(state);
  return [
    systemPrompt(state, entrant, options.mechanicsTools ?? 'available'),
    '',
    userPrompt(state, entrant, psDir),
  ].join('\\n');
}""",
)

replace_once(
    "src/frozen-circuit-setup.ts",
    "export const FROZEN_CIRCUIT_PROMPT_POLICY = {\n  draftRosterPolicy:\n",
    "export const FROZEN_CIRCUIT_PROMPT_POLICY = {\n"
    "  mechanicsTools: 'unavailable' as const,\n"
    "  draftRosterPolicy:\n",
)
replace_once(
    "src/frozen-circuit-setup.ts",
    "draft: connectedDraftPromptRevision(),",
    "draft: connectedDraftPromptRevision(FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools),",
)
replace_once(
    "src/frozen-circuit-setup.ts",
    "construction: connectedTeamBuildPromptRevision({ kind: 'general' }, 'open'),",
    "construction: connectedTeamBuildPromptRevision(\n"
    "        { kind: 'general' },\n"
    "        'open',\n"
    "        FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,\n"
    "      ),",
)
replace_once(
    "src/frozen-circuit-setup.ts",
    "transaction: connectedTradeWindowPromptRevision(),",
    "transaction: connectedTradeWindowPromptRevision(FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools),",
)
replace_once(
    "src/frozen-circuit-referee.ts",
    "      { rosterPolicy: FROZEN_CIRCUIT_PROMPT_POLICY.draftRosterPolicy },\n",
    "      {\n"
    "        rosterPolicy: FROZEN_CIRCUIT_PROMPT_POLICY.draftRosterPolicy,\n"
    "        mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,\n"
    "      },\n",
)
replace_once(
    "src/frozen-circuit-referee.ts",
    "            renderStrictTeamBuildPrompt(task),\n",
    "            renderStrictTeamBuildPrompt(task, {\n"
    "              mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,\n"
    "            }),\n",
)
replace_once(
    "src/frozen-circuit-transactions.ts",
    "import { REPO_ROOT } from './paths.js';\n",
    "import { FROZEN_CIRCUIT_PROMPT_POLICY } from './frozen-circuit-setup.js';\n"
    "import { REPO_ROOT } from './paths.js';\n",
)
replace_once(
    "src/frozen-circuit-transactions.ts",
    "          renderTradeResponsePrompt(this.state, current.value, current.from, path.join(REPO_ROOT, 'pokemon-showdown')),\n",
    "          renderTradeResponsePrompt(\n"
    "            this.state,\n"
    "            current.value,\n"
    "            current.from,\n"
    "            path.join(REPO_ROOT, 'pokemon-showdown'),\n"
    "            { mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools },\n"
    "          ),\n",
)
replace_once(
    "src/frozen-circuit-transactions.ts",
    "        ? renderTradeOfferPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'))\n"
    "        : renderFreeAgencyPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'));\n",
    "        ? renderTradeOfferPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'), {\n"
    "            mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,\n"
    "          })\n"
    "        : renderFreeAgencyPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'), {\n"
    "            mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,\n"
    "          });\n",
)
replace_once(
    "docs/strategic-evals.md",
    "Forecast fields are mechanically scored with proper scoring rules and cannot\nincrease action utility.\n",
    "Forecast fields are mechanically scored with proper scoring rules and cannot\n"
    "increase action utility. Connected draft, construction, and transaction prompts\n"
    "also bind the actual mechanics-tool capability. The local harness keeps its\n"
    "interactive Showdown tools; the frozen null-harness circuit explicitly states\n"
    "that no interactive tools are available, and the capability changes the prompt\n"
    "revision.\n",
)
