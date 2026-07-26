import { useEffect, useMemo, useState } from 'preact/hooks';

import type { AppState, BoardResponse, DraftBoardMonView, DraftView, RunSnapshot, TeambuildView } from '../../api';
import { Sprite } from '../components/sprite';
import { api } from '../http';

const PHASE_LABELS: Record<DraftView['phase'], string> = {
  draft: 'Drafting',
  roundrobin: 'Round robin',
  playoffs: 'Playoffs',
  done: 'Complete',
};

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

function coachLabel(draft: DraftView, entrant: number): string {
  return draft.teamNames[entrant] || draft.entrants[entrant] || `Coach ${entrant + 1}`;
}

function BoardBrowser({
  board,
  owners,
  coach,
}: {
  board: DraftBoardMonView[];
  owners: Map<string, number>;
  coach: (entrant: number) => string;
}) {
  const [query, setQuery] = useState('');
  const [hideTaken, setHideTaken] = useState(false);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return board.filter((mon) => {
      if (hideTaken && owners.has(mon.id)) return false;
      if (!needle) return true;
      return (
        mon.name.toLowerCase().includes(needle) ||
        mon.types.some((type) => type.toLowerCase().includes(needle)) ||
        mon.abilities.some((ability) => ability.toLowerCase().includes(needle))
      );
    });
  }, [board, owners, query, hideTaken]);

  return (
    <div class="board-browser">
      <div class="board-controls">
        <input
          type="search"
          placeholder="Filter by name, type or ability"
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
        <label class="board-toggle">
          <input type="checkbox" checked={hideTaken} onChange={() => setHideTaken((value) => !value)} />
          Hide drafted
        </label>
        <span class="muted">
          {filtered.length} of {board.length}
        </span>
      </div>
      <div class="board-grid">
        {filtered.map((mon) => {
          const owner = owners.get(mon.id);
          return (
            <div class={`board-card ${owner !== undefined ? 'taken' : ''}`} key={mon.id}>
              <div class="board-card-head">
                <Sprite id={mon.spriteId} name={mon.name} size={32} />
                <b>{mon.name}</b>
                <span class="board-cost">{mon.cost}</span>
              </div>
              <div class="board-types">
                {mon.types.map((type) => (
                  <span class={`type-chip t-${type.toLowerCase()}`} key={type}>
                    {type}
                  </span>
                ))}
              </div>
              <div class="board-stats">
                {STAT_ORDER.map((stat) => (
                  <span key={stat}>{mon.baseStats[stat] ?? 0}</span>
                ))}
              </div>
              <small class="board-abilities">{mon.abilities.join(' / ')}</small>
              {mon.item ? <small class="board-locked">locked to {mon.item}</small> : null}
              {mon.usage ? (
                <small class="board-note" title={`listed at ${mon.listed} on the Wolfey board`}>
                  re-priced from {mon.listed} · {mon.usage}
                </small>
              ) : mon.anchor ? (
                <small class="board-note">Reg M-B addition · {mon.anchor}</small>
              ) : null}
              {owner !== undefined ? <small class="board-owner">{coach(owner)}</small> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TeambuildCard({ build, draft }: { build: TeambuildView; draft: DraftView }) {
  const repaired = build.sets.filter((set) => set.repaired).length;
  return (
    <details class="teambuild-card">
      <summary>
        <b>{coachLabel(draft, build.entrant)}</b> vs {coachLabel(draft, build.opponent)}
        <span class="muted">
          {' '}
          · {build.attempts} attempt{build.attempts === 1 ? '' : 's'}
          {repaired ? ` · ${repaired} repaired` : ''}
        </span>
      </summary>
      <p class="teambuild-plan">{build.rationale}</p>
      <div class="teambuild-sets">
        {build.sets.map((set, index) => (
          <div class={`teambuild-set ${set.repaired ? 'repaired' : ''}`} key={`${set.species}-${index}`}>
            <div class="teambuild-set-head">
              <Sprite id={set.spriteId} name={set.species} size={26} />
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
            {set.repairs.length > 0 && (
              <ul class="teambuild-repairs">
                {set.repairs.map((repair) => (
                  <li key={repair}>{repair}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function useBoard(boardId: string, active: boolean) {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!boardId || !active) return;
    let live = true;
    api<BoardResponse>(`/api/board?id=${encodeURIComponent(boardId)}`)
      .then((data) => live && setBoard(data))
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      live = false;
    };
  }, [boardId, active]);
  return { board, error };
}

function BoardOnly({
  boardId,
  summary,
  active,
}: {
  boardId: string;
  summary: AppState['boards'][number] | undefined;
  active: boolean;
}) {
  const { board, error } = useBoard(boardId, active);

  return (
    <div class="panel">
      <div class="section-head">
        <div>
          <h2>Draft league</h2>
          <p>
            {summary
              ? `Board ${summary.id} · ${summary.monCount} entries · ${summary.budget} points · ${summary.picks} picks each · up to ${summary.maxEntrants} coaches`
              : 'No draft board is installed.'}
          </p>
        </div>
      </div>
      <p class="empty-note">
        Start a draft league from <b>New run</b> to watch the draft, the teambuilds and the season here.
      </p>
      {board?.source ? <p class="board-source">{board.source}</p> : null}
      {error ? <p class="empty-note">Could not load the board: {error}</p> : null}
      {board ? <BoardBrowser board={board.mons} owners={new Map()} coach={() => ''} /> : null}
    </div>
  );
}

export function LeagueView({
  app,
  run,
  active,
}: {
  app: AppState;
  run: RunSnapshot | null | undefined;
  active: boolean;
}) {
  const draft = run?.mode === 'draft' ? run.draft : null;
  const summary = app.boards.find((info) => info.id === (draft?.boardId ?? app.boards[0]?.id ?? ''));
  const { board: fullBoard } = useBoard(draft?.boardId ?? '', active && Boolean(draft));
  const byId = useMemo(() => new Map((fullBoard?.mons ?? []).map((mon) => [mon.id, mon] as const)), [fullBoard]);
  const owners = useMemo(
    () => new Map((draft?.picks ?? []).map((pick) => [pick.mon, pick.entrant] as const)),
    [draft?.picks],
  );

  if (!draft) {
    return <BoardOnly boardId={summary?.id ?? ''} summary={summary} active={active} />;
  }

  const recent = [...draft.picks].reverse();
  const spent = (entrant: number) => draft.budget - (draft.budgets[entrant] ?? 0);
  return (
    <div class="league-view">
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Draft league</h2>
            <p>
              Board {draft.boardId} · {draft.budget} points · {draft.picksPerEntrant} picks each
              {draft.weeks ? ` · week ${draft.week} of ${draft.weeks}` : ''}
            </p>
          </div>
          <span class="phase-pill">{PHASE_LABELS[draft.phase]}</span>
        </div>

        <div class="franchise-grid">
          {draft.entrants.map((model, entrant) => (
            <div class="franchise" key={entrant}>
              <div class="franchise-head">
                <span class="contender-code">{String.fromCharCode(65 + entrant)}</span>
                <div>
                  <b>{coachLabel(draft, entrant)}</b>
                  <small>{model}</small>
                </div>
                <span class="muted">
                  {spent(entrant)}/{draft.budget}
                </span>
              </div>
              <ol class="franchise-roster">
                {(draft.rosters[entrant] ?? []).map((id) => {
                  const mon = byId.get(id);
                  return (
                    <li key={id}>
                      <Sprite id={mon?.spriteId ?? ''} name={mon?.name ?? id} size={22} />
                      <span>{mon?.name ?? id}</span>
                      <span class="muted">{mon?.cost}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>

        {draft.table && (
          <table class="draft-table">
            <thead>
              <tr>
                <th>Seed</th>
                <th>Franchise</th>
                <th>W-L</th>
                <th>Games</th>
              </tr>
            </thead>
            <tbody>
              {draft.table.map((row, rank) => (
                <tr key={row.entrant}>
                  <td>{rank + 1}</td>
                  <td>{coachLabel(draft, row.entrant)}</td>
                  <td>
                    {row.w}-{row.l}
                  </td>
                  <td>
                    {row.gw}-{row.gl}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {draft.teambuilds.length > 0 && (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Teambuilds</h2>
              <p>The six each coach brought, and the sets they wrote for this matchup.</p>
            </div>
          </div>
          <div class="teambuild-list">
            {[...draft.teambuilds].reverse().map((build, index) => (
              <TeambuildCard build={build} draft={draft} key={`${build.seriesIndex}-${build.entrant}-${index}`} />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>Draft board</h2>
              <p>Every pick, with the rationale the coach gave for it.</p>
            </div>
          </div>
          {active && fullBoard ? (
            <BoardBrowser board={fullBoard.mons} owners={owners} coach={(entrant) => coachLabel(draft, entrant)} />
          ) : null}
          <div class="draft-feed">
            <h3>Picks</h3>
            {recent.map((pick) => (
              <div class="draft-feed-item" key={pick.pick}>
                <span class="draft-feed-head">
                  #{pick.pick} · {coachLabel(draft, pick.entrant)} → {byId.get(pick.mon)?.name ?? pick.mon}
                  {pick.fallback ? ' · fallback' : ''}
                </span>
                <p>{pick.rationale}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
