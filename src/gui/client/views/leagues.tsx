import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  BoardInfo,
  LeagueCardView,
  LeagueFranchiseView,
  LeagueResponse,
  LeagueSeriesView,
  LeaguesResponse,
  LeagueTeambuildView,
} from '../../api';
import { BoardBrowser, type DraftRecord, STAT_ORDER, useBoard } from '../components/boardbrowser';
import { StatTile } from '../components/chartkit';
import { Mark } from '../components/mark';
import { MatchGame, useMatchGame } from '../components/matchgame';
import { MatchMenu, MatchMenuRow } from '../components/matchmenu';
import { SetCard } from '../components/setcard';
import { Sprite } from '../components/sprite';
import { api, apiFresh } from '../http';
import { displaySpec, modelName, when } from '../lib/labels';

/** Franchise names are display flavor; the model identity is never hidden behind them. */
function franchiseLabel(league: LeagueResponse, entrant: number): string {
  const franchise = league.franchises[entrant];
  if (!franchise) return `Coach ${entrant + 1}`;
  return franchise.teamName || modelName(franchise.model);
}

export function teamSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'team'
  );
}

function tokensLabel(tokens: number | null): string {
  if (tokens === null) return '–';
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  return tokens.toLocaleString();
}

const PHASE_LABELS = {
  drafting: 'Drafting',
  building: 'Teambuilding',
  roundrobin: 'Round robin',
  window: 'Free agency',
  playoffs: 'Playoffs',
  complete: 'Complete',
} as const;

function phaseLabel(
  card: Pick<LeagueCardView, 'phase' | 'week' | 'weeks'> & { picks?: number | null; draftOnly?: boolean },
): string {
  if (card.draftOnly && card.phase === 'complete') return 'Draft only';
  if (card.phase === 'drafting' && typeof card.picks === 'number' && card.picks > 0) {
    return `Drafting · pick ${card.picks}`;
  }
  if (card.phase === 'roundrobin' && card.week > 0) {
    return `Round robin · week ${card.week}${card.weeks ? ` of ${card.weeks}` : ''}`;
  }
  if (card.phase === 'window') return `Free agency · after week ${card.week}`;
  return PHASE_LABELS[card.phase];
}

function pickLabel(pick: number): string {
  return `Pick ${pick}`;
}

function LeagueCard({ card, onOpen }: { card: LeagueCardView; onOpen: () => void }) {
  return (
    <button type="button" class="league-card panel" onClick={onOpen}>
      <div class="league-card-top">
        <span class="eyebrow">
          {when(card.when)}
          {card.board ? ` · ${card.board}` : ''}
        </span>
        <span class={`phase-pill ${card.phase}`}>
          {card.live ? <span class="live-dot" role="img" aria-label="live" /> : null}
          {phaseLabel(card)}
        </span>
      </div>
      {card.champion ? (
        <div class="league-card-champion">
          <Mark spec={card.champion.model} size={22} />
          <div>
            <b>{card.champion.team}</b>
            <small>{displaySpec(card.champion.model)}</small>
          </div>
          <span class="league-card-title">Champion</span>
        </div>
      ) : (
        <div class="league-card-champion open">
          <b>{card.draftOnly ? 'Rosters drafted, no games played' : 'Season in progress'}</b>
        </div>
      )}
      <ul class="league-card-coaches">
        {card.teamNames.map((name, entrant) => (
          <li key={name}>
            <Mark spec={card.entrants[entrant] ?? ''} size={13} />
            <span>{name}</span>
          </li>
        ))}
      </ul>
      <span class="league-card-meta">
        {card.entrants.length} coaches ·{' '}
        {card.draftOnly
          ? 'draft only'
          : `${card.seriesCount} series recorded · ${
              card.tradeWindowAfterWeek === null
                ? 'locked rosters'
                : `trade window after week ${card.tradeWindowAfterWeek}`
            }`}
      </span>
    </button>
  );
}

function LeagueArchivePending() {
  return (
    <div class="league-card-grid league-card-grid-pending" aria-busy="true">
      <p class="archive-loading-status" role="status">
        Loading draft league archive…
      </p>
      {Array.from({ length: 6 }, (_, index) => (
        <div class="league-card panel league-card-placeholder" aria-hidden="true" key={index}>
          <span class="placeholder-line placeholder-line-short" />
          <span class="placeholder-line placeholder-line-title" />
          <span class="placeholder-line" />
          <span class="placeholder-line placeholder-line-medium" />
        </div>
      ))}
    </div>
  );
}

function DraftBoardsPending() {
  return (
    <div class="board-snapshot board-snapshot-placeholder" role="status" aria-busy="true">
      Loading draft boards…
    </div>
  );
}

