import { rankedTable } from './draftleague.js';
import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION } from './frozen-battle-referee.js';
import {
  type AcceptedConstruction,
  type CircuitSeat,
  type CircuitSeriesPlan,
  type DomainDefault,
  FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
  FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
  type FrozenCircuitScenarioId,
  type FrozenCircuitSeatId,
  type FrozenCircuitTerminalEvidence,
  type FrozenCircuitTerminalSummary,
  type PrivateSeriesEvidence,
  type SeatSplit,
  type SeriesSummary,
  type TurnReceipt,
} from './frozen-circuit-model.js';
import { PRE_WINDOW_WEEKS, scenarioDescription } from './frozen-circuit-setup.js';
import type { FrozenCircuitTransactions } from './frozen-circuit-transactions.js';
import { FROZEN_MATCHDAY_FORMAT, FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION } from './frozen-matchday-referee.js';
import type { DraftTableRow } from './gui/api.js';
import { seriesSeedSchedule } from './series.js';

export interface FrozenCircuitEvidenceState {
  scenarioId: FrozenCircuitScenarioId;
  seed: number;
  showdownRevision: string;
  configDigest: string;
  promptRevision: string;
  fixtureDigests: { board: string | null; victoryRoadPool: string | null };
  seats: readonly CircuitSeat[];
  plans: readonly CircuitSeriesPlan[];
  seatPermutation: readonly number[];
  bracket: readonly (readonly import('./tournament.js').BracketMatch[])[];
  table: readonly DraftTableRow[];
  series: readonly SeriesSummary[];
  defaults: readonly DomainDefault[];
  publicReceipts: readonly TurnReceipt[];
  privateReceipts: readonly (TurnReceipt & { response: string })[];
  privateSeries: readonly PrivateSeriesEvidence[];
  notebooks: ReadonlyMap<FrozenCircuitSeatId, string>;
  constructions: ReadonlyMap<string, AcceptedConstruction>;
  transactions: FrozenCircuitTransactions | null;
}

export function buildFrozenCircuitTerminalEvidence(state: FrozenCircuitEvidenceState): FrozenCircuitTerminalEvidence {
  const champion = state.bracket.at(-1)?.[0]?.winner;
  if (champion === null || champion === undefined) throw new Error('terminal bracket has no champion');
  const finalStandings =
    state.scenarioId === 'draft-league-v1'
      ? rankedTable([...state.table]).map((row, index) => ({
          rank: index + 1,
          seatId: state.seats[row.entrant]!.seatId,
          series: {
            wins: row.w,
            draws: 7 - row.w - row.l,
            losses: row.l,
          },
          gameWins: row.gw,
          gameDraws: seatSplit(
            state.series,
            state.seats[row.entrant]!.seatId,
            (series) => series.stage === 'roundrobin',
          ).games.draws,
          gameLosses: row.gl,
        }))
      : null;
  const summary: FrozenCircuitTerminalSummary = {
    protocolVersion: FROZEN_CIRCUIT_REFEREE_PROTOCOL_VERSION,
    promptProtocolVersion: FROZEN_CIRCUIT_PROMPT_PROTOCOL_VERSION,
    matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
    battleProtocolVersion: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
    showdownRevision: state.showdownRevision,
    scenarioId: state.scenarioId,
    format: FROZEN_MATCHDAY_FORMAT,
    configDigest: state.configDigest,
    promptRevision: state.promptRevision,
    fixtureDigests: { ...state.fixtureDigests },
    scenario: scenarioDescription(state.scenarioId),
    championSeatId: state.seats[champion]!.seatId,
    finalStandings,
    bracket: structuredClone(state.bracket.map((round) => [...round])),
    series: structuredClone([...state.series]).sort((left, right) => left.seriesIndex - right.seriesIndex),
    perSeat: state.seats.map((seat) => {
      const selected = (predicate: (series: SeriesSummary) => boolean) =>
        seatSplit(state.series, seat.seatId, predicate);
      const roundRobin = selected((series) => series.stage === 'roundrobin');
      const playoffs = selected((series) => series.stage === 'playoff');
      const topCut = selected((series) => series.stage === 'top-cut');
      return {
        seatId: seat.seatId,
        name: seat.name,
        total: selected(() => true),
        roundRobinPreWindow: selected(
          (series) => series.stage === 'roundrobin' && series.week !== null && series.week <= PRE_WINDOW_WEEKS,
        ),
        roundRobinPostWindow: selected(
          (series) => series.stage === 'roundrobin' && series.week !== null && series.week > PRE_WINDOW_WEEKS,
        ),
        playoffs,
        topCut,
        reward:
          state.scenarioId === 'draft-league-v1'
            ? {
                name: 'draft_league_series_return_v1' as const,
                value:
                  (roundRobin.series.wins - roundRobin.series.losses + playoffs.series.wins - playoffs.series.losses) /
                  9,
              }
            : {
                name: 'tournament_series_return_v1' as const,
                value: (topCut.series.wins - topCut.series.losses) / 3,
              },
        defaults: Object.fromEntries(
          (['draft', 'construction', 'action', 'trade_offer', 'trade_response', 'free_agency'] as const).map((kind) => [
            kind,
            state.defaults.filter((entry) => entry.seatId === seat.seatId && entry.kind === kind).length,
          ]),
        ) as Record<DomainDefault['kind'], number>,
      };
    }),
    transactions: state.scenarioId === 'draft-league-v1' ? (state.transactions?.summary() ?? null) : null,
    defaults: structuredClone([...state.defaults]),
    turnReceipts: structuredClone([...state.publicReceipts]),
  };
  return {
    summary,
    privateEvidence: {
      series: structuredClone([...state.privateSeries]),
      seats: state.seats.map((seat) => ({
        seatId: seat.seatId,
        notebook: state.notebooks.get(seat.seatId)!,
        constructions: [...state.constructions.entries()]
          .filter(([key]) => key.endsWith(`:${seat.seatId}`))
          .map(([key, construction]) => ({
            seriesIndex: Number(key.split(':')[0]),
            construction: structuredClone(construction),
          })),
      })),
      transactionState: state.transactions ? structuredClone(state.transactions.state) : null,
      turnReceipts: structuredClone([...state.privateReceipts]),
      derived: {
        seed: state.seed,
        seatPermutation: [...state.seatPermutation],
        seriesSeeds: state.plans.map((plan) =>
          seriesSeedSchedule(
            plan.gameSeeds.map((value) => [...value]),
            plan.stage !== 'roundrobin',
          ),
        ),
      },
    },
  };
}

function seatSplit(
  series: readonly SeriesSummary[],
  seatId: FrozenCircuitSeatId,
  predicate: (series: SeriesSummary) => boolean,
): SeatSplit {
  const seriesWdl = emptyWdl();
  const games = emptyWdl();
  for (const entry of series) {
    if (!predicate(entry) || (entry.seats.p1 !== seatId && entry.seats.p2 !== seatId)) continue;
    if (entry.winnerSeatId === null) seriesWdl.draws += 1;
    else if (entry.winnerSeatId === seatId) seriesWdl.wins += 1;
    else seriesWdl.losses += 1;
    for (const game of entry.games) {
      if (game.result.type === 'tie') games.draws += 1;
      else if (game.result.winnerSeatId === seatId) games.wins += 1;
      else games.losses += 1;
    }
  }
  return { series: seriesWdl, games };
}

function emptyWdl() {
  return { wins: 0, draws: 0, losses: 0 };
}
