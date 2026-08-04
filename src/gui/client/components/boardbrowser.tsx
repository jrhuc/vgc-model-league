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

export interface DraftRecord {
  pick: number;
  entrant: number;
}

interface BoardGroup {
  key: string;
  title: string;
  cls: string;
  mons: DraftBoardMonView[];
}

function bandFor(cost: number): string {
  return COST_BANDS.find((band) => cost >= band.min && cost <= band.max)?.cls ?? 'c1';
}

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
  picks?: Map<string, DraftRecord>;
  coach: (entrant: number) => string;
}) {
  const [query, setQuery] = useState('');
  const [hideTaken, setHideTaken] = useState(false);
  const [order, setOrder] = useState<'cost' | 'pick'>('cost');
  const drafted = picks !== undefined && picks.size > 0;
  const byPick = drafted && order === 'pick';
  const { count, groups } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched: DraftBoardMonView[] = [];
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
      matched.push(mon);
    }
    if (!byPick) {
      const bands = COST_BANDS.map((band) => ({
        key: String(band.min),
        title: `${band.min}–${band.max} points`,
        cls: band.cls,
        mons: [] as DraftBoardMonView[],
      }));
      for (const mon of matched) {
        bands.find((group) => group.cls === bandFor(mon.cost))?.mons.push(mon);
      }
      return { count: matched.length, groups: bands.filter((group) => group.mons.length > 0) };
    }
    /** Snake rounds are the shape a draft is read in, so pick order groups by round rather than
     * running one 60-long list; seats come from the owner map because the board itself has none. */
    const seats = Math.max(
      0,
      ...[...owners.values()].map((entrant) => entrant + 1),
      ...[...(picks?.values() ?? [])].map((record) => record.entrant + 1),
    );
    const rounds = new Map<number, BoardGroup>();
    const undrafted: DraftBoardMonView[] = [];
    for (const mon of [...matched].sort((a, b) => (picks?.get(a.id)?.pick ?? 0) - (picks?.get(b.id)?.pick ?? 0))) {
      const record = picks?.get(mon.id);
      if (record === undefined) {
        undrafted.push(mon);
        continue;
      }
      const round = seats > 0 ? Math.ceil(record.pick / seats) : 1;
      const group = rounds.get(round) ?? {
        key: `round-${round}`,
        title: seats > 0 ? `Round ${round}` : 'Picks',
        cls: 'picked',
        mons: [],
      };
      group.mons.push(mon);
      rounds.set(round, group);
    }
    const ordered = [...rounds.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
    if (undrafted.length > 0) {
      ordered.push({ key: 'undrafted', title: 'Never drafted', cls: 'undrafted', mons: undrafted });
    }
    return { count: matched.length, groups: ordered };
  }, [board, owners, picks, query, hideTaken, byPick]);

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
        {drafted ? (
          <fieldset class="board-order">
            <legend class="visually-hidden">Board order</legend>
            <button type="button" class={order === 'cost' ? 'on' : ''} onClick={() => setOrder('cost')}>
              Cost
            </button>
            <button type="button" class={order === 'pick' ? 'on' : ''} onClick={() => setOrder('pick')}>
              Pick order
            </button>
          </fieldset>
        ) : null}
      </div>
      <div class="board-catalog">
        {groups.map((group) => (
          <section class="board-tier" key={group.key}>
            <header class={`board-tier-head ${group.cls}`}>
              <h3>{group.title}</h3>
              <b>{group.mons.length}</b>
            </header>
            <div class="board-grid">
              {group.mons.map((mon) => {
                const owner = owners.get(mon.id);
                const record = picks?.get(mon.id);
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
                      <span class={`board-cost ${bandFor(mon.cost)}`}>
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
                        {record !== undefined ? `Pick ${record.pick} · ` : ''}
                        Drafted by {coach(owner)}
                      </small>
                    ) : record !== undefined ? (
                      <small class="board-owner released">
                        Pick {record.pick} · {coach(record.entrant)} released it at free agency
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
