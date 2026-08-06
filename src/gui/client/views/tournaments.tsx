import { useEffect, useState } from 'preact/hooks';

import type { LeagueGameResponse, TournamentArchiveView, TournamentSummary, TournamentsResponse } from '../../api';
import { Battlefield } from '../components/battlefield';
import { BracketGrid, roundName } from '../components/bracket';
import { StatTile, Tooltip, useTip } from '../components/chartkit';
import { GameReflections, GameTimeline } from '../components/gamelog';
import { Mark } from '../components/mark';
import { api, apiFresh } from '../http';

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const PLACEMENTS = [
  { key: 'titles', label: 'Champion', color: 'var(--chart-navy)' },
  { key: 'runnerUp', label: 'Lost the final', color: 'var(--chart-blue)' },
  { key: 'semis', label: 'Lost a semi', color: 'var(--chart-blue-soft)' },
  { key: 'earlier', label: 'Earlier exit', color: 'var(--chart-blue-faint)' },
] as const;

const LANES = { label: 220, plot: 470, tail: 110, row: 27, top: 8, bottom: 26 };

function TournamentLanes({ summary }: { summary: TournamentSummary }) {
  const [tip, showTip, hideTip] = useTip();
  if (summary.tournaments === 0) {
    return (
      <div class="results-empty">
        No finished brackets yet. Tournament runs land here as placement lanes: titles, finals, and how deep each model
        survives.
      </div>
    );
  }
  const rows = summary.standings;
  const maxEntered = Math.max(1, ...rows.map((row) => row.entered));
  const unit = LANES.plot / maxEntered;
  const height = LANES.top + rows.length * LANES.row + LANES.bottom;
  const width = LANES.label + LANES.plot + LANES.tail;
  return (
    <div class="chart-host">
      <div class="chart-legend">
        {PLACEMENTS.map((placement) => (
          <span key={placement.key}>
            <i style={{ background: placement.color }} /> {placement.label}
          </span>
        ))}
      </div>
      <div class="table-scroll">
        <svg width={width} height={height} role="img" aria-label="Tournament placements by model">
          {rows.map((row, index) => {
            const y = LANES.top + index * LANES.row;
            let cursor = LANES.label;
            const lines = [
              row.spec,
              `${row.entered} bracket${row.entered === 1 ? '' : 's'}: ${row.titles} title${row.titles === 1 ? '' : 's'}, ${row.runnerUp} final, ${row.semis} semi, ${row.earlier} earlier`,
              `matches ${row.matchWins}-${row.matchLosses}`,
            ];
            return (
              /* biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip supplements the visible counts */
              <g
                key={row.spec}
                onMouseMove={(event) => showTip(event as unknown as MouseEvent, lines)}
                onMouseLeave={hideTip}
              >
                <rect x={0} y={y} width={width} height={LANES.row} fill="transparent" />
                <text x={LANES.label - 12} y={y + LANES.row / 2 + 3.5} text-anchor="end" class="chart-label">
                  {row.spec}
                </text>
                {PLACEMENTS.map((placement) => {
                  const value = row[placement.key];
                  if (!value) return null;
                  const segment = (
                    <rect
                      key={placement.key}
                      x={cursor}
                      y={y + LANES.row / 2 - 7}
                      width={Math.max(0, value * unit - 2)}
                      height={14}
                      fill={placement.color}
                    />
                  );
                  cursor += value * unit;
                  return segment;
                })}
                <text x={cursor + 8} y={y + LANES.row / 2 + 3.5} class="chart-value">
                  {row.titles > 0 ? `${row.titles}×🏆 ` : ''}
                  {row.matchWins}-{row.matchLosses}
                </text>
              </g>
            );
          })}
          <text x={LANES.label} y={height - 7} class="chart-tick">
            {summary.tournaments} bracket{summary.tournaments === 1 ? '' : 's'} · {summary.matches} matches
          </text>
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function EventHeader({ archive }: { archive: TournamentArchiveView }) {
  const event = archive.event;
  if (!event) return null;
  const field = event.players ? `${event.players} players` : '';
  return (
    <div class="event-provenance">
      <p>
        Replaying the top {archive.entrants.length} of{' '}
        {event.url ? (
          <a href={event.url} target="_blank" rel="noreferrer">
            {event.name}
          </a>
        ) : (
          event.name
        )}
        {event.game ? ` · ${event.game}` : ''}
        {event.regulation ? ` · ${event.regulation}` : ''}
        {event.dates ? ` · ${event.dates}` : ''}
        {field ? ` · ${field}` : ''}
      </p>
      <p class="muted">
        {archive.provenance === 'blind'
          ? 'Seats were told nothing about where these teams came from.'
          : 'Each seat was told the event and how both teams in front of it finished.'}
        {event.reconstructedSpreads
          ? ' Stat points were rebuilt from public sets of the same Pokémon in this regulation; the published lists carried none.'
          : ''}
      </p>
    </div>
  );
}

function EntrantTable({ archive }: { archive: TournamentArchiveView }) {
  const seeded = archive.entrants.some((entrant) => (entrant.placement ?? entrant.seed ?? null) !== null);
  if (!seeded) return null;
  return (
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th class="num">Finish</th>
            <th>Team</th>
            <th>Original player</th>
            <th>Piloted by</th>
          </tr>
        </thead>
        <tbody>
          {archive.entrants
            .map((entrant, index) => ({ entrant, index }))
            .sort(
              (a, b) => (a.entrant.placement ?? a.entrant.seed ?? 99) - (b.entrant.placement ?? b.entrant.seed ?? 99),
            )
            .map(({ entrant, index }) => (
              <tr key={index}>
                <td class="num">{entrant.placement ?? entrant.seed ?? '–'}</td>
                <td>
                  {entrant.paste ? (
                    <a href={entrant.paste} target="_blank" rel="noreferrer">
                      {entrant.team}
                    </a>
                  ) : (
                    entrant.team
                  )}
                </td>
                <td>{entrant.player || '–'}</td>
                <td class="spec-cell">
                  <Mark spec={entrant.model} size={14} /> {entrant.model}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchGame({
  archive,
  seriesIndex,
  game,
  onOpenGame,
  onBack,
}: {
  archive: TournamentArchiveView;
  seriesIndex: number;
  game: number;
  onOpenGame: (seriesIndex: number, game: number) => void;
  onBack: () => void;
}) {
  const [view, setView] = useState<(LeagueGameResponse & { receivedAt: number }) | null>(null);
  const [error, setError] = useState('');
  const path = `/api/tournament/game?run=${encodeURIComponent(archive.runId)}&series=${seriesIndex}&game=${game}`;

  useEffect(() => {
    setView(null);
    api<LeagueGameResponse>(path)
      .then((response) => {
        setView({ ...response, receivedAt: Date.now() });
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [path]);

  useEffect(() => {
    if (!view?.live) return;
    const timer = setInterval(() => {
      apiFresh<LeagueGameResponse>(path)
        .then((response) => setView({ ...response, receivedAt: Date.now() }))
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [view?.live, path]);

  if (error) return <div class="message error">Could not load this game: {error}</div>;
  if (!view) return <p class="muted">Loading the game…</p>;

  const names: [string, string] = [
    archive.entrants[view.sides[0]]?.model ?? view.teamNames[0],
    archive.entrants[view.sides[1]]?.model ?? view.teamNames[1],
  ];
  const seriesScore: [number, number] = [
    view.gameWinners.filter((winner) => winner === view.sides[0]).length,
    view.gameWinners.filter((winner) => winner === view.sides[1]).length,
  ];
  const sideWarning = (side: 0 | 1): string => {
    for (let index = view.decisions.length - 1; index >= 0; index -= 1) {
      const decision = view.decisions[index]!;
      if (decision.side !== side || decision.automatic) continue;
      return decision.fallback ? 'Latest model decision used a fallback.' : '';
    }
    return '';
  };
  const seriesOver = view.reflections.some((reflection) => reflection.seriesOver);
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← Bracket · {when(archive.when)}
            </button>{' '}
            / {roundName(view.round - 1, archive.rounds.length)}
          </p>
          <h1 class="matchup-heading">
            {names[0]} vs {names[1]}.
          </h1>
        </div>
        <div class="lede team-lede">
          <span>
            {view.live ? <span class="live-dot" aria-hidden="true" /> : null} Game {view.game} of {view.games.length}
            {view.winner !== null
              ? ` · ${archive.entrants[view.winner]?.model ?? 'winner'} took it`
              : view.live
                ? ' · in progress'
                : ' · no winner recorded'}
            {seriesScore[0] + seriesScore[1] > 0 ? ` · series ${seriesScore[0]}–${seriesScore[1]}` : ''}
          </span>
          <span class="game-switcher">
            {view.games.map((number, index) => (
              <button
                key={number}
                type="button"
                class={`game-chip ${
                  view.gameWinners[index] === view.sides[0]
                    ? 'left'
                    : view.gameWinners[index] === view.sides[1]
                      ? 'right'
                      : ''
                } ${number === view.game ? 'on' : ''}`}
                onClick={() => onOpenGame(seriesIndex, number)}
              >
                {number}
              </button>
            ))}
          </span>
        </div>
      </header>

      {view.snapshot ? (
        <section class="panel battlefield">
          <Battlefield
            snapshot={view.snapshot}
            receivedAt={view.receivedAt}
            players={{ p1: names[0], p2: names[1] }}
            warnings={{ p1: sideWarning(0), p2: sideWarning(1) }}
            meta={<span class="turn-badge">{view.snapshot.turn ? `Turn ${view.snapshot.turn}` : 'Team preview'}</span>}
          />
        </section>
      ) : null}

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Turn by turn</h2>
            <p>Both seats' choices with their recorded reasoning, then what the simulator resolved.</p>
          </div>
        </div>
        <GameTimeline decisions={view.decisions} log={view.log} names={names} />
      </section>

      {view.reflections.length > 0 ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>{seriesOver ? 'Series reflections' : 'Post-game reflections'}</h2>
              <p>What each seat took from the game it just played.</p>
            </div>
          </div>
          <GameReflections
            reflections={view.reflections}
            names={names}
            notebookLabel={seriesOver ? 'Notes for a rematch' : 'Notebook carried forward'}
          />
        </section>
      ) : null}
    </div>
  );
}

function TournamentCard({
  archive,
  open,
  onToggle,
  onOpenGame,
}: {
  archive: TournamentArchiveView;
  open: boolean;
  onToggle: () => void;
  onOpenGame: (seriesIndex: number, game: number) => void;
}) {
  const champion = archive.champion === null ? null : archive.entrants[archive.champion];
  const liveIndexes = new Set(
    archive.liveSeries.map((entry) => entry.seriesIndex).filter((index): index is number => index !== null),
  );
  return (
    <section class="panel tournament-card">
      <button type="button" class="tournament-card-head" onClick={onToggle} aria-expanded={open}>
        <div class="tournament-card-title">
          {archive.live ? (
            <>
              <span class="eyebrow">
                <span class="live-dot" aria-hidden="true" /> Live
              </span>
              <b>{archive.event?.name ?? 'Bracket in progress'}</b>
              <small>
                {archive.liveSeries.length} match{archive.liveSeries.length === 1 ? '' : 'es'} running
              </small>
            </>
          ) : champion ? (
            <>
              <span class="eyebrow">Champion</span>
              <b>
                <Mark spec={champion.model} size={16} /> {champion.model}
              </b>
              <small>{champion.team}</small>
            </>
          ) : (
            <>
              <span class="eyebrow">Unresolved</span>
              <b>{archive.event?.name ?? 'Bracket unresolved'}</b>
            </>
          )}
        </div>
        <div class="tournament-card-meta">
          <span>{when(archive.when)}</span>
          <span>
            {archive.entrants.length} entrant{archive.entrants.length === 1 ? '' : 's'}
          </span>
          {archive.pool && <span>{archive.pool}</span>}
          <span class="tournament-card-toggle">{open ? 'Hide bracket' : 'View bracket'}</span>
        </div>
      </button>
      {open && (
        <>
          <EventHeader archive={archive} />
          <BracketGrid
            entrants={archive.entrants}
            rounds={archive.rounds}
            scoreFor={(match, side) => (match.score ? String(match.score[side]) : '')}
            live={liveIndexes}
            onSelect={(index) => onOpenGame(index, 1)}
          />
          {archive.liveSeries.length > 0 && (
            <ul class="live-feed">
              {archive.liveSeries.map((entry) => (
                <li class="live-series" key={entry.seriesId}>
                  <span class="live-series-matchup">
                    <span class="live-dot" aria-hidden="true" />
                    {entry.round === null ? 'Match' : roundName(entry.round, archive.rounds.length)} ·{' '}
                    {archive.entrants[entry.slots[0] ?? -1]?.model ?? 'TBD'} vs{' '}
                    {archive.entrants[entry.slots[1] ?? -1]?.model ?? 'TBD'}
                  </span>
                  <span class="live-series-state">
                    game {entry.game}
                    {entry.turn ? ` · turn ${entry.turn}` : ' · team preview'}
                    {entry.seriesIndex !== null && (
                      <button type="button" class="button" onClick={() => onOpenGame(entry.seriesIndex!, entry.game)}>
                        Watch live
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <EntrantTable archive={archive} />
        </>
      )}
    </section>
  );
}

export function TournamentsView({
  active,
  epoch,
  run,
  onOpenRun,
  onOpenModel,
}: {
  active: boolean;
  epoch: number;
  run: string | undefined;
  onOpenRun: (runId: string) => void;
  onOpenModel: (id: string) => void;
}) {
  const [data, setData] = useState<TournamentsResponse | null>(null);
  const [error, setError] = useState('');
  const [openRun, setOpenRun] = useState(run ?? '');
  const [game, setGame] = useState<{ runId: string; seriesIndex: number; game: number } | null>(null);

  useEffect(() => setOpenRun(run ?? ''), [run]);

  useEffect(() => {
    if (!active) return;
    api<TournamentsResponse>('/api/tournaments')
      .then((response) => {
        setData(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, epoch]);

  const archives = data?.tournaments ?? [];
  const anyLive = archives.some((archive) => archive.live);
  useEffect(() => {
    if (!active || !anyLive) return;
    const timer = setInterval(() => {
      apiFresh<TournamentsResponse>('/api/tournaments')
        .then((response) => setData(response))
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [active, anyLive]);

  const summary = data?.summary ?? { tournaments: 0, matches: 0, standings: [] };
  const finished = archives.filter((archive) => archive.complete);
  const latest = finished[0];
  const reigning = latest && latest.champion !== null ? latest.entrants[latest.champion] : null;
  const titleLeader = summary.standings[0];

  if (game) {
    const archive = archives.find((entry) => entry.runId === game.runId);
    if (archive) {
      return (
        <MatchGame
          archive={archive}
          seriesIndex={game.seriesIndex}
          game={game.game}
          onOpenGame={(seriesIndex, number) => setGame({ runId: game.runId, seriesIndex, game: number })}
          onBack={() => setGame(null)}
        />
      );
    }
  }

  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Records / tournaments</p>
          <h1>Tournaments.</h1>
        </div>
        <p class="lede">
          Single-elimination brackets, live and archived. A pool taken from a real event keeps that event's seeding, so
          the top cut meets in the pairings the field earned. Brackets never touch the rated Elo.
        </p>
      </header>
      {error ? <div class="message error">Could not load the brackets: {error}</div> : null}
      <div class="stat-row">
        <StatTile
          label="Brackets"
          value={String(summary.tournaments)}
          note={`${finished.length} finished, ${archives.length - finished.length} unresolved`}
        />
        <StatTile label="Matches" value={String(summary.matches)} note="best-of-three series" />
        <StatTile
          label="Reigning champion"
          value={reigning ? reigning.model : '–'}
          note={reigning ? reigning.team : 'no finished bracket yet'}
        />
        <StatTile
          label="Most titles"
          value={titleLeader && titleLeader.titles > 0 ? titleLeader.spec : '–'}
          note={
            titleLeader && titleLeader.titles > 0
              ? `${titleLeader.titles} title${titleLeader.titles === 1 ? '' : 's'}`
              : 'trophy case is open'
          }
        />
      </div>
      {archives.length === 0 && !error ? (
        <section class="panel">
          <div class="results-empty">
            No tournaments recorded yet. Start one from the New run tab; finished brackets are archived here.
          </div>
        </section>
      ) : (
        archives.map((archive) => (
          <TournamentCard
            key={archive.runId}
            archive={archive}
            open={openRun === archive.runId || archive.live}
            onToggle={() => {
              const next = openRun === archive.runId ? '' : archive.runId;
              setOpenRun(next);
              onOpenRun(next);
            }}
            onOpenGame={(seriesIndex, number) => setGame({ runId: archive.runId, seriesIndex, game: number })}
          />
        ))
      )}
      <section class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2>Tournament placements</h2>
            <p>Placement per entry, normalized by distance from the final so bracket sizes aggregate.</p>
          </div>
        </div>
        <div class="chart-body">
          <TournamentLanes summary={summary} />
        </div>
      </section>
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Tournament record</h2>
            <p>Every entry, deepest run, and match record per model.</p>
          </div>
        </div>
        <div class="table-scroll">
          {summary.standings.length === 0 ? (
            <div class="results-empty">The record book opens with the first completed bracket.</div>
          ) : (
            <table class="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th class="num">Entered</th>
                  <th class="num">Titles</th>
                  <th class="num">Finals</th>
                  <th class="num">Semis</th>
                  <th class="num">Earlier</th>
                  <th class="num">Matches</th>
                </tr>
              </thead>
              <tbody>
                {summary.standings.map((row) => (
                  <tr key={row.spec}>
                    <td class="spec-cell" title={row.spec}>
                      <button type="button" class="model-link" onClick={() => onOpenModel(row.spec)}>
                        <Mark spec={row.spec} size={14} />
                        <span>{row.spec}</span>
                      </button>
                    </td>
                    <td class="num">{row.entered}</td>
                    <td class="num">{row.titles}</td>
                    <td class="num">{row.runnerUp}</td>
                    <td class="num">{row.semis}</td>
                    <td class="num">{row.earlier}</td>
                    <td class="num">
                      {row.matchWins}-{row.matchLosses}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
