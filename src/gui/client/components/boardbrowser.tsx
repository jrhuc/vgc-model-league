import { useEffect, useMemo, useState } from 'preact/hooks';

import type { BoardResponse, DraftBoardMonView } from '../../api';
import { api } from '../http';
import { Sprite } from './sprite';

export const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export const STAT_LABELS: Record<(typeof STAT_ORDER)[number], string> = {
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

export function useBoard(boardId: string) {
  const [result, setResult] = useState<{ id: string; board: BoardResponse | null; error: string }>({
    id: '',
    board: null,
    error: '',
  });
  useEffect(() => {
    if (!boardId) return;
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
  }, [boardId]);
  return result.id === boardId ? result : { id: boardId, board: null, error: '' };
}

export function BoardBrowser({
  board,
  owners,
  picks,
  coach,
}: {
  board: DraftBoardMonView[];
  owners: Map<string, number>;
  picks?: Map<string, number>;
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
        {owners.size > 0 ? (
          <label class="board-toggle">
            <input type="checkbox" checked={hideTaken} onChange={() => setHideTaken((value) => !value)} />
            Available only
          </label>
        ) : null}
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
                const pick = picks?.get(mon.id);
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
                    {owner !== undefined ? (
                      <small class="board-owner">
                        {pick !== undefined ? `Pick ${pick} · ` : ''}
                        Drafted by {coach(owner)}
                      </small>
                    ) : null}
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
