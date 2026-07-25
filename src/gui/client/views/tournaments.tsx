import { useEffect, useState } from 'preact/hooks';

import type { TournamentArchiveView, TournamentSummary, TournamentsResponse } from '../../api';
import { StatTile, Tooltip, useTip } from '../components/chartkit';
import { Dropdown } from '../components/dropdown';
import { api } from '../http';

const PLACEMENTS = [
  { key: 'titles', label: 'Champion', color: '#08245f' },
  { key: 'runnerUp', label: 'Lost the final', color: '#1458e6' },
  { key: 'semis', label: 'Lost a semi', color: '#7da3f0' },
  { key: 'earlier', label: 'Earlier exit', color: '#cfdcf8' },
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

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
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
              <b>{champion.model}</b>
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

export function TournamentsView({ active, epoch }: { active: boolean; epoch: number }) {
  const [data, setData] = useState<TournamentsResponse | null>(null);
  const [pool, setPool] = useState('');
  const [openRun, setOpenRun] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    const query = pool ? `?pool=${encodeURIComponent(pool)}` : '';
    api<TournamentsResponse>(`/api/tournaments${query}`)
      .then((response) => {
        setData(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, epoch, pool]);

  const summary = data?.summary ?? { tournaments: 0, matches: 0, standings: [] };
  const archives = data?.tournaments ?? [];
  const completed = archives.filter((archive) => archive.complete);
  const latest = completed[0];
  const reigning = latest && latest.champion !== null ? latest.entrants[latest.champion] : null;
  const leader = summary.standings[0];
  const poolOptions = [
    { value: '', label: 'Overall', description: 'All pools except the test pool' },
    ...(data?.pools ?? []).map((name) => ({ value: name, label: name })),
  ];
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Tournaments / {pool || 'overall'}</p>
          <h1>
            Who takes
            <br />
            the bracket?
          </h1>
        </div>
        <p class="lede">
          Single-elimination best-of-three, every bracket archived with its champion. Tournaments never touch the
          controlled Elo — rotation carries the rating — but titles, finals, and match records all live here.
        </p>
      </div>
      <div class="filter-row">
        <div style="min-width:220px">
          <Dropdown id="tournamentsPool" label="Scope" options={poolOptions} value={pool} onChange={setPool} />
        </div>
        <p class="kicker">
          {error ||
            (data
              ? `${summary.tournaments} bracket${summary.tournaments === 1 ? '' : 's'} · ${summary.matches} matches recorded.`
              : 'Loading tournaments...')}
        </p>
      </div>
      <div class="stat-row">
        <StatTile
          label="Brackets"
          value={String(summary.tournaments)}
          note={`${completed.length} finished, ${summary.tournaments - completed.length} unresolved`}
        />
        <StatTile label="Matches" value={String(summary.matches)} note="best-of-three series" />
        <StatTile
          label="Reigning champion"
          value={reigning ? reigning.model : '–'}
          note={reigning ? reigning.team : 'no finished bracket yet'}
        />
        <StatTile
          label="Most titles"
          value={leader && leader.titles > 0 ? leader.spec : '–'}
          note={
            leader && leader.titles > 0
              ? `${leader.titles} title${leader.titles === 1 ? '' : 's'}`
              : 'trophy case is open'
          }
        />
      </div>
      {archives.length === 0 ? (
        <section class="panel">
          <div class="results-empty">
            No tournaments recorded yet. Start one from the New run tab — the whole bracket lands here when it ends.
          </div>
        </section>
      ) : (
        archives.map((archive) => (
          <TournamentCard
            key={archive.runId}
            archive={archive}
            open={openRun === archive.runId}
            onToggle={() => setOpenRun(openRun === archive.runId ? '' : archive.runId)}
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
                      {row.spec}
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
    </>
  );
}
