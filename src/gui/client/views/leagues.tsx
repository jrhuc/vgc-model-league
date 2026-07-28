import { useEffect, useMemo, useState } from 'preact/hooks';

import type {
  BoardInfo,
  LeagueCardView,
  LeagueFranchiseView,
  LeagueResponse,
  LeagueSeriesView,
  LeaguesResponse,
  LeagueTeambuildView,
} from '../../api';
import { BoardBrowser, STAT_ORDER, useBoard } from '../components/boardbrowser';
import { StatTile } from '../components/chartkit';
import { Mark } from '../components/mark';
import { Sprite } from '../components/sprite';
import { api } from '../http';

function displaySpec(spec: string): string {
  return spec.replace(/:(?:nitro|floor|free)$/, '');
}

function modelKeyOf(spec: string): string {
  const model = spec.slice(spec.indexOf(':') + 1);
  return model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/:(?:nitro|floor|free)$/, '');
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
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
  roundrobin: 'Round robin',
  playoffs: 'Playoffs',
  complete: 'Complete',
} as const;

function phaseLabel(card: Pick<LeagueCardView, 'phase' | 'week' | 'weeks'>): string {
  if (card.phase === 'roundrobin' && card.week > 0) {
    return `Round robin · week ${card.week}${card.weeks ? ` of ${card.weeks}` : ''}`;
  }
  return PHASE_LABELS[card.phase];
}

function LeagueCard({ card, onOpen }: { card: LeagueCardView; onOpen: () => void }) {
  return (
    <button type="button" class="league-card panel" onClick={onOpen}>
      <div class="league-card-top">
        <span class="eyebrow">
          {when(card.when)}
          {card.board ? ` · ${card.board}` : ''}
        </span>
        <span class={`phase-pill ${card.phase}`}>{phaseLabel(card)}</span>
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
          <b>Season in progress</b>
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
        {card.entrants.length} coaches · {card.seriesCount} series recorded
      </span>
    </button>
  );
}

