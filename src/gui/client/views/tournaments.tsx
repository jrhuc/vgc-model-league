import { useEffect, useState } from 'preact/hooks';

import type { TournamentArchiveView, TournamentsResponse } from '../../api';
import { BracketGrid, roundName } from '../components/bracket';
import { StatTile } from '../components/chartkit';
import { Mark } from '../components/mark';
import { MatchGame, useMatchGame } from '../components/matchgame';
import { MatchMenu, MatchMenuRow } from '../components/matchmenu';
import { api, apiFresh } from '../http';
import { entrantOrigin, formatTeamSlug, modelName, when } from '../lib/labels';

function entrantName(archive: TournamentArchiveView, entrant: number | null | undefined, fallback = 'TBD'): string {
  if (entrant === null || entrant === undefined) return fallback;
  return archive.entrants[entrant]?.model.trim() || fallback;
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
          : 'Each seat was told the event and that both teams in the match made that cut, but not which team placed where.'}
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
      <p class="card-subhead">The field</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Team</th>
            <th>Built by</th>
            <th class="num">Event finish</th>
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
                <td class="spec-cell">
                  <span class="seat-cell">
                    <Mark spec={entrant.model} size={14} />
                    <span>{entrant.model}</span>
                  </span>
                </td>
                <td>
                  {entrant.paste ? (
                    <a class="team-link" href={entrant.paste} target="_blank" rel="noreferrer">
                      {formatTeamSlug(entrant.team)}
                    </a>
                  ) : (
                    formatTeamSlug(entrant.team)
                  )}
                </td>
                <td>{entrant.player || '–'}</td>
                <td class="num">{entrant.placement ?? entrant.seed ?? '–'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function teamCredit(entrant: TournamentArchiveView['entrants'][number] | undefined): string {
  const origin = entrantOrigin(entrant);
  return entrant?.player ? `${origin}'s team` : origin;
}

function TournamentGame({
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
  const path = `/api/tournament/game?run=${encodeURIComponent(archive.runId)}&series=${seriesIndex}&game=${game}`;
  const { view, error } = useMatchGame(path, 4_000);
  if (error)
    return (
      <div>
        <h1>Tournament game unavailable</h1>
        <div class="message error">Could not load this game: {error}</div>
      </div>
    );
  if (!view)
    return (
      <div>
        <h1>Tournament game</h1>
        <p class="muted">Loading the game…</p>
      </div>
    );

  const first = archive.entrants[view.sides[0]];
  const second = archive.entrants[view.sides[1]];
  const players: [string, string] = [
    entrantName(archive, view.sides[0], view.teamNames[0] || 'Player 1'),
    entrantName(archive, view.sides[1], view.teamNames[1] || 'Player 2'),
  ];
  const titles: [string, string] = [modelName(players[0]), modelName(players[1])];
  const details: [string, string] = [teamCredit(first), teamCredit(second)];

  return (
    <MatchGame
      view={view}
      eyebrow={
        <>
          <button type="button" class="text-link" onClick={onBack}>
            ← Bracket · {when(archive.when)}
          </button>{' '}
          / {roundName(view.round - 1, archive.rounds.length)}
        </>
      }
      titles={titles}
      players={players}
      details={details}
      teams={[first?.teamSheet, second?.teamSheet]}
      onOpenGame={(number) => onOpenGame(seriesIndex, number)}
    />
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
    <section class={`panel tournament-card ${archive.live ? 'live' : ''}`}>
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
              <b class="seat-cell">
                <Mark spec={champion.model} size={16} />
                <span>{modelName(champion.model)}</span>
              </b>
              <small>{formatTeamSlug(champion.team)}</small>
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
            <MatchMenu count={archive.liveSeries.length}>
              {archive.liveSeries.map((entry) => (
                <MatchMenuRow
                  key={entry.seriesId}
                  eyebrow={entry.round === null ? 'Match' : roundName(entry.round, archive.rounds.length)}
                  sides={([0, 1] as const).map((side) => {
                    const spec = entrantName(archive, entry.slots[side]);
                    return (
                      <span class="match-menu-side" key={side}>
                        {side === 1 && <i>vs</i>}
                        <Mark spec={spec} size={15} />
                        {modelName(spec)}
                      </span>
                    );
                  })}
                  state={
                    <>
                      Game {entry.game} · {entry.turn ? `Turn ${entry.turn}` : 'Team preview'}
                    </>
                  }
                  onWatch={entry.seriesIndex === null ? undefined : () => onOpenGame(entry.seriesIndex!, entry.game)}
                />
              ))}
            </MatchMenu>
          )}
          <EntrantTable archive={archive} />
        </>
      )}
    </section>
  );
}