function FranchiseCard({
  franchise,
  spriteFor,
  onOpenTeam,
}: {
  franchise: LeagueFranchiseView;
  spriteFor: (id: string) => string;
  onOpenTeam: () => void;
}) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const slot = franchise.roster.find((entry) => entry.id === openSlot);
  return (
    <article class="franchise-card panel">
      <header class="franchise-card-head">
        <div>
          <b>{franchise.teamName}</b>
          <span class="model-fact">
            <Mark spec={franchise.model} size={14} />
            <span>{displaySpec(franchise.model)}</span>
          </span>
        </div>
        <div class="franchise-card-record">
          <b>
            {franchise.overallRecord.w}-{franchise.overallRecord.l}
          </b>
          <small>
            games {franchise.overallRecord.gw}-{franchise.overallRecord.gl}
          </small>
        </div>
      </header>
      {franchise.finish ? <span class="franchise-finish">{franchise.finish}</span> : null}
      <div class="franchise-sprites">
        {franchise.roster.map((entry) => (
          <button
            key={entry.id}
            type="button"
            class={`franchise-sprite ${openSlot === entry.id ? 'on' : ''}`}
            title={`${entry.name} · ${entry.cost} pts${entry.acquired === 'window' ? ' · mid-season trade' : entry.pick !== null ? ` · pick ${entry.pick}` : ''}`}
            onClick={() => setOpenSlot(openSlot === entry.id ? null : entry.id)}
          >
            <Sprite id={spriteFor(entry.id)} size={40} />
          </button>
        ))}
      </div>
      {slot ? (
        <div class="franchise-pick">
          <span class="draft-feed-head">
            {slot.acquired === 'window'
              ? 'Mid-season trade · '
              : slot.pick !== null
                ? `${pickLabel(slot.pick)} · `
                : ''}
            {slot.name} · {slot.cost} pts{slot.fallback ? ' · fallback' : ''}
          </span>
          {slot.acquired === 'window' ? (
            <p>
              Signed in free agency. One rationale covers every swap this coach made —{' '}
              <button type="button" class="text-link" onClick={onOpenTeam}>
                read it on the team page →
              </button>
            </p>
          ) : (
            <p>{slot.rationale || 'No stored rationale.'}</p>
          )}
        </div>
      ) : null}
      <footer class="franchise-card-foot">
        <span class="muted">
          {franchise.spent}/{franchise.spent + franchise.budgetLeft} points spent
        </span>
        <button type="button" class="text-link" onClick={onOpenTeam}>
          Team page →
        </button>
      </footer>
    </article>
  );
}

function seriesLabel(series: Pick<LeagueSeriesView, 'stage' | 'round'>, playoffRounds: number): string {
  if (series.stage === 'roundrobin') return `Week ${series.round}`;
  return series.round === playoffRounds && playoffRounds > 1 ? 'Final' : playoffRounds > 1 ? 'Semifinal' : 'Final';
}

