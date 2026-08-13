import { useEffect, useRef, useState } from 'preact/hooks';
import type { BattleLogEntryView, BattleView, BracketView, DecisionView, RunView, SeriesRowView } from '../../api';
import { Battlefield } from '../components/battlefield';
import { BracketGrid } from '../components/bracket';
import { Mark } from '../components/mark';
import { api } from '../http';
import { latestFallback } from '../lib/labels';

export type StoredBattle = BattleView & { receivedAt: number };

interface ArenaProps {
  run: RunView | null;
  externalRun: { runId: string; mode: 'draft' | 'tournament' } | null;
  battles: Record<number, StoredBattle>;
  selected: number | null;
  onSelect: (index: number) => void;
  onLoadGame: (index: number, game: number) => Promise<BattleView>;
  onFetchBattle: (index: number) => void;
  onGoFixtures: () => void;
  onOpenLeague: (runId: string) => void;
}

function elapsedText(run: RunView): string {
  const total = Math.max(0, Math.floor(((run.endTime ?? Date.now()) - run.startTime) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours ? `${hours}h ` : ''}${minutes}m ${total % 60}s`;
}

function rowState(row: SeriesRowView): string {
  if (row.status === 'running') return `Game ${Math.max(1, row.game)} · turn ${row.turn || 'preview'}`;
  if (row.status === 'done') return row.winner ? `Winner · ${row.winner}` : 'Series tied';
  return 'Queued';
}

function Bracket({
  bracket,
  rows,
  selected,
  onSelect,
}: {
  bracket: BracketView;
  rows: RunView['rows'];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const champion = bracket.champion === null ? null : bracket.entrants[bracket.champion];
  const live = new Set(
    bracket.rounds
      .flat()
      .filter((match) => match.seriesIndex !== null && rows[match.seriesIndex]?.status === 'running')
      .map((match) => match.seriesIndex!),
  );
  return (
    <section class="panel bracket-panel">
      <div class="section-head">
        <div>
          <h2>Bracket</h2>
          <p>
            {bracket.entrants.length === 2
              ? 'One best-of-three · each model brings its own team'
              : 'Single elimination · best-of-three · each model keeps its team'}
          </p>
        </div>
        {champion && (
          <div class="champion-banner">
            <span class="eyebrow">Champion</span>
            <b>{champion.model}</b>
            <small>{champion.team}</small>
          </div>
        )}
      </div>
      <BracketGrid
        entrants={bracket.entrants}
        rounds={bracket.rounds}
        scoreFor={(match, side) => {
          const row = match.seriesIndex === null ? null : rows[match.seriesIndex];
          return row ? String(side === 0 ? row.score.p1 : row.score.p2) : '';
        }}
        selected={selected}
        onSelect={onSelect}
        live={live}
      />
    </section>
  );
}

function usePinnedScroll(dependency: number, game: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    pinned.current = true;
  }, [game]);
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency, game]);
  const onScroll = (event: { currentTarget: HTMLDivElement }) => {
    const element = event.currentTarget;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };
  return { scroller, onScroll };
}

function decisionLabel(decision: DecisionView): string {
  if (decision.phase === 'team_preview') return `G${decision.game} · Preview`;
  if (decision.phase === 'forced_switch') return `T${decision.turn} · Switch`;
  return `T${decision.turn}`;
}

function DecisionFeed({
  decisions,
  players,
  game,
}: {
  decisions: DecisionView[];
  players: Record<string, string> | undefined;
  game: number;
}) {
  const { scroller, onScroll } = usePinnedScroll(decisions.length, game);
  return (
    <div
      class="turn-log-scroll"
      ref={scroller}
      onScroll={onScroll}
      role="tabpanel"
      id="arena-decisions-panel"
      aria-labelledby="arena-decisions-tab"
    >
      {decisions.length === 0 && <div class="log-line detail">No decisions yet.</div>}
      {decisions.map((decision, index) => (
        <div class={`decision-entry ${decision.pid}`} key={index}>
          <div class="decision-head">
            <span class="decision-turn">{decisionLabel(decision)}</span>
            <span class="decision-player">{players?.[decision.pid] ?? decision.pid}</span>
            {decision.fallback && <span class="decision-flag">fallback</span>}
            {decision.substituted && <span class="decision-flag">substituted</span>}
            {decision.automatic && <span class="decision-flag auto">forced</span>}
          </div>
          <div class="decision-selection">{decision.selection.join(' · ')}</div>
          {!decision.automatic && decision.rationale && <div class="decision-rationale">{decision.rationale}</div>}
          {decision.fallback && decision.error && <div class="decision-error">{decision.error}</div>}
        </div>
      ))}
    </div>
  );
}

function TurnLog({
  log,
  decisions,
  players,
  game,
  games,
  onSelectGame,
}: {
  log: BattleLogEntryView[];
  decisions: DecisionView[];
  players: Record<string, string> | undefined;
  game: number;
  games: number[];
  onSelectGame: (game: number) => void;
}) {
  const [tab, setTab] = useState<'log' | 'decisions'>('log');
  const logTabRef = useRef<HTMLButtonElement>(null);
  const decisionsTabRef = useRef<HTMLButtonElement>(null);
  const { scroller, onScroll } = usePinnedScroll(log.length, game);

  const focusTab = (next: 'log' | 'decisions') => {
    setTab(next);
    const target = next === 'log' ? logTabRef.current : decisionsTabRef.current;
    target?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(tab === 'log' ? 'decisions' : 'log');
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusTab('log');
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusTab('decisions');
    }
  };

  return (
    <div class="turn-log">
      <div class="turn-log-head">
        <div class="log-tabs" role="tablist" aria-label="Battle detail">
          <button
            type="button"
            role="tab"
            id="arena-log-tab"
            ref={logTabRef}
            aria-controls="arena-log-panel"
            aria-selected={tab === 'log'}
            tabIndex={tab === 'log' ? 0 : -1}
            class={`log-tab ${tab === 'log' ? 'active' : ''}`}
            onClick={() => focusTab('log')}
            onKeyDown={onTabKeyDown}
          >
            Turn log
          </button>
          <button
            type="button"
            role="tab"
            id="arena-decisions-tab"
            ref={decisionsTabRef}
            aria-controls="arena-decisions-panel"
            aria-selected={tab === 'decisions'}
            tabIndex={tab === 'decisions' ? 0 : -1}
            class={`log-tab ${tab === 'decisions' ? 'active' : ''}`}
            onClick={() => focusTab('decisions')}
            onKeyDown={onTabKeyDown}
          >
            Decisions{decisions.length ? ` (${decisions.length})` : ''}
          </button>
        </div>
        {games.length > 1 ? (
          <select
            class="game-select"
            aria-label="Show log for game"
            value={String(game)}
            onChange={(event) => onSelectGame(Number(event.currentTarget.value))}
          >
            {games.map((option) => (
              <option key={option} value={String(option)}>
                Game {option}
              </option>
            ))}
          </select>
        ) : (
          <span>Game {game}</span>
        )}
      </div>
      {tab === 'decisions' ? (
        <div role="tabpanel" id="arena-decisions-panel" aria-labelledby="arena-decisions-tab">
          <DecisionFeed decisions={decisions} players={players} game={game} />
        </div>
      ) : (
        <div
          class="turn-log-scroll"
          ref={scroller}
          onScroll={onScroll}
          role="tabpanel"
          id="arena-log-panel"
          aria-labelledby="arena-log-tab"
        >
          {log.length === 0 && <div class="log-line detail">Waiting for the first events.</div>}
          {log.map((entry, index) =>
            entry.kind === 'turn' ? (
              <div class="log-turn" key={index}>
                <span>{entry.text}</span>
              </div>
            ) : (
              <div class={`log-line ${entry.kind}`} key={index}>
                {entry.text}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function ArenaView({
  run,
  externalRun,
  battles,
  selected,
  onSelect,
  onLoadGame,
  onFetchBattle,
  onGoFixtures,
  onOpenLeague,
}: ArenaProps) {
  const [stopError, setStopError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [resumeError, setResumeError] = useState('');
  const [resuming, setResuming] = useState(false);
  const [pastGame, setPastGame] = useState<StoredBattle | null>(null);

  useEffect(() => {
    setStopError('');
    setStopping(false);
    setResumeError('');
    setResuming(false);
  }, [run?.runId]);

  useEffect(() => {
    setPastGame(null);
  }, [selected, run?.runId]);

  useEffect(() => {
    if (!run) return;
    const liveIndex = run.rows.findIndex((row) => row.status === 'running');
    const shown =
      selected !== null && selected < run.rows.length
        ? selected
        : liveIndex >= 0
          ? liveIndex
          : run.rows.length
            ? 0
            : null;
    if (shown !== null && !battles[shown]) onFetchBattle(shown);
  }, [run, selected, battles]);

  if (!run) {
    if (externalRun) {
      return (
        <div class="panel no-run">
          <div class="no-run-inner">
            <div class="no-run-mark">
              <span class="live-dot" aria-hidden="true" />
            </div>
            <p class="eyebrow">League in progress</p>
            <h1>A draft league is already in progress</h1>
            <p class="lede">Follow the draft board, teambuilds, and series as they are recorded.</p>
            <button
              type="button"
              class="button primary"
              style="margin-top:22px"
              onClick={() => onOpenLeague(externalRun.runId)}
            >
              Watch the league
            </button>
          </div>
        </div>
      );
    }
    return (
      <div class="panel no-run">
        <div class="no-run-inner">
          <div class="no-run-mark">VS</div>
          <p class="eyebrow">No active run</p>
          <h1>No run in progress</h1>
          <p class="lede">Set up a run first. Showdown turns appear here while it runs.</p>
          <button type="button" class="button primary" style="margin-top:22px" onClick={onGoFixtures}>
            Set up a run
          </button>
        </div>
      </div>
    );
  }

  const liveIndex = run.rows.findIndex((row) => row.status === 'running');
  const effective =
    selected !== null && selected < run.rows.length
      ? selected
      : liveIndex >= 0
        ? liveIndex
        : run.rows.length
          ? 0
          : null;
  const row = effective === null ? null : (run.rows[effective] ?? null);
  const entry = effective === null ? null : battles[effective];
  const battle = entry && pastGame?.index === effective && pastGame.game !== entry.game ? pastGame : entry;
  const viewGame = (game: number) => {
    if (effective === null || !entry) return;
    if (game === entry.game) {
      setPastGame(null);
      return;
    }
    onLoadGame(effective, game)
      .then((message) => {
        if (message.snapshot) setPastGame({ ...message, receivedAt: Date.now() });
      })
      .catch(() => {});
  };
  const done = run.rows.filter((item) => item.status === 'done').length;
  const total = run.rows.length;
  const runKind =
    run.mode === 'tournament'
      ? run.bracket?.entrants.length === 2 && !run.pool
        ? 'Match'
        : 'Tournament'
      : run.mode === 'draft'
        ? 'Draft league'
        : 'Rotation';

  const active = run.state === 'running' || run.state === 'paused';
  const stop = () => {
    setStopError('');
    setStopping(true);
    api('/api/run/stop', {})
      .catch((error: Error) => setStopError(error.message))
      .finally(() => setStopping(false));
  };
  const resume = () => {
    setResumeError('');
    setResuming(true);
    api('/api/run/resume', {})
      .catch((error: Error) => setResumeError(error.message))
      .finally(() => setResuming(false));
  };
  const title =
    run.state === 'running'
      ? 'Run in progress'
      : run.state === 'paused'
        ? 'Run paused'
        : run.state === 'done'
          ? 'Run complete'
          : run.state === 'stopped'
            ? 'Run stopped'
            : 'Run failed';

  return (
    <div>
      <div class="arena-topline">
        <div>
          <p class="eyebrow">
            {runKind} · protocol v{run.protocolVersion} · {run.runId}
            {run.seed !== null ? ` · seed ${run.seed}` : ''}
          </p>
          <div class="run-identity">
            <h1>{title}</h1>
            <span class={`status-pill ${run.state}`}>{run.state}</span>
          </div>
          <p class="kicker" style="margin:10px 0 0">
            {run.pool || (run.board ? `board ${run.board}` : 'assigned teams')} · {run.models.join(' vs ')}
          </p>
          <div class="progress-rail">
            <div class="progress-fill" style={`width:${total ? Math.round((done * 100) / total) : 0}%`} />
          </div>
        </div>
        <div>
          <p class="kicker" style="text-align:right">
            {done} / {total} series · {elapsedText(run)}
          </p>
          {run.canControl ? (
            <div class="run-controls">
              {run.state === 'paused' && (
                <button type="button" class="button primary" disabled={resuming || stopping} onClick={resume}>
                  {resuming ? 'Resuming…' : 'Resume run'}
                </button>
              )}
              <button type="button" class="button danger" disabled={!active || stopping || resuming} onClick={stop}>
                {stopping ? 'Stopping…' : 'Stop run'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {run.state === 'paused' && run.pause ? (
        <div class="message" role="status">
          {run.pause.model}: {run.pause.message}
        </div>
      ) : null}
      {run.error || stopError || resumeError ? (
        <div class="message error" role="alert">
          {run.error || stopError || resumeError}
        </div>
      ) : null}
      {run.bracket && run.bracket.entrants.length > 2 && (
        <Bracket bracket={run.bracket} rows={run.rows} selected={effective} onSelect={onSelect} />
      )}
      <div class="arena-grid">
        <section class="panel series-board">
          <div class="section-head">
            <div>
              <h2>Series board</h2>
              <p>
                {done} complete · {total - done} remaining
              </p>
            </div>
          </div>
          <div class="board-list">
            {run.rows.length === 0 ? (
              <div class="empty-contenders" style="margin:18px">
                Assigning series.
              </div>
            ) : (
              run.rows.map((item, index) => (
                <button
                  type="button"
                  key={index}
                  class={`board-row ${effective === index ? 'selected' : ''}`}
                  aria-pressed={effective === index}
                  onClick={() => onSelect(index)}
                >
                  <span class="board-index">{String(index + 1).padStart(2, '0')}</span>
                  <span class="board-match">
                    <span class="board-names">
                      <span class="board-name">
                        <Mark spec={item.players.p1} size={13} />
                        <span>{item.players.p1}</span>
                      </span>
                      <span class="muted">vs</span>
                      <span class="board-name">
                        <Mark spec={item.players.p2} size={13} />
                        <span>{item.players.p2}</span>
                      </span>
                    </span>
                    <span class="board-detail">{rowState(item)}</span>
                  </span>
                  <span class="board-score">
                    {item.score.p1}-{item.score.p2}
                    <small>{item.status === 'done' ? `${item.turns} turns` : item.status}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
        <section class="panel battlefield">
          {!row ? (
            <div class="field-surface">
              <div class="field-empty" aria-live="polite">
                <h2>Waiting for assignments</h2>
                <p>The series list will appear here when it is ready.</p>
              </div>
            </div>
          ) : !battle?.snapshot ? (
            <>
              <div class="field-meta">
                <span>Series {(effective ?? 0) + 1}</span>
                <span class="turn-badge">{rowState(row)}</span>
              </div>
              <div class="field-surface">
                <div class="field-empty" aria-live="polite">
                  <h2>{row.status === 'queued' ? 'Queued' : 'Loading battle'}</h2>
                  <p>
                    {row.players.p1} vs {row.players.p2}
                  </p>
                </div>
              </div>
            </>
          ) : battle.snapshot ? (
            <>
              <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                Game {battle.game}. {battle.snapshot.turn ? `Turn ${battle.snapshot.turn}.` : 'Team preview.'} Score{' '}
                {row.score.p1} to {row.score.p2}.
                {battle.snapshot.log.length > 0
                  ? ` ${battle.snapshot.log[battle.snapshot.log.length - 1]?.text ?? ''}`
                  : ''}
              </div>
              <Battlefield
                snapshot={battle.snapshot}
                receivedAt={battle.receivedAt}
                warnings={{
                  p1: latestFallback(
                    battle.snapshot.decisions,
                    (d) => d.pid === 'p1',
                    (d) => d.error,
                  ),
                  p2: latestFallback(
                    battle.snapshot.decisions,
                    (d) => d.pid === 'p2',
                    (d) => d.error,
                  ),
                }}
                meta={
                  <>
                    <span>Game {battle.game} · Bo3</span>
                    <span class="series-score">
                      {row.score.p1}-{row.score.p2}
                    </span>
                    <span class="turn-badge">
                      {battle.snapshot.turn ? `Turn ${battle.snapshot.turn}` : 'Team preview'}
                    </span>
                  </>
                }
              />
              <TurnLog
                log={battle.snapshot.log}
                decisions={battle.snapshot.decisions}
                players={row.players}
                game={battle.game}
                games={entry?.games?.length ? entry.games : battle.games}
                onSelectGame={viewGame}
              />
            </>
          ) : null}
          {run.notices.length > 0 ? (
            <div class="notice-strip" aria-live="polite">
              {run.notices.join('\n')}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
