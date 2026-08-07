import type { BracketEntrantView } from '../../api';
import { modelName } from '../lib/labels';
import { Mark } from './mark';

export interface BracketMatchLike {
  seriesIndex: number | null;
  slots: [number | null, number | null];
  winner: number | null;
}

export function roundName(index: number, count: number): string {
  const fromEnd = count - 1 - index;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${index + 1}`;
}

function seedLabel(entrant: BracketEntrantView | undefined): string {
  const place = entrant?.placement ?? entrant?.seed ?? null;
  return place === null ? '' : `#${place}`;
}

export function BracketGrid<M extends BracketMatchLike>({
  entrants,
  rounds,
  scoreFor,
  selected,
  onSelect,
  live,
}: {
  entrants: BracketEntrantView[];
  rounds: M[][];
  scoreFor: (match: M, side: 0 | 1) => string;
  selected?: number | null;
  onSelect?: (index: number) => void;
  live?: ReadonlySet<number>;
}) {
  const firstRound = rounds[0]?.length ?? 1;
  return (
    <div class="bracket-scroll">
      <div class="bracket" style={{ gridTemplateRows: `auto repeat(${firstRound}, 1fr)` }}>
        {rounds.map((round, roundIndex) => (
          <div class="bracket-round" key={roundIndex}>
            <h3 style={{ gridColumn: roundIndex + 1 }}>{roundName(roundIndex, rounds.length)}</h3>
            {round.map((match, matchIndex) => {
              const span = Math.max(1, Math.round(firstRound / round.length));
              const feeds = roundIndex < rounds.length - 1;
              const cell = `bracket-cell ${roundIndex > 0 ? 'has-source' : ''} ${
                feeds ? `has-target ${matchIndex % 2 === 0 ? 'pair-top' : 'pair-bottom'}` : ''
              }`;
              const place = {
                gridColumn: roundIndex + 1,
                gridRow: `${2 + matchIndex * span} / span ${span}`,
              };
              const bye = match.seriesIndex === null;
              const running = match.seriesIndex !== null && live?.has(match.seriesIndex) === true;
              const clickable = !bye && onSelect !== undefined;
              const slots = ([0, 1] as const).map((side) => {
                const slot = match.slots[side];
                const entrant = slot === null ? undefined : entrants[slot];
                const seed = seedLabel(entrant);
                return (
                  <span
                    class={`bracket-slot ${match.winner !== null && slot === match.winner ? 'winner' : ''}`}
                    key={side}
                  >
                    {seed && <em class="bracket-seed">{seed}</em>}
                    <span class="bracket-name">
                      {entrant && <Mark spec={entrant.model} size={13} />}
                      <b>{bye && slot === null ? 'Bye' : modelName(entrant?.model || 'TBD')}</b>
                    </span>
                    <span class="bracket-score">{scoreFor(match, side)}</span>
                    {entrant?.team && <small>{entrant.team}</small>}
                  </span>
                );
              });
              const className = `bracket-match ${bye ? 'bye' : ''} ${running ? 'live' : ''} ${
                clickable && selected === match.seriesIndex ? 'selected' : ''
              }`;
              const banner = running && (
                <span class="bracket-live">
                  <span class="live-dot" aria-hidden="true" /> Live
                </span>
              );
              return (
                <div key={matchIndex} class={cell} style={place}>
                  {roundIndex > 0 ? <span class="bracket-in" aria-hidden="true" /> : null}
                  {feeds ? <span class="bracket-out" aria-hidden="true" /> : null}
                  {clickable ? (
                    <button type="button" class={className} onClick={() => onSelect?.(match.seriesIndex!)}>
                      {banner}
                      {slots}
                    </button>
                  ) : (
                    <div class={`${className} archived`}>
                      {banner}
                      {slots}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
