import { useEffect, useState } from 'preact/hooks';

import type { TournamentArchiveView, TournamentSummary, TournamentsResponse } from '../../api';
import { StatTile, Tooltip, useTip } from '../components/chartkit';
import { Mark } from '../components/mark';
import { api } from '../http';

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

function roundName(index: number, count: number): string {
  const fromEnd = count - 1 - index;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${index + 1}`;
}

function ArchivedBracket({ archive }: { archive: TournamentArchiveView }) {
  const name = (slot: number | null) => (slot === null ? 'TBD' : (archive.entrants[slot]?.model ?? 'TBD'));
  const team = (slot: number | null) => (slot === null ? '' : (archive.entrants[slot]?.team ?? ''));
  return (
    <div class="bracket-scroll">
      <div class="bracket">
        {archive.rounds.map((round, roundIndex) => (
          <div class="bracket-round" key={roundIndex}>
            <h3>{roundName(roundIndex, archive.rounds.length)}</h3>
            {round.map((match, matchIndex) => {
              const bye = match.score === null && match.winner !== null && roundIndex === 0;
              return (
                <div key={matchIndex} class={`bracket-match archived ${bye ? 'bye' : ''}`}>
                  {([0, 1] as const).map((side) => (
                    <span
                      class={`bracket-slot ${match.winner !== null && match.slots[side] === match.winner ? 'winner' : ''}`}
                      key={side}
                    >
                      <span class="bracket-name">
                        {bye && match.slots[side] === null ? 'Bye' : name(match.slots[side])}
                      </span>
                      {team(match.slots[side]) && <small>{team(match.slots[side])}</small>}
                      <span class="bracket-score">{match.score ? match.score[side] : ''}</span>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function TournamentCard({
  archive,
  open,
  onToggle,
}: {
  archive: TournamentArchiveView;
  open: boolean;
  onToggle: () => void;
}) {
  const champion = archive.champion === null ? null : archive.entrants[archive.champion];
  return (
    <section class="panel tournament-card">
      <button type="button" class="tournament-card-head" onClick={onToggle} aria-expanded={open}>
        <div class="tournament-card-title">
          {champion ? (
            <>
              <span class="eyebrow">Champion</span>
              <b>
                <Mark spec={champion.model} size={16} /> {champion.model}
              </b>
              <small>{champion.team}</small>
            </>
          ) : (
            <>
              <span class="eyebrow">In progress</span>
              <b>Bracket unresolved</b>
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
      {open && <ArchivedBracket archive={archive} />}
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

  const summary = data?.summary ?? { tournaments: 0, matches: 0, standings: [] };
  const archives = data?.tournaments ?? [];
  const finished = archives.filter((archive) => archive.complete);
  const latest = finished[0];
  const reigning = latest && latest.champion !== null ? latest.entrants[latest.champion] : null;
  const titleLeader = summary.standings[0];
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Records / tournaments</p>
          <h1>Tournaments.</h1>
        </div>
        <p class="lede">
          Single-elimination archives: brackets, titles, and match records. Brackets never touch the rated Elo.
        </p>
      </header>
      {error ? <div class="message error">Could not load the brackets: {error}</div> : null}
      <div class="stat-row">
        <StatTile
          label="Brackets"
          value={String(summary.tournaments)}
          note={`${finished.length} finished, ${summary.tournaments - finished.length} unresolved`}
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
            open={openRun === archive.runId}
            onToggle={() => {
              const next = openRun === archive.runId ? '' : archive.runId;
              setOpenRun(next);
              onOpenRun(next);
            }}
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
