import type {
  BattleLogEntryView,
  BracketView,
  DraftView,
  PublicBattleMessage,
  PublicBracketView,
  PublicDraftView,
  PublicTeamSheetSetView,
} from './api.js';

function publicTeamSheet(sets: unknown): PublicTeamSheetSetView[] {
  if (!Array.isArray(sets)) return [];
  return sets.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const set = value as Record<string, unknown>;
    if (typeof set.species !== 'string' || !Array.isArray(set.moves)) return [];
    return [
      {
        species: set.species,
        spriteId: typeof set.spriteId === 'string' ? set.spriteId : '',
        item: typeof set.item === 'string' ? set.item : '',
        ability: typeof set.ability === 'string' ? set.ability : '',
        nature: typeof set.nature === 'string' ? set.nature : '',
        moves: set.moves.map(String),
      },
    ];
  });
}

export function buildPublicBattleMessage(
  index: number,
  game: number,
  games: number[],
  revision: number,
  log: BattleLogEntryView[],
): PublicBattleMessage {
  return {
    visibility: 'public',
    index,
    game,
    games,
    revision,
    log: log.map((entry) => ({ turn: entry.turn, kind: entry.kind, text: entry.text })),
  };
}

export function projectPublicDraft(
  draft: DraftView | undefined,
  closedSheets: boolean,
  startedSeries: ReadonlySet<number>,
): PublicDraftView | null {
  if (!draft) return null;
  return {
    boardId: draft.boardId,
    budget: draft.budget,
    picksPerEntrant: draft.picksPerEntrant,
    entrants: [...draft.entrants],
    teamNames: [...draft.teamNames],
    picks: draft.picks.map((pick) => ({ pick: pick.pick, entrant: pick.entrant, mon: pick.mon })),
    rosters: draft.rosters.map((roster) => [...roster]),
    budgets: [...draft.budgets],
    table: draft.table?.map((row) => ({ ...row })) ?? null,
    teambuilds: draft.teambuilds
      .filter((build) => startedSeries.has(build.seriesIndex))
      .map((build) => ({
        seriesIndex: build.seriesIndex,
        entrant: build.entrant,
        opponent: build.opponent,
        brought: [...build.brought],
        ...(closedSheets ? {} : { teamSheet: publicTeamSheet(build.sets) }),
      })),
    week: draft.week,
    weeks: draft.weeks,
    phase: draft.phase,
  };
}

export function projectPublicBracket(
  bracket: BracketView | undefined,
  closedSheets: boolean,
): PublicBracketView | null {
  if (!bracket) return null;
  return {
    entrants: bracket.entrants.map((entrant) => ({
      model: entrant.model,
      team: entrant.team,
      ...(entrant.seed === undefined ? {} : { seed: entrant.seed }),
      ...(entrant.placement === undefined ? {} : { placement: entrant.placement }),
      ...(entrant.player === undefined ? {} : { player: entrant.player }),
      ...(closedSheets || entrant.teamSheet === undefined ? {} : { teamSheet: publicTeamSheet(entrant.teamSheet) }),
    })),
    rounds: bracket.rounds.map((round) =>
      round.map((match) => ({ seriesIndex: match.seriesIndex, slots: [...match.slots], winner: match.winner })),
    ),
    champion: bracket.champion,
  };
}