function ScheduleTable({
  league,
  onOpenTeam,
  onOpenGame,
}: {
  league: LeagueResponse;
  onOpenTeam: (entrant: number, seriesIndex?: number) => void;
  onOpenGame: (seriesIndex: number, game: number) => void;
}) {
  const name = (entrant: number) => franchiseLabel(league, entrant);
  return (
    <div class="table-scroll">
      <table class="data-table schedule-table">
        <thead>
          <tr>
            <th>Round</th>
            <th>Matchup</th>
            <th class="num">Score</th>
            <th>Games</th>
            <th class="num">Turns</th>
          </tr>
        </thead>
        <tbody>
          {league.series.map((series) => (
            <tr key={series.seriesIndex}>
              <td class="muted">{seriesLabel(series, league.playoffRounds)}</td>
              <td class="matchup">
                {series.sides.map((entrant, index) => (
                  <span key={entrant}>
                    {index > 0 ? <span class="muted"> vs </span> : null}
                    <button
                      type="button"
                      class={`text-link ${series.winner === entrant ? 'winner' : ''}`}
                      title={`Open ${name(entrant)} at this series`}
                      onClick={() => onOpenTeam(entrant, series.seriesIndex)}
                    >
                      {name(entrant)}
                    </button>
                  </span>
                ))}
              </td>
              <td class="num">
                {series.score[0]}–{series.score[1]}
              </td>
              <td>
                <span class="game-chips">
                  {series.games.map((game, index) => (
                    <button
                      key={index}
                      type="button"
                      class={`game-chip ${game.winner === series.sides[0] ? 'left' : game.winner === series.sides[1] ? 'right' : ''}`}
                      title={`Open game ${index + 1}: ${game.winner === null ? 'no winner' : `${name(game.winner)} in ${game.turns} turns`}`}
                      onClick={() => onOpenGame(series.seriesIndex, index + 1)}
                    >
                      {game.winner === null ? '·' : name(game.winner).slice(0, 1)}
                    </button>
                  ))}
                </span>
              </td>
              <td class="num">{series.turns}</td>
            </tr>
          ))}
          {league.liveSeries.map((series) =>
            series.sides ? (
              <tr class="live-schedule-row" key={`live:${series.seriesId}`}>
                <td>
                  <span class="live-status">
                    <span class="live-dot" aria-hidden="true" />
                    {series.stage && series.round
                      ? `${seriesLabel({ stage: series.stage, round: series.round }, league.playoffRounds)} · Live`
                      : 'Live'}
                  </span>
                </td>
                <td class="matchup">
                  {series.sides.map((entrant, index) => (
                    <span key={entrant}>
                      {index > 0 ? <span class="muted"> vs </span> : null}
                      <button type="button" class="text-link" onClick={() => onOpenTeam(entrant)}>
                        {name(entrant)}
                      </button>
                    </span>
                  ))}
                </td>
                <td class="num">–</td>
                <td>
                  {series.seriesIndex === null ? (
                    `Game ${series.game}`
                  ) : (
                    <button
                      type="button"
                      class="game-chip live"
                      title={`Watch game ${series.game}`}
                      onClick={() => onOpenGame(series.seriesIndex!, series.game)}
                    >
                      {series.game}
                    </button>
                  )}
                </td>
                <td class="num">{series.turn > 0 ? `T${series.turn}` : 'Preview'}</td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </div>
  );
}

function GamePage({
  league,
  seriesIndex,
  game,
  onOpenGame,
  onOpenTeam,
  onBack,
}: {
  league: LeagueResponse;
  seriesIndex: number;
  game: number;
  onOpenGame: (seriesIndex: number, game: number) => void;
  onOpenTeam: (entrant: number) => void;
  onBack: () => void;
}) {
  const path = `/api/league/game?run=${encodeURIComponent(league.runId)}&series=${seriesIndex}&game=${game}`;
  const { view, error } = useMatchGame(path, 10_000);
  const series = league.series.find((entry) => entry.seriesIndex === seriesIndex);
  if (error)
    return (
      <div>
        <h1>League game unavailable</h1>
        <div class="message error">Could not load this game: {error}</div>
      </div>
    );
  if (!view)
    return (
      <div>
        <h1>League game</h1>
        <p class="muted">Loading the game…</p>
      </div>
    );

  const firstModel = league.franchises[view.sides[0]]?.model;
  const secondModel = league.franchises[view.sides[1]]?.model;
  const players: [string, string] = [firstModel ?? view.teamNames[0], secondModel ?? view.teamNames[1]];
  const details: [string, string] | undefined =
    firstModel && secondModel ? [displaySpec(firstModel), displaySpec(secondModel)] : undefined;
  const teams = ([0, 1] as const).map((side) => {
    const build = league.teambuilds.find(
      (entry) => entry.seriesIndex === seriesIndex && entry.entrant === view.sides[side],
    );
    if (!build) return undefined;
    return build.sets;
  });

  return (
    <MatchGame
      view={view}
      eyebrow={
        <>
          <button type="button" class="text-link" onClick={onBack}>
            ← {league.board ?? 'League'} · {when(league.when)}
          </button>{' '}
          / {seriesLabel(series ?? view, league.playoffRounds)}
        </>
      }
      titles={view.teamNames}
      players={players}
      {...(details ? { details } : {})}
      teams={teams as [(typeof teams)[number], (typeof teams)[number]]}
      onOpenGame={(number) => onOpenGame(seriesIndex, number)}
      actions={view.sides.map((entrant) => (
        <button key={entrant} type="button" class="text-link" onClick={() => onOpenTeam(entrant)}>
          {franchiseLabel(league, entrant)} →
        </button>
      ))}
    />
  );
}

function setDiff(previous: LeagueTeambuildView | undefined, build: LeagueTeambuildView): string[] {
  if (!previous) return [];
  const lines: string[] = [];
  const bySpecies = (entry: LeagueTeambuildView) => new Map(entry.sets.map((set) => [set.species, set] as const));
  const before = bySpecies(previous);
  const after = bySpecies(build);
  const dropped = [...before.keys()].filter((species) => !after.has(species));
  const added = [...after.keys()].filter((species) => !before.has(species));
  if (added.length || dropped.length) {
    lines.push(
      [added.length ? `brought in ${added.join(', ')}` : '', dropped.length ? `benched ${dropped.join(', ')}` : '']
        .filter(Boolean)
        .join('; '),
    );
  }
  for (const [species, set] of after) {
    const old = before.get(species);
    if (!old) continue;
    const changes: string[] = [];
    if (old.item !== set.item) changes.push(`item ${old.item || 'none'} → ${set.item || 'none'}`);
    if (old.ability !== set.ability) changes.push(`ability ${old.ability} → ${set.ability}`);
    if (old.nature !== set.nature) changes.push(`nature ${old.nature} → ${set.nature}`);
    const oldMoves = new Set(old.moves);
    const newMoves = set.moves.filter((move) => !oldMoves.has(move));
    const cut = old.moves.filter((move) => !set.moves.includes(move));
    if (newMoves.length || cut.length) changes.push(`moves ${cut.join(', ') || '–'} → ${newMoves.join(', ') || '–'}`);
    if (STAT_ORDER.some((stat) => (old.evs[stat] ?? 0) !== (set.evs[stat] ?? 0))) changes.push('new stat spread');
    if (changes.length) lines.push(`${species}: ${changes.join(' · ')}`);
  }
  return lines;
}

function rate(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–';
}

function TeamStats({ franchise, seriesPlayed }: { franchise: LeagueFranchiseView; seriesPlayed: number }) {
  const stats = franchise.stats;
  const selections = stats.moveSelections + stats.switchSelections;
  const rows: Array<[string, string]> = [
    ['Switch rate', rate(stats.switchSelections, selections)],
    ['Protect rate', rate(stats.protectSelections, selections)],
    ['Consecutive Protects', String(stats.consecutiveProtects)],
    ['Spread-move share', rate(stats.spreadSelections, stats.moveSelections)],
    ['Mega activations', String(stats.megaSelections)],
    ['Dex lookups per decision', stats.decisions > 0 ? (stats.toolLookups / stats.decisions).toFixed(1) : '–'],
    ['Parse failures', String(stats.parseFailures)],
    ['Fallback decisions', String(stats.fallbacks)],
    ['Build attempts per series', seriesPlayed > 0 ? (stats.buildAttempts / seriesPlayed).toFixed(1) : '–'],
    ['Lead changes between games', String(stats.leadChanges)],
    ['Bring changes between games', String(stats.bringChanges)],
  ];
  return (
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Season stats</h2>
          <p>How this coach actually played across the whole league, from the decision logs.</p>
        </div>
      </div>
      <div class="stat-row">
        <StatTile label="Decisions" value={stats.decisions.toLocaleString()} note="battle decisions made" />
        <StatTile
          label="Median decision"
          value={stats.latency ? `${Math.round(stats.latency.median / 1000)}s` : '–'}
          note={
            stats.latency
              ? `p75 ${Math.round(stats.latency.p75 / 1000)}s · max ${Math.round(stats.latency.max / 1000)}s`
              : 'no latency recorded'
          }
        />
        <StatTile
          label="Reasoning"
          value={stats.reasoningTokens !== null ? tokensLabel(stats.reasoningTokens) : '–'}
          note="reasoning tokens spent"
        />
        <StatTile
          label="Cost"
          value={stats.cost !== null ? `$${stats.cost.toFixed(2)}` : '–'}
          note={stats.cost !== null ? 'metered by the provider' : 'not metered for this seat'}
        />
      </div>
      <div class="team-rates">
        {rows.map(([label, value]) => (
          <span key={label}>
            {label} <b>{value}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

function LiveSeriesFeed({
  league,
  entries,
  onOpenTeam,
  onOpenGame,
}: {
  league: LeagueResponse;
  entries: LeagueResponse['liveSeries'];
  onOpenTeam: (entrant: number) => void;
  onOpenGame: (seriesIndex: number, game: number) => void;
}) {
  return (
    <MatchMenu count={entries.length}>
      {entries.map((entry) => (
        <MatchMenuRow
          key={entry.seriesId}
          eyebrow={
            entry.stage === null || entry.round === null
              ? `Series ${entry.seriesId.slice(0, 6)}…`
              : seriesLabel({ stage: entry.stage, round: entry.round }, league.playoffRounds)
          }
          sides={
            entry.sides
              ? ([0, 1] as const).map((side) => (
                  <span class="match-menu-side" key={side}>
                    {side === 1 && <i>vs</i>}
                    <button type="button" class="text-link" onClick={() => onOpenTeam(entry.sides![side])}>
                      {league.franchises[entry.sides![side]]?.teamName ?? '?'}
                    </button>
                  </span>
                ))
              : 'Matchup forming'
          }
          state={
            <>
              Game {entry.game} · {entry.turn > 0 ? `Turn ${entry.turn}` : 'Team preview'} · {entry.decisions} decisions
            </>
          }
          onWatch={entry.seriesIndex === null ? undefined : () => onOpenGame(entry.seriesIndex!, entry.game)}
        />
      ))}
    </MatchMenu>
  );
}

function TeamPage({
  league,
  franchise,
  spriteFor,
  focusSeries,
  onBack,
  onOpenGame,
  onOpenTeam,
}: {
  league: LeagueResponse;
  franchise: LeagueFranchiseView;
  spriteFor: (id: string) => string;
  focusSeries: number | undefined;
  onBack: () => void;
  onOpenGame: (seriesIndex: number, game: number) => void;
  onOpenTeam: (entrant: number) => void;
}) {
  const focused = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    focused.current?.scrollIntoView({ block: 'center' });
  }, [focusSeries]);
  const builds = league.teambuilds
    .filter((build) => build.entrant === franchise.entrant)
    .sort((a, b) => a.seriesIndex - b.seriesIndex);
  const bySeries = new Map(league.series.map((series) => [series.seriesIndex, series] as const));
  const picks = [...franchise.draftRoster].sort((a, b) => (a.pick ?? 99) - (b.pick ?? 99));
  const name = (entrant: number) => franchiseLabel(league, entrant);
  const liveSeries = league.liveSeries.filter((entry) => entry.sides?.includes(franchise.entrant));
  const windowDecision = league.tradeWindow?.decisions.find((entry) => entry.entrant === franchise.entrant);
  const tradeOffers = (league.tradeWindow?.offers ?? []).filter(
    (entry) => entry.from === franchise.entrant || entry.to === franchise.entrant,
  );
  const seasonReview = league.seasonReviews?.find((entry) => entry.entrant === franchise.entrant);
  const rosterNames = new Map(
    league.franchises.flatMap((entry) =>
      [...entry.draftRoster, ...entry.roster].map((mon) => [mon.id, mon.name] as const),
    ),
  );
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← {league.board ?? 'League'} · {when(league.when)}
            </button>
          </p>
          <h1>{franchise.teamName}.</h1>
        </div>
        <div class="lede team-lede">
          <span class="model-fact">
            <Mark spec={franchise.model} size={16} />
            <span>{displaySpec(franchise.model)}</span>
          </span>
          <span>
            {franchise.overallRecord.w}-{franchise.overallRecord.l} in series, {franchise.overallRecord.gw}-
            {franchise.overallRecord.gl} in games · regular season {franchise.roundRobinRecord.w}-
            {franchise.roundRobinRecord.l}
            {franchise.finish ? ` · ${franchise.finish.toLowerCase()}` : ''}
          </span>
        </div>
      </header>

      {liveSeries.length > 0 ? (
        <section class="panel live-now team-live">
          <div class="section-head">
            <div>
              <p class="eyebrow">
                <span class="live-dot" aria-hidden="true" /> Live now
              </p>
              <h2>Match in progress</h2>
              <p>Watch this franchise's current battle.</p>
            </div>
          </div>
          <LiveSeriesFeed league={league} entries={liveSeries} onOpenTeam={onOpenTeam} onOpenGame={onOpenGame} />
        </section>
      ) : null}
      <TeamStats franchise={franchise} seriesPlayed={franchise.overallRecord.w + franchise.overallRecord.l} />

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>The draft</h2>
            <p>
              Every pick in draft order, with the recorded reasoning. {franchise.spent} of{' '}
              {franchise.spent + franchise.budgetLeft} points spent.
            </p>
          </div>
        </div>
        <div class="draft-feed">
          {picks.map((entry) => (
            <div class="draft-feed-item" key={entry.id}>
              <span class="draft-feed-head">
                <Sprite id={spriteFor(entry.id)} size={24} />
                {entry.pick !== null ? `${pickLabel(entry.pick)} · ` : ''}
                {entry.name} · {entry.cost} pts
                {entry.fallback ? ' · fallback' : ''}
              </span>
              <p>{entry.rationale || 'No stored rationale.'}</p>
            </div>
          ))}
          {picks.length === 0 ? <p class="muted">No stored draft for this roster.</p> : null}
        </div>
      </section>
      {league.tradeWindow ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Mid-season trade window</h2>
              <p>
                After week {league.tradeWindow.afterWeek}, the lowest seed chose first. Coach offers resolved before up
                to six swaps from the undrafted pool.
              </p>
            </div>
          </div>
          <div class="draft-feed">
            {tradeOffers.map((offer, index) => (
              <div class="draft-feed-item" key={`${offer.from}:${offer.to}:${offer.give}:${offer.get}:${index}`}>
                <span class="draft-feed-head">
                  {offer.to === null
                    ? `${name(offer.from)} made no trade offer`
                    : `${name(offer.from)} offered ${rosterNames.get(offer.give ?? '') ?? offer.give} for ${
                        rosterNames.get(offer.get ?? '') ?? offer.get
                      } from ${name(offer.to)} · ${offer.accepted ? 'accepted' : 'declined'}`}
                </span>
                {offer.message ? <p>“{offer.message}”</p> : null}
                {offer.offerReasoning ? <p>Offer reasoning: {offer.offerReasoning}</p> : null}
                {offer.responseReasoning ? <p>Response reasoning: {offer.responseReasoning}</p> : null}
              </div>
            ))}
            {windowDecision ? (
              <>
                <div class="draft-feed-item">
                  <span class="draft-feed-head">
                    {windowDecision.swaps.length
                      ? `${windowDecision.swaps.length} roster swap${windowDecision.swaps.length === 1 ? '' : 's'}`
                      : 'Roster kept'}
                    {windowDecision.fallback ? ' · fallback' : ''}
                  </span>
                  <p>{windowDecision.reasoning || 'No stored rationale.'}</p>
                  {windowDecision.swaps.length ? (
                    <ul class="build-changes">
                      {windowDecision.swaps.map((swap) => (
                        <li key={`${swap.drop}:${swap.add}`}>
                          Dropped {rosterNames.get(swap.drop) ?? swap.drop} · added{' '}
                          {rosterNames.get(swap.add) ?? swap.add}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div class="draft-feed-item">
                  <span class="draft-feed-head">Post-window roster · {franchise.spent} pts</span>
                  <p>{franchise.roster.map((mon) => mon.name).join(', ')}</p>
                </div>
              </>
            ) : (
              <p class="muted">
                {league.tradeWindow.complete ? 'No stored free-agency decision.' : 'This coach has not chosen yet.'}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {seasonReview ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Season review</h2>
              <p>
                Written by the coach once its own season was over, with its draft, its free-agency window, and every
                series in front of it.{seasonReview.fallback ? ' No usable review was returned.' : ''}
              </p>
            </div>
          </div>
          <div class="draft-feed">
            <div class="draft-feed-item">
              <span class="draft-feed-head">{seasonReview.outcome}</span>
              <p>{seasonReview.summary}</p>
            </div>
            <div class="draft-feed-item">
              <span class="draft-feed-head">What went well</span>
              <p>{seasonReview.didWell}</p>
            </div>
            <div class="draft-feed-item">
              <span class="draft-feed-head">What went poorly</span>
              <p>{seasonReview.didPoorly}</p>
            </div>
            <div class="draft-feed-item">
              <span class="draft-feed-head">What it would change</span>
              <p>{seasonReview.wouldChange}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Series by series</h2>
            <p>The six brought to each matchup, the sets built for it, and what changed between series.</p>
          </div>
        </div>
        <div class="teambuild-list">
          {builds.map((build, index) => {
            const series = bySeries.get(build.seriesIndex);
            const live = league.liveSeries.find((entry) => entry.seriesIndex === build.seriesIndex);
            const changes = setDiff(builds[index - 1], build);
            const won = series?.winner === franchise.entrant;
            return (
              <details
                class={`teambuild-card ${build.seriesIndex === focusSeries ? 'focused' : ''}`}
                key={build.seriesIndex}
                ref={(node: HTMLDetailsElement | null) => {
                  if (build.seriesIndex === focusSeries) focused.current = node;
                }}
                open={focusSeries === undefined ? index === builds.length - 1 : build.seriesIndex === focusSeries}
              >
                <summary>
                  <b>vs {name(build.opponent)}</b>
                  {series ? (
                    <span class={`series-result ${won ? 'won' : series.winner === null ? '' : 'lost'}`}>
                      {won ? 'won' : series.winner === null ? 'unresolved' : 'lost'}{' '}
                      {series.sides[0] === franchise.entrant
                        ? `${series.score[0]}–${series.score[1]}`
                        : `${series.score[1]}–${series.score[0]}`}
                    </span>
                  ) : live ? (
                    <span class="series-result live">in progress</span>
                  ) : null}
                  <span class="muted">
                    {' '}
                    · {build.attempts} build attempt{build.attempts === 1 ? '' : 's'}
                  </span>
                  {series ? (
                    <span class="game-chips">
                      {series.games.map((entry, gameIndex) => (
                        <button
                          key={gameIndex}
                          type="button"
                          class={`game-chip ${entry.winner === series.sides[0] ? 'left' : entry.winner === series.sides[1] ? 'right' : ''}`}
                          title={`Open game ${gameIndex + 1}`}
                          onClick={(event) => {
                            event.preventDefault();
                            onOpenGame(series.seriesIndex, gameIndex + 1);
                          }}
                        >
                          {gameIndex + 1}
                        </button>
                      ))}
                    </span>
                  ) : live?.seriesIndex !== null && live?.seriesIndex !== undefined ? (
                    <span class="game-chips">
                      <button
                        type="button"
                        class="game-chip live"
                        title={`Watch game ${live.game}`}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpenGame(live.seriesIndex!, live.game);
                        }}
                      >
                        {live.game}
                      </button>
                    </span>
                  ) : null}
                </summary>
                {changes.length > 0 && (
                  <ul class="build-changes">
                    {changes.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <p class="teambuild-plan">{build.rationale}</p>
                <div class="teambuild-sets">
                  {build.sets.map((set) => (
                    <SetCard set={set} key={set.species} />
                  ))}
                </div>
              </details>
            );
          })}
          {builds.length === 0 ? <p class="muted">No stored teambuilds for this franchise.</p> : null}
        </div>
      </section>
    </div>
  );
}

function LiveNow({
  league,
  onOpenTeam,
  onOpenGame,
}: {
  league: LeagueResponse;
  onOpenTeam: (entrant: number) => void;
  onOpenGame: (seriesIndex: number, game: number) => void;
}) {
  const recentPicks = useMemo(() => {
    const picks: Array<{ pick: number; team: string; entrant: number; name: string; cost: number }> = [];
    for (const franchise of league.franchises) {
      for (const slot of franchise.roster) {
        if (slot.pick !== null)
          picks.push({
            pick: slot.pick,
            team: franchise.teamName,
            entrant: franchise.entrant,
            name: slot.name,
            cost: slot.cost,
          });
      }
    }
    return picks.sort((a, b) => b.pick - a.pick).slice(0, 6);
  }, [league]);
  return (
    <section class="panel live-now">
      <div class="section-head">
        <div>
          <p class="eyebrow">
            <span class="live-dot" aria-hidden="true" /> Live
          </p>
          <h2>{phaseLabel(league)}</h2>
          <p>This page refreshes itself while the run is playing.</p>
        </div>
      </div>
      {league.phase === 'drafting' ? (
        <ul class="live-feed">
          {recentPicks.map((entry) => (
            <li key={`${entry.pick}`}>
              <b>{pickLabel(entry.pick)}</b> · {entry.team} takes {entry.name} ({entry.cost} pts)
            </li>
          ))}
          {recentPicks.length === 0 ? <li>Waiting for the first pick…</li> : null}
        </ul>
      ) : null}
      {league.phase === 'building' ? (
        <p class="live-note">
          {league.teambuilds.length} matchup {league.teambuilds.length === 1 ? 'team' : 'teams'} built so far. Series
          begin when both sides of a matchup are ready.
        </p>
      ) : null}
      {league.liveSeries.length > 0 ? (
        <LiveSeriesFeed league={league} entries={league.liveSeries} onOpenTeam={onOpenTeam} onOpenGame={onOpenGame} />
      ) : league.phase === 'roundrobin' || league.phase === 'playoffs' ? (
        <p class="live-note">Between series · waiting for the next matchup to begin.</p>
      ) : null}
    </section>
  );
}

function LeaguePage({
  league,
  team,
  series,
  onOpenTeam,
  onBack,
}: {
  league: LeagueResponse;
  team: string | undefined;
  series: number | undefined;
  onOpenTeam: (slug: string, series?: number) => void;
  onBack: () => void;
}) {
  const { board } = useBoard(league.board ?? '');
  const byId = useMemo(() => new Map((board?.mons ?? []).map((mon) => [mon.id, mon] as const)), [board]);
  const spriteFor = (id: string) => byId.get(id)?.spriteId ?? id;
  const owners = useMemo(() => {
    const map = new Map<string, number>();
    for (const franchise of league.franchises) {
      for (const entry of franchise.roster) map.set(entry.id, franchise.entrant);
    }
    return map;
  }, [league]);
  /** Pick order is the draft's shape, not the post-window roster's, so the numbers come from the drafted
   * ten — otherwise a Pokémon released at free agency reads as one that was never picked at all. */
  const pickNumbers = useMemo(() => {
    const map = new Map<string, DraftRecord>();
    for (const franchise of league.franchises) {
      for (const entry of [...franchise.draftRoster, ...franchise.roster]) {
        if (entry.pick !== null) map.set(entry.id, { pick: entry.pick, entrant: franchise.entrant });
      }
    }
    return map;
  }, [league]);

  const openGame = (seriesIndex: number, game: number) => onOpenTeam(`game-${seriesIndex}-${game}`);
  const openEntrant = (entrant: number, seriesIndex?: number) => {
    const franchise = league.franchises[entrant];
    if (franchise) onOpenTeam(teamSlug(franchise.teamName), seriesIndex);
  };
  const gameRoute = team ? /^game-(\d+)-(\d+)$/.exec(team) : null;
  if (gameRoute) {
    return (
      <GamePage
        league={league}
        seriesIndex={Number(gameRoute[1])}
        game={Number(gameRoute[2])}
        onOpenGame={openGame}
        onOpenTeam={openEntrant}
        onBack={onBack}
      />
    );
  }

  const selected = league.franchises.find((franchise) => teamSlug(franchise.teamName) === team);
  if (selected) {
    return (
      <TeamPage
        league={league}
        franchise={selected}
        spriteFor={spriteFor}
        focusSeries={series}
        onBack={onBack}
        onOpenGame={openGame}
        onOpenTeam={openEntrant}
      />
    );
  }

  const franchises = [...league.franchises].sort(
    (a, b) =>
      Number(b.entrant === league.champion?.entrant) - Number(a.entrant === league.champion?.entrant) ||
      b.roundRobinRecord.w - a.roundRobinRecord.w ||
      b.roundRobinRecord.gw - b.roundRobinRecord.gl - (a.roundRobinRecord.gw - a.roundRobinRecord.gl),
  );
  const fielded = league.usage.filter((entry) => entry.gamesFielded > 0);
  const benched = league.usage.filter((entry) => entry.builds === 0);
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← Draft leagues
            </button>{' '}
            / {when(league.when)}
          </p>
          <h1>{league.board ?? 'Draft league'}.</h1>
        </div>
        <p class="lede">
          {league.franchises.length} coaches, {league.picksPerEntrant ?? '–'} picks from a {league.budget ?? '–'}-point
          budget{league.format ? `, ${league.format}` : ''}.{' '}
          {league.draftOnly
            ? 'The draft is the whole run: no games were played.'
            : league.tradeWindow
              ? `Free agency opened after week ${league.tradeWindow.afterWeek}.`
              : 'Rosters stayed locked after the draft.'}
        </p>
      </header>

      {league.live ? <LiveNow league={league} onOpenTeam={openEntrant} onOpenGame={openGame} /> : null}

      <div class="stat-row">
        <StatTile
          label={league.champion ? 'Champion' : 'Stage'}
          value={league.champion ? league.champion.team : phaseLabel(league)}
          note={league.champion ? displaySpec(league.champion.model) : `${league.series.length} series recorded`}
        />
        <StatTile
          label="Series"
          value={String(league.series.length)}
          note={`${league.series.reduce((total, entry) => total + entry.games.length, 0)} games`}
        />
        <StatTile label="Decisions" value={league.spend.decisions.toLocaleString()} note="model decisions logged" />
        <StatTile
          label="Spend"
          value={
            league.spend.cost !== null
              ? `$${league.spend.cost.toFixed(2)}`
              : `${tokensLabel(league.spend.tokens)} tokens`
          }
          note={
            league.spend.cost !== null
              ? `${tokensLabel(league.spend.tokens)} tokens`
              : 'API cost was not recorded for this run'
          }
        />
      </div>

      <div class="franchise-card-grid">
        {franchises.map((franchise) => (
          <FranchiseCard
            key={franchise.entrant}
            franchise={franchise}
            spriteFor={spriteFor}
            onOpenTeam={() => onOpenTeam(teamSlug(franchise.teamName))}
          />
        ))}
      </div>

      <div class="results-grid">
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Draft impact</h2>
              <p>
                What each pick actually did: games it was fielded in (replayed from the logs), its game record, and how
                often it went down.
              </p>
            </div>
          </div>
          <div class="usage-strip">
            <span>
              <b>{league.distribution.speciesFielded}</b> of {league.distribution.speciesDrafted} picks saw battle
            </span>
            <span>
              <b>{league.distribution.speciesBuilt}</b> made a six
            </span>
            <span>
              <b>{league.distribution.itemsUsed}</b> distinct items
            </span>
            {league.distribution.topItems[0] ? (
              <span>
                top item <b>{league.distribution.topItems[0].item}</b> ×{league.distribution.topItems[0].count}
              </span>
            ) : null}
          </div>
          <div class="table-scroll usage-scroll">
            <table class="data-table usage-table">
              <thead>
                <tr>
                  <th>Pokémon</th>
                  <th>Franchise</th>
                  <th class="num">Cost</th>
                  <th class="num">Built</th>
                  <th class="num">Games</th>
                  <th class="num">W-L</th>
                  <th class="num">Faints</th>
                </tr>
              </thead>
              <tbody>
                {fielded.map((entry) => {
                  const franchise = league.franchises.find((item) => item.entrant === entry.entrant);
                  return (
                    <tr key={`${entry.entrant}:${entry.id}`}>
                      <td>
                        <span class="usage-mon">
                          <Sprite id={spriteFor(entry.id)} size={26} />
                          <b>{entry.name}</b>
                        </span>
                      </td>
                      <td>
                        {franchise ? (
                          <button
                            type="button"
                            class="text-link"
                            onClick={() => onOpenTeam(teamSlug(franchise.teamName))}
                          >
                            {franchise.teamName}
                          </button>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td class="num">{entry.cost || '–'}</td>
                      <td class="num">{entry.builds}</td>
                      <td class="num">{entry.gamesFielded}</td>
                      <td class="num">
                        {entry.gameWins}-{entry.gameLosses}
                      </td>
                      <td class="num">{entry.faints}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {benched.length > 0 ? (
            <p class="usage-bench">Never built for a matchup: {benched.map((entry) => entry.name).join(', ')}.</p>
          ) : null}
        </section>
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Schedule &amp; results</h2>
              <p>Every series with game winners and turn counts.</p>
            </div>
          </div>
          <ScheduleTable league={league} onOpenTeam={openEntrant} onOpenGame={openGame} />
        </section>
      </div>

      {board ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>The board</h2>
              <p>Every draftable entry, with pick numbers for the drafted ones.</p>
            </div>
          </div>
          <BoardBrowser
            board={board.mons}
            owners={owners}
            picks={pickNumbers}
            coach={(entrant) => franchiseLabel(league, entrant)}
          />
        </section>
      ) : null}
    </div>
  );
}

export function LeaguesView({
  epoch,
  boards,
  run,
  team,
  series,
  onOpenLeague,
  onOpenTeam,
  onBack,
}: {
  boards: BoardInfo[] | null;
  epoch: number;
  run: string | undefined;
  team: string | undefined;
  series: number | undefined;
  onOpenLeague: (runId: string) => void;
  onOpenTeam: (runId: string, slug: string, series?: number) => void;
  onBack: () => void;
}) {
  const [list, setList] = useState<LeaguesResponse | null>(null);
  const [league, setLeague] = useState<LeagueResponse | null>(null);
  const [error, setError] = useState('');
  const [boardId, setBoardId] = useState('');
  const { board: cleanBoard, error: cleanBoardError } = useBoard(run ? '' : boardId);
  const noOwners = useMemo(() => new Map<string, number>(), []);

  useEffect(() => {
    if (run) return;
    api<LeaguesResponse>('/api/leagues')
      .then((response) => {
        setList(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [run, epoch]);

  useEffect(() => {
    if (run || !list?.leagues.some((card) => card.live)) return;
    const timer = setInterval(() => {
      apiFresh<LeaguesResponse>('/api/leagues')
        .then(setList)
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [run, list]);

  useEffect(() => {
    if (!run) return;
    if (league?.runId === run) return;
    setLeague(null);
    api<LeagueResponse>(`/api/league?run=${encodeURIComponent(run)}`)
      .then((response) => {
        setLeague(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [run, epoch, league?.runId]);

  useEffect(() => {
    if (!run || league?.runId !== run || !league.live) return;
    const timer = setInterval(() => {
      apiFresh<LeagueResponse>(`/api/league?run=${encodeURIComponent(run)}`)
        .then(setLeague)
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(timer);
  }, [run, league?.runId, league?.live]);

  if (run) {
    if (error)
      return (
        <div>
          <h1>Draft league unavailable</h1>
          <div class="message error">Could not load this league: {error}</div>
        </div>
      );
    if (!league || league.runId !== run)
      return (
        <div class="archive-route-pending" aria-busy="true">
          <p class="eyebrow">Records / draft leagues</p>
          <h1>Draft league</h1>
          <p class="muted" role="status">
            Loading the stored season…
          </p>
        </div>
      );
    return (
      <LeaguePage
        league={league}
        team={team}
        series={series}
        onOpenTeam={(slug, focus) => onOpenTeam(run, slug, focus)}
        onBack={() => (team ? onOpenLeague(run) : onBack())}
      />
    );
  }

  const leagues = list?.leagues ?? [];
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Records / draft leagues</p>
          <h1>Draft leagues.</h1>
        </div>
        <p class="lede">
          Every stored season: who drafted what, how they built for each matchup, and who took the title.
        </p>
      </header>
      {error ? <div class="message error">Could not load the archive: {error}</div> : null}
      {boardId ? (
        <section class="panel archive-board-view">
          <div class="section-head">
            <div>
              <p class="eyebrow">Untouched board</p>
              <h2>{boardId}</h2>
              <p>No picks applied. Search the full board by Pokémon, type, or ability.</p>
            </div>
            <button type="button" class="button" onClick={() => setBoardId('')}>
              ← League archive
            </button>
          </div>
          {cleanBoardError ? <p class="empty-note">Could not load the board: {cleanBoardError}</p> : null}
          {cleanBoard ? (
            <BoardBrowser board={cleanBoard.mons} owners={noOwners} coach={() => ''} />
          ) : cleanBoardError ? null : (
            <p class="empty-note">Loading the board…</p>
          )}
        </section>
      ) : (
        <div class="league-index-layout">
          <div class="league-index-main">
            {list === null && !error ? (
              <LeagueArchivePending />
            ) : leagues.length === 0 && !error ? (
              <section class="panel">
                <div class="results-empty">
                  No draft leagues recorded yet. Start one from <b>New run</b>; finished seasons are archived here.
                </div>
              </section>
            ) : (
              <div class="league-card-grid">
                {leagues.map((card) => (
                  <LeagueCard key={card.runId} card={card} onOpen={() => onOpenLeague(card.runId)} />
                ))}
              </div>
            )}
          </div>
          <aside class="panel draft-board-shelf">
            <div class="section-head">
              <div>
                <p class="eyebrow">Reference</p>
                <h2>Draft boards</h2>
                <p>Browse any board before a season fills it in.</p>
              </div>
            </div>
            <div class="board-snapshot-list">
              {boards === null ? <DraftBoardsPending /> : null}
              {boards?.map((board) => (
                <button type="button" class="board-snapshot" key={board.id} onClick={() => setBoardId(board.id)}>
                  <span>
                    <b>{board.id}</b>
                    <small>{board.format}</small>
                  </span>
                  <span class="board-snapshot-count">
                    {board.monCount}
                    <small>Pokémon</small>
                  </span>
                  <span class="board-snapshot-meta">
                    {board.picks} picks · {board.budget} points
                  </span>
                </button>
              ))}
              {boards?.length === 0 ? <p class="empty-note">No draft boards are installed.</p> : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
