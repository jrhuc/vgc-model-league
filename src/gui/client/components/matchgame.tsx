import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { LeagueGameResponse, TeambuildSetView } from '../../api';
import { api, apiFresh } from '../http';
import { latestFallback } from '../lib/labels';
import { Battlefield } from './battlefield';
import { GameReflections, GameTimeline } from './gamelog';
import { TeamLineup } from './lineup';
import { Mark } from './mark';

export type StoredGameView = LeagueGameResponse & { receivedAt: number };

export function useMatchGame(path: string, pollingMs: number): { view: StoredGameView | null; error: string } {
  const [view, setView] = useState<StoredGameView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    setView(null);
    api<LeagueGameResponse>(path)
      .then((response) => {
        if (!current) return;
        setView({ ...response, receivedAt: Date.now() });
        setError('');
      })
      .catch((failure: Error) => {
        if (current) setError(failure.message);
      });
    return () => {
      current = false;
    };
  }, [path]);

  useEffect(() => {
    if (!view?.live) return;
    const timer = setInterval(() => {
      apiFresh<LeagueGameResponse>(path)
        .then((response) => setView({ ...response, receivedAt: Date.now() }))
        .catch(() => {});
    }, pollingMs);
    return () => clearInterval(timer);
  }, [view?.live, path, pollingMs]);

  return { view, error };
}

export function MatchGame({
  view,
  eyebrow,
  titles,
  players,
  details,
  teams,
  onOpenGame,
  actions,
}: {
  view: StoredGameView;
  eyebrow: ComponentChildren;
  titles: [string, string];
  players: [string, string];
  details?: [string, string];
  teams: [Array<TeambuildSetView> | undefined, Array<TeambuildSetView> | undefined];
  onOpenGame: (game: number) => void;
  actions?: ComponentChildren;
}) {
  const score: [number, number] = [
    view.gameWinners.filter((winner) => winner === view.sides[0]).length,
    view.gameWinners.filter((winner) => winner === view.sides[1]).length,
  ];
  const winnerName = view.winner === view.sides[0] ? titles[0] : view.winner === view.sides[1] ? titles[1] : '';
  const { decisions, reflections, snapshot } = view;
  const seriesOver = reflections.some((reflection) => reflection.seriesOver);
  const hasTeams = teams.some((team) => team && team.length > 0);
  const chipSide = (winner: number | null): string =>
    winner === view.sides[0] ? 'left' : winner === view.sides[1] ? 'right' : '';

  return (
    <div class="league-view">
      <header class="page-heading league-heading match-game-heading">
        <p class="eyebrow">{eyebrow}</p>
        <h1 class="matchup-heading">
          <span class="matchup-side">
            <span class="matchup-copy">
              <b>
                <Mark spec={players[0]} size={22} />
                <span>{titles[0]}</span>
              </b>
              {details?.[0] ? <small>{details[0]}</small> : null}
            </span>
          </span>
          <span class="matchup-versus" aria-hidden="true">
            vs
          </span>
          <span class="matchup-side right">
            <span class="matchup-copy">
              <b>
                <span>{titles[1]}</span>
                <Mark spec={players[1]} size={22} />
              </b>
              {details?.[1] ? <small>{details[1]}</small> : null}
            </span>
          </span>
        </h1>
        <div class="match-game-meta">
          <span>
            {view.live ? <span class="live-dot" aria-hidden="true" /> : null} Game {view.game} of {view.games.length}
            {winnerName ? ` · ${winnerName} won` : view.live ? ' · in progress' : ' · no winner recorded'}
            {score[0] + score[1] > 0 ? ` · series ${score[0]}–${score[1]}` : ''}
          </span>
          <span class="game-switcher">
            {view.games.map((number, index) => (
              <button
                key={number}
                type="button"
                class={`game-chip ${chipSide(view.gameWinners[index] ?? null)} ${number === view.game ? 'on' : ''}`}
                onClick={() => onOpenGame(number)}
              >
                {number}
              </button>
            ))}
            {actions}
          </span>
        </div>
      </header>

      {snapshot ? (
        <section class="panel battlefield">
          <Battlefield
            snapshot={snapshot}
            receivedAt={view.receivedAt}
            players={{ p1: players[0], p2: players[1] }}
            labels={{ p1: titles[0], p2: titles[1] }}
            warnings={{
              p1: latestFallback(decisions, (d) => d.side === 0),
              p2: latestFallback(decisions, (d) => d.side === 1),
            }}
            teams={{ p1: teams[0], p2: teams[1] }}
            meta={<span class="turn-badge">{snapshot.turn ? `Turn ${snapshot.turn}` : 'Team preview'}</span>}
          />
        </section>
      ) : view.live && view.winner === null ? (
        <section class="panel battlefield">
          <div class="field-surface">
            <div class="field-empty" aria-live="polite">
              <h2>Battle starting</h2>
              <p>Waiting for the first team-preview event.</p>
            </div>
          </div>
        </section>
      ) : hasTeams ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>The teams they brought</h2>
              <p>The six each side brought for this series, with the sets from the open team sheet.</p>
            </div>
          </div>
          <TeamLineup
            sides={[
              { key: 'p1', model: players[0], label: titles[0], team: teams[0] },
              { key: 'p2', model: players[1], label: titles[1], team: teams[1] },
            ]}
          />
        </section>
      ) : null}

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Turn by turn</h2>
            <p>Both sides’ choices with their recorded reasoning, then what the simulator resolved.</p>
          </div>
        </div>
        <GameTimeline decisions={decisions} log={view.log} names={titles} />
      </section>

      {reflections.length > 0 ? (
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>{seriesOver ? 'Series reflections' : 'Post-game reflections'}</h2>
              <p>
                {seriesOver
                  ? 'What each side learned from the series and would change in a rematch.'
                  : 'What each side took from this game and plans to change in the next.'}
              </p>
            </div>
          </div>
          <GameReflections
            reflections={reflections}
            names={titles}
            notebookLabel={seriesOver ? 'Notes for a rematch' : 'Notebook carried forward'}
          />
        </section>
      ) : null}
    </div>
  );
}
