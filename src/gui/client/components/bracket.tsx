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

export function entrantLabel(entrant: BracketEntrantView | undefined): string {
  if (!entrant) return 'TBD';
  return entrant.model || 'TBD';
}

export function seedLabel(entrant: BracketEntrantView | undefined): string {
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
  return (
    <div class="bracket-scroll">
      <div class="bracket">
        {rounds.map((round, roundIndex) => (
          <div class="bracket-round" key={roundIndex}>
            <h3>{roundName(roundIndex, rounds.length)}</h3>
            {round.map((match, matchIndex) => {
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
                      <b>{bye && slot === null ? 'Bye' : modelName(entrantLabel(entrant))}</b>
                    </span>
                    <span class="bracket-score">{scoreFor(match, side)}</span>
                    {entrant?.team && <small>{entrant.team}</small>}
                  </span>
                );
              });
              const className = `bracket-match ${bye ? 'bye' : ''} ${running ? 'live' : ''} ${
                clickable && selected === match.seriesIndex ? 'selected' : ''
              }`;
              return clickable ? (
                <button type="button" key={matchIndex} class={className} onClick={() => onSelect?.(match.seriesIndex!)}>
                  {running && (
                    <span class="bracket-live">
                      <span class="live-dot" aria-hidden="true" /> Live
                    </span>
                  )}
                  {slots}
                </button>
              ) : (
                <div key={matchIndex} class={`${className} archived`}>
                  {running && (
                    <span class="bracket-live">
                      <span class="live-dot" aria-hidden="true" /> Live
                    </span>
                  )}
                  {slots}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