function FranchiseCard({
  franchise,
  spriteFor,
  onOpenTeam,
  onOpenModel,
}: {
  franchise: LeagueFranchiseView;
  spriteFor: (id: string) => string;
  onOpenTeam: () => void;
  onOpenModel: () => void;
}) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const slot = franchise.roster.find((entry) => entry.id === openSlot);
  return (
    <article class="franchise-card panel">
      <header class="franchise-card-head">
        <div>
          <b>{franchise.teamName}</b>
          <button type="button" class="model-link" onClick={onOpenModel}>
            <Mark spec={franchise.model} size={14} />
            <span>{displaySpec(franchise.model)}</span>
          </button>
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
            title={`${entry.name} · ${entry.cost} pts${entry.pick !== null ? ` · pick ${entry.pick}` : ''}`}
            onClick={() => setOpenSlot(openSlot === entry.id ? null : entry.id)}
          >
            <Sprite id={spriteFor(entry.id)} size={40} />
          </button>
        ))}
      </div>
      {slot ? (
        <div class="franchise-pick">
          <span class="draft-feed-head">
            {slot.pick !== null ? `Pick ${slot.pick} · ` : ''}
            {slot.name} · {slot.cost} pts{slot.fallback ? ' · fallback pick' : ''}
          </span>
          <p>{slot.rationale || 'No stored rationale for this pick.'}</p>
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

function seriesLabel(series: LeagueSeriesView, maxPlayoffRound: number): string {
  if (series.stage === 'roundrobin') return `Week ${series.round}`;
  return series.round === maxPlayoffRound && maxPlayoffRound > 1
    ? 'Final'
    : maxPlayoffRound > 1
      ? 'Semifinal'
      : 'Final';
}

function ScheduleTable({ league, onOpenTeam }: { league: LeagueResponse; onOpenTeam: (entrant: number) => void }) {
  const maxPlayoffRound = Math.max(
    1,
    ...league.series.filter((entry) => entry.stage === 'playoff').map((entry) => entry.round),
  );
  const name = (entrant: number) => league.franchises[entrant]?.teamName ?? `Coach ${entrant + 1}`;
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
              <td class="muted">{seriesLabel(series, maxPlayoffRound)}</td>
              <td>
                {series.sides.map((entrant, index) => (
                  <span key={entrant}>
                    {index > 0 ? <span class="muted"> vs </span> : null}
                    <button
                      type="button"
                      class={`text-link ${series.winner === entrant ? 'winner' : ''}`}
                      onClick={() => onOpenTeam(entrant)}
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
                    <span
                      key={index}
                      class={`game-chip ${game.winner === series.sides[0] ? 'left' : game.winner === series.sides[1] ? 'right' : ''}`}
                      title={`Game ${index + 1}: ${game.winner === null ? 'no winner' : `${name(game.winner)} in ${game.turns} turns`}`}
                    >
                      {game.winner === null ? '·' : name(game.winner).slice(0, 1)}
                    </span>
                  ))}
                </span>
              </td>
              <td class="num">{series.turns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function TeamPage({
  league,
  franchise,
  spriteFor,
  onBack,
  onOpenModel,
}: {
  league: LeagueResponse;
  franchise: LeagueFranchiseView;
  spriteFor: (id: string) => string;
  onBack: () => void;
  onOpenModel: () => void;
}) {
  const builds = league.teambuilds
    .filter((build) => build.entrant === franchise.entrant)
    .sort((a, b) => a.seriesIndex - b.seriesIndex);
  const bySeries = new Map(league.series.map((series) => [series.seriesIndex, series] as const));
  const picks = [...franchise.roster].sort((a, b) => (a.pick ?? 99) - (b.pick ?? 99));
  const name = (entrant: number) => league.franchises[entrant]?.teamName ?? `Coach ${entrant + 1}`;
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
          <button type="button" class="model-link" onClick={onOpenModel}>
            <Mark spec={franchise.model} size={16} />
            <span>{displaySpec(franchise.model)}</span>
          </button>
          <span>
            {franchise.overallRecord.w}-{franchise.overallRecord.l} in series, {franchise.overallRecord.gw}-
            {franchise.overallRecord.gl} in games · regular season {franchise.roundRobinRecord.w}-
            {franchise.roundRobinRecord.l}
            {franchise.finish ? ` · ${franchise.finish.toLowerCase()}` : ''}
          </span>
        </div>
      </header>

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
                {entry.pick !== null ? `#${entry.pick} · ` : ''}
                {entry.name} · {entry.cost} pts
                {entry.fallback ? ' · fallback' : ''}
              </span>
              <p>{entry.rationale || 'No stored rationale.'}</p>
            </div>
          ))}
          {picks.length === 0 ? <p class="muted">No stored draft for this roster.</p> : null}
        </div>
      </section>

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
            const changes = setDiff(builds[index - 1], build);
            const won = series?.winner === franchise.entrant;
            return (
              <details class="teambuild-card" key={build.seriesIndex} open={index === builds.length - 1}>
                <summary>
                  <b>vs {name(build.opponent)}</b>
                  {series ? (
                    <span class={`series-result ${won ? 'won' : series.winner === null ? '' : 'lost'}`}>
                      {won ? 'won' : series.winner === null ? 'unresolved' : 'lost'}{' '}
                      {series.sides[0] === franchise.entrant
                        ? `${series.score[0]}–${series.score[1]}`
                        : `${series.score[1]}–${series.score[0]}`}
                    </span>
                  ) : null}
                  <span class="muted">
                    {' '}
                    · {build.attempts} build attempt{build.attempts === 1 ? '' : 's'}
                  </span>
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
                    <div class={`teambuild-set ${set.repaired ? 'repaired' : ''}`} key={set.species}>
                      <div class="teambuild-set-head">
                        <Sprite id={set.spriteId} size={26} />
                        <b>{set.species}</b>
                        {set.item ? <span>@ {set.item}</span> : null}
                      </div>
                      <small>
                        {set.ability} · {set.nature}
                      </small>
                      <ul>
                        {set.moves.map((move) => (
                          <li key={move}>{move}</li>
                        ))}
                      </ul>
                      <small class="teambuild-evs">
                        {STAT_ORDER.filter((stat) => set.evs[stat])
                          .map((stat) => `${set.evs[stat]} ${stat}`)
                          .join(' / ') || 'no EVs'}
                      </small>
                    </div>
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

function LeaguePage({
  league,
  team,
  onOpenTeam,
  onOpenModel,
  onBack,
}: {
  league: LeagueResponse;
  team: string | undefined;
  onOpenTeam: (slug: string) => void;
  onOpenModel: (id: string) => void;
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
  const pickNumbers = useMemo(() => {
    const map = new Map<string, number>();
    for (const franchise of league.franchises) {
      for (const entry of franchise.roster) if (entry.pick !== null) map.set(entry.id, entry.pick);
    }
    return map;
  }, [league]);

  const selected = league.franchises.find((franchise) => teamSlug(franchise.teamName) === team);
  if (selected) {
    return (
      <TeamPage
        league={league}
        franchise={selected}
        spriteFor={spriteFor}
        onBack={onBack}
        onOpenModel={() => onOpenModel(modelKeyOf(selected.model))}
      />
    );
  }

  const franchises = [...league.franchises].sort(
    (a, b) =>
      Number(b.entrant === league.champion?.entrant) - Number(a.entrant === league.champion?.entrant) ||
      b.roundRobinRecord.w - a.roundRobinRecord.w ||
      b.roundRobinRecord.gw - b.roundRobinRecord.gl - (a.roundRobinRecord.gw - a.roundRobinRecord.gl),
  );
  const seriesByIndex = new Map(league.series.map((series) => [series.seriesIndex, series] as const));
  const usageByPick = new Map<
    string,
    { entrant: number; id: string; name: string; cost: number; matchups: number; w: number; l: number }
  >();
  for (const build of league.teambuilds) {
    const franchise = league.franchises.find((entry) => entry.entrant === build.entrant);
    const series = seriesByIndex.get(build.seriesIndex);
    for (const id of build.brought) {
      const pick = franchise?.roster.find((entry) => entry.id === id);
      const key = `${build.entrant}:${id}`;
      const usage = usageByPick.get(key) ?? {
        entrant: build.entrant,
        id,
        name: pick?.name ?? id,
        cost: pick?.cost ?? 0,
        matchups: 0,
        w: 0,
        l: 0,
      };
      usage.matchups += 1;
      if (series?.winner === build.entrant) usage.w += 1;
      else if (series?.winner !== null && series?.winner !== undefined) usage.l += 1;
      usageByPick.set(key, usage);
    }
  }
  const usage = [...usageByPick.values()]
    .sort((a, b) => b.matchups - a.matchups || b.w - a.w || b.cost - a.cost || a.name.localeCompare(b.name))
    .slice(0, 8);
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
          budget{league.format ? `, ${league.format}` : ''}.
        </p>
      </header>

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
            onOpenModel={() => onOpenModel(modelKeyOf(franchise.model))}
          />
        ))}
      </div>

      <div class="results-grid">
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Most selected Pokémon</h2>
              <p>How often each draft pick made the six built for a matchup, with its series record.</p>
            </div>
          </div>
          <div class="table-scroll">
            <table class="data-table usage-table">
              <thead>
                <tr>
                  <th>Pokémon</th>
                  <th>Franchise</th>
                  <th class="num">Cost</th>
                  <th class="num">Matchups</th>
                  <th class="num">W-L</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((entry) => {
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
                      <td class="num">{entry.matchups}</td>
                      <td class="num">
                        {entry.w}-{entry.l}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Schedule &amp; results</h2>
              <p>Every series with game winners and turn counts.</p>
            </div>
          </div>
          <ScheduleTable
            league={league}
            onOpenTeam={(entrant) => {
              const franchise = league.franchises[entrant];
              if (franchise) onOpenTeam(teamSlug(franchise.teamName));
            }}
          />
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
            coach={(entrant) => league.franchises[entrant]?.teamName ?? `Coach ${entrant + 1}`}
          />
        </section>
      ) : null}
    </div>
  );
}

