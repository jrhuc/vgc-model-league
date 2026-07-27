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
const STAT_LABELS: Record<(typeof STAT_ORDER)[number], string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

const COST_BANDS = [
  { min: 16, max: 20, cls: 'c16' },
  { min: 11, max: 15, cls: 'c11' },
  { min: 6, max: 10, cls: 'c6' },
  { min: 1, max: 5, cls: 'c1' },
] as const;
const EMPTY_OWNERS = new Map<string, number>();

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
  const { count, groups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const next = COST_BANDS.map((band) => ({ band, mons: [] as DraftBoardMonView[] }));
    let count = 0;
    for (const mon of board) {
      if (hideTaken && owners.has(mon.id)) continue;
      if (
        needle &&
        !mon.name.toLowerCase().includes(needle) &&
        !mon.types.some((type) => type.toLowerCase().includes(needle)) &&
        !mon.abilities.some((ability) => ability.toLowerCase().includes(needle))
      ) {
        continue;
      }
      const group = next.find(({ band }) => mon.cost >= band.min && mon.cost <= band.max);
      if (group) group.mons.push(mon);
      count += 1;
    }
    return { count, groups: next.filter((group) => group.mons.length > 0) };
  }, [board, owners, query, hideTaken]);

  return (
    <div class="board-browser">
      <div class="board-controls">
        <label class="board-search">
          <span class="visually-hidden">Search the draft board</span>
          <input
            type="search"
            placeholder="Search Pokémon, type or ability"
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="board-toggle">
          <input type="checkbox" checked={hideTaken} onChange={() => setHideTaken((value) => !value)} />
          Available only
        </label>
        <span class="board-count">
          <b>{count}</b> / {board.length}
        </span>
      </div>
      <div class="board-catalog">
        {groups.map(({ band, mons }) => (
          <section class="board-tier" key={band.min}>
            <header class={`board-tier-head ${band.cls}`}>
              <h3>
                {band.min}–{band.max} points
              </h3>
              <b>{mons.length}</b>
            </header>
            <div class="board-grid">
              {mons.map((mon) => {
                const owner = owners.get(mon.id);
                return (
                  <article class={`board-card ${owner !== undefined ? 'taken' : ''}`} key={mon.id}>
                    <div class="board-card-head">
                      <Sprite id={mon.spriteId} size={46} />
                      <div class="board-identity">
                        <b>{mon.name}</b>
                        <div class="board-types">
                          {mon.types.map((type) => (
                            <span class={`type-chip t-${type.toLowerCase()}`} key={type}>
                              {type}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span class={`board-cost ${band.cls}`}>
                        {mon.cost}
                        <small>pts</small>
                      </span>
                    </div>
                    <div class="board-stats">
                      {STAT_ORDER.map((stat) => (
                        <span key={stat}>
                          <small>{STAT_LABELS[stat]}</small>
                          {mon.baseStats[stat] ?? 0}
                        </span>
                      ))}
                    </div>
                    <small class="board-abilities">{mon.abilities.join(' · ')}</small>
                    {mon.item ? <small class="board-locked">Mega Stone · {mon.item}</small> : null}
                    {owner !== undefined ? <small class="board-owner">Drafted by {coach(owner)}</small> : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {count === 0 ? <p class="board-empty">No board entries match this search.</p> : null}
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
  const [result, setResult] = useState<{ id: string; board: BoardResponse | null; error: string }>({
    id: '',
    board: null,
    error: '',
  });
  useEffect(() => {
    if (!boardId || !active) return;
    let live = true;
    setResult({ id: boardId, board: null, error: '' });
    api<BoardResponse>(`/api/board?id=${encodeURIComponent(boardId)}`)
      .then((board) => {
        if (live) setResult({ id: boardId, board, error: '' });
      })
      .catch((cause: unknown) => {
        if (live) {
          setResult({
            id: boardId,
            board: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [boardId, active]);
  return result.id === boardId ? result : { id: boardId, board: null, error: '' };
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
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Draft room</p>
          <h1>Draft board.</h1>
        </div>
        <p class="lede">Every legal pick with its point cost, typing, base stats and abilities.</p>
      </header>
      <section class="panel board-panel">
        <div class="section-head">
          <div>
            <h2>{summary ? `Board ${summary.id}` : 'Draft board'}</h2>
            <p>
              {summary
                ? `${summary.monCount} entries · ${summary.budget}-point budget · ${summary.picks} picks per coach · up to ${summary.maxEntrants} coaches`
                : 'No draft board is installed.'}
            </p>
          </div>
        </div>
        <p class="board-callout">
          No draft is running. Start one from <b>New run</b>; rosters, pick reasoning and match builds will appear here.
        </p>
        {error ? <p class="empty-note">Could not load the board: {error}</p> : null}
        {board ? <BoardBrowser board={board.mons} owners={EMPTY_OWNERS} coach={() => ''} /> : null}
      </section>
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
  const { board: fullBoard, error: boardError } = useBoard(draft?.boardId ?? '', active && Boolean(draft));
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
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Draft room / {PHASE_LABELS[draft.phase]}</p>
          <h1>Draft league.</h1>
        </div>
        <p class="lede">Rosters, pick rationales, matchup teambuilds and results for the current league.</p>
      </header>
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Franchises</h2>
            <p>
              Board {draft.boardId} · {draft.budget} points · {draft.picksPerEntrant} picks each
              {draft.phase === 'roundrobin' ? ` · week ${draft.week} of ${draft.weeks}` : ''}
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
                  {spent(entrant)}/{draft.budget} pts
                </span>
              </div>
              <ol class="franchise-roster">
                {(draft.rosters[entrant] ?? []).map((id) => {
                  const mon = byId.get(id);
                  return (
                    <li key={id}>
                      <Sprite id={mon?.spriteId ?? ''} size={22} />
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

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Board &amp; picks</h2>
            <p>Availability across the board, plus the pick log.</p>
          </div>
        </div>
        {boardError ? <p class="empty-note">Could not load the board: {boardError}</p> : null}
        {active && fullBoard ? (
          <BoardBrowser board={fullBoard.mons} owners={owners} coach={(entrant) => coachLabel(draft, entrant)} />
        ) : null}
        {recent.length > 0 ? (
          <div class="draft-feed">
            <h3>Pick log</h3>
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
        ) : null}
      </section>
    </div>
  );
}