export function TournamentsView({
  epoch,
  run,
  focusRun,
  onOpenRun,
}: {
  epoch: number;
  run: string | undefined;
  focusRun?: string;
  onOpenRun: (runId: string) => void;
}) {
  const [data, setData] = useState<TournamentsResponse | null>(null);
  const [error, setError] = useState('');
  const [openRun, setOpenRun] = useState(run ?? '');
  const [game, setGame] = useState<{ runId: string; seriesIndex: number; game: number } | null>(null);

  useEffect(() => setOpenRun(run ?? ''), [run]);

  useEffect(() => {
    api<TournamentsResponse>('/api/tournaments')
      .then((response) => {
        setData(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [epoch]);

  const archives = data?.tournaments ?? [];
  const anyLive = archives.some((archive) => archive.live);
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => {
      apiFresh<TournamentsResponse>('/api/tournaments')
        .then((response) => setData(response))
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [anyLive]);

  const summary = data?.summary ?? { tournaments: 0, matches: 0 };
  const finished = archives.filter((archive) => archive.complete);
  const latest = finished[0];
  const latestWinner = latest && latest.champion !== null ? latest.entrants[latest.champion] : null;

  if (game) {
    const archive = archives.find((entry) => entry.runId === game.runId);
    if (archive) {
      return (
        <TournamentGame
          archive={archive}
          seriesIndex={game.seriesIndex}
          game={game.game}
          onOpenGame={(seriesIndex, number) => setGame({ runId: game.runId, seriesIndex, game: number })}
          onBack={() => setGame(null)}
        />
      );
    }
  }

  if (focusRun) {
    const archive = archives.find((entry) => entry.runId === focusRun);
    return (
      <div class="league-view live-tournament-view">
        <header class="page-heading league-heading live-tournament-heading">
          <div>
            <p class="eyebrow">
              <span class="live-dot" aria-hidden="true" /> Live run / tournament
            </p>
            <h1>{archive?.event?.name || 'Live tournament'}</h1>
          </div>
          <p class="lede">
            The bracket and battle logs update live. Open a match to follow the field, model decisions, and turn-by-turn
            action.
          </p>
        </header>
        {error ? <div class="message error">Could not load the live tournament: {error}</div> : null}
        {!archive && !error ? (
          <section class="panel live-tournament-loading">
            <span class="live-dot" aria-hidden="true" /> Waiting for the bracket…
          </section>
        ) : null}
        {archive ? (
          <TournamentCard
            archive={archive}
            open={openRun === archive.runId}
            onToggle={() => setOpenRun(openRun === archive.runId ? '' : archive.runId)}
            onOpenGame={(seriesIndex, number) => setGame({ runId: archive.runId, seriesIndex, game: number })}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Records / tournaments</p>
          <h1>Tournaments</h1>
        </div>
        <p class="lede">
          Single-elimination brackets from local runs. Event pools keep their seeded slots while models are shuffled
          across teams. Each record keeps its own teams, schedule, and results.
        </p>
      </header>
      {error ? <div class="message error">Could not load the brackets: {error}</div> : null}
      {!data && !error ? <div class="archive-route-pending" aria-hidden="true" /> : null}
      {data ? (
        <>
          <div class="stat-row">
            <StatTile
              label="Brackets archived"
              value={String(summary.tournaments)}
              note={`${finished.length} finished, ${archives.length - finished.length} unresolved`}
            />
            <StatTile label="Series archived" value={String(summary.matches)} note="best-of-three series" />
            <StatTile
              label="Latest bracket winner"
              value={latestWinner ? modelName(latestWinner.model) : '–'}
              note={latestWinner ? formatTeamSlug(latestWinner.team) : 'no finished bracket yet'}
            />
          </div>
          {archives.length === 0 && !error ? (
            <section class="panel">
              <div class="results-empty">No tournaments recorded yet.</div>
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
        </>
      ) : null}
    </div>
  );
}