export function LeaguesView({
  active,
  epoch,
  boards,
  run,
  team,
  onOpenLeague,
  onOpenTeam,
  onOpenModel,
  onBack,
}: {
  boards: BoardInfo[];
  active: boolean;
  epoch: number;
  run: string | undefined;
  team: string | undefined;
  onOpenLeague: (runId: string) => void;
  onOpenTeam: (runId: string, slug: string) => void;
  onOpenModel: (id: string) => void;
  onBack: () => void;
}) {
  const [list, setList] = useState<LeaguesResponse | null>(null);
  const [league, setLeague] = useState<LeagueResponse | null>(null);
  const [error, setError] = useState('');
  const [boardId, setBoardId] = useState('');
  const { board: cleanBoard, error: cleanBoardError } = useBoard(run ? '' : boardId);
  const noOwners = useMemo(() => new Map<string, number>(), []);

  useEffect(() => {
    if (!active || run) return;
    api<LeaguesResponse>('/api/leagues')
      .then((response) => {
        setList(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, run, epoch]);

  useEffect(() => {
    if (!active || !run) return;
    if (league?.runId === run) return;
    setLeague(null);
    api<LeagueResponse>(`/api/league?run=${encodeURIComponent(run)}`)
      .then((response) => {
        setLeague(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, run, epoch, league?.runId]);

  if (run) {
    if (error) return <div class="message error">Could not load this league: {error}</div>;
    if (!league || league.runId !== run) return <p class="muted">Loading the league…</p>;
    return (
      <LeaguePage
        league={league}
        team={team}
        onOpenTeam={(slug) => onOpenTeam(run, slug)}
        onOpenModel={onOpenModel}
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
            {leagues.length === 0 && !error ? (
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
              {boards.map((board) => (
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
              {boards.length === 0 ? <p class="empty-note">No draft boards are installed.</p> : null}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
