import { useEffect, useRef, useState } from 'preact/hooks';

import type {
  BattleLogEntryView,
  BattleMessage,
  BracketView,
  DecisionView,
  DraftView,
  MonView,
  RunSnapshot,
  SeriesRowView,
  SideTimerView,
  SideView,
} from '../../api';
import { api } from '../http';

export type StoredBattle = BattleMessage & { receivedAt: number };

interface ArenaProps {
  run: RunSnapshot | null;
  battles: Record<number, StoredBattle>;
  selected: number | null;
  onSelect: (index: number) => void;
  onLoadGame: (index: number, game: number) => Promise<BattleMessage>;
  onGoFixtures: () => void;
}

function elapsedText(run: RunSnapshot): string {
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

const PHASE_LABELS: Record<DraftView['phase'], string> = {
  draft: 'Drafting',
  roundrobin: 'Round robin',
  playoffs: 'Playoffs',
  done: 'Complete',
};

function DraftPanel({ draft }: { draft: DraftView }) {
  const owners = new Map(draft.picks.map((pick) => [pick.mon, pick.entrant]));
  const monName = (id: string) => draft.board.find((mon) => mon.id === id)?.name ?? id;
  const recent = [...draft.picks].reverse();
  return (
    <section class="panel draft-panel">
      <div class="section-head">
        <div>
          <h2>Draft league</h2>
          <p>
            Board {draft.boardId} · {draft.budget} points · {draft.picksPerEntrant} picks each
          </p>
        </div>
        <span class="phase-pill">{PHASE_LABELS[draft.phase]}</span>
      </div>
      {draft.phase === 'draft' && (
        <div class="draft-board">
          {draft.board.map((mon) => {
            const owner = owners.get(mon.id);
            return (
              <div
                class={`board-chip ${owner !== undefined ? 'taken' : ''}`}
                key={mon.id}
                title={`${mon.item ? `@ ${mon.item} · ` : ''}${mon.ability} · ${mon.moves.join(' / ')}${mon.teraType ? ` · Tera ${mon.teraType}` : ''}`}
              >
                <b>{mon.name}</b>
                <span>
                  {mon.tier} · {mon.cost}
                </span>
                {owner !== undefined && <small>{String.fromCharCode(65 + owner)}</small>}
              </div>
            );
          })}
        </div>
      )}
      <div class="draft-rosters">
        {draft.entrants.map((model, entrant) => (
          <div class="draft-roster" key={entrant}>
            <div class="draft-roster-head">
              <span class="contender-code">{String.fromCharCode(65 + entrant)}</span>
              <b>{model}</b>
              <span class="muted">{draft.budgets[entrant]} pts left</span>
            </div>
            <ul>
              {draft.rosters[entrant]?.map((id) => (
                <li key={id}>{monName(id)}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {draft.table && (
        <table class="draft-table">
          <thead>
            <tr>
              <th>Seed</th>
              <th>Coach</th>
              <th>W-L</th>
              <th>Games</th>
            </tr>
          </thead>
          <tbody>
            {draft.table.map((row, rank) => (
              <tr key={row.entrant}>
                <td>{rank + 1}</td>
                <td>{draft.entrants[row.entrant]}</td>
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
      {recent.length > 0 && (
        <div class="draft-feed">
          <h3>Recent picks</h3>
          {recent.map((pick) => (
            <div class="draft-feed-item" key={pick.pick}>
              <span class="draft-feed-head">
                #{pick.pick} · {draft.entrants[pick.entrant]} → {monName(pick.mon)}
                {pick.fallback ? ' · fallback' : ''}
              </span>
              <p>{pick.rationale}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function roundName(index: number, count: number): string {
  const fromEnd = count - 1 - index;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${index + 1}`;
}

function Bracket({
  bracket,
  rows,
  selected,
  onSelect,
}: {
  bracket: BracketView;
  rows: RunSnapshot['rows'];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const name = (slot: number | null) => (slot === null ? 'TBD' : (bracket.entrants[slot]?.model ?? 'TBD'));
  const team = (slot: number | null) => (slot === null ? '' : (bracket.entrants[slot]?.team ?? ''));
  const champion = bracket.champion === null ? null : bracket.entrants[bracket.champion];
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
      <div class="bracket-scroll">
        <div class="bracket">
          {bracket.rounds.map((round, roundIndex) => (
            <div class="bracket-round" key={roundIndex}>
              <h3>{roundName(roundIndex, bracket.rounds.length)}</h3>
              {round.map((match, matchIndex) => {
                const row = match.seriesIndex === null ? null : rows[match.seriesIndex];
                const clickable = match.seriesIndex !== null;
                return (
                  <button
                    type="button"
                    key={matchIndex}
                    disabled={!clickable}
                    class={`bracket-match ${clickable && selected === match.seriesIndex ? 'selected' : ''} ${match.seriesIndex === null ? 'bye' : ''}`}
                    onClick={() => {
                      if (match.seriesIndex !== null) onSelect(match.seriesIndex);
                    }}
                  >
                    {([0, 1] as const).map((side) => (
                      <span
                        class={`bracket-slot ${match.winner !== null && match.slots[side] === match.winner ? 'winner' : ''}`}
                        key={side}
                      >
                        <span class="bracket-name">
                          {match.seriesIndex === null && match.slots[side] === null ? 'Bye' : name(match.slots[side])}
                        </span>
                        {team(match.slots[side]) && <small>{team(match.slots[side])}</small>}
                        <span class="bracket-score">{row ? (side === 0 ? row.score.p1 : row.score.p2) : ''}</span>
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function hpPercent(value: string): number {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(value);
  if (!match || !Number(match[2])) return value === 'fainted' ? 0 : 100;
  return Math.max(0, Math.min(100, Math.round((Number(match[1]) * 100) / Number(match[2]))));
}

function Mon({ mon }: { mon: MonView }) {
  const percent = hpPercent(mon.hp);
  const tone = percent <= 25 ? 'danger' : percent <= 50 ? 'warn' : '';
  const details: string[] = [];
  if (mon.fainted) details.push('Fainted');
  else if (mon.hp) details.push(`HP ${mon.hp}`);
  if (mon.boosts) details.push(mon.boosts);
  if (mon.volatiles && !mon.fainted) details.push(mon.volatiles);
  if (mon.lastMove) details.push(mon.lastMove);
  return (
    <div class={`mon ${mon.slot ? 'active ' : ''}${mon.fainted ? 'fainted' : ''}`}>
      <div class="mon-top">
        <span class="mon-name">
          {mon.species}
          {mon.status && !mon.fainted && <span class={`status-chip ${mon.status}`}>{mon.status.toUpperCase()}</span>}
        </span>
        <span class="slot">{mon.slot ? `${mon.slot} ACTIVE` : ''}</span>
      </div>
      <div class="hp-track">
        <i class={tone} style={`width:${percent}%`} />
      </div>
      <div class="mon-data">{details.join(' · ') || 'Not revealed'}</div>
    </div>
  );
}

function clockText(total: number): string {
  const clamped = Math.max(0, Math.floor(total));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, '0')}`;
}

function timerInfo(
  timer: SideTimerView | null | undefined,
  receivedAt: number,
): { text: string; urgent: boolean; running: boolean } | null {
  if (!timer || timer.seconds === null) return null;
  const drained = timer.running ? Math.max(0, (Date.now() - receivedAt) / 1000) : 0;
  const seconds = Math.max(0, timer.seconds - drained);
  const turnSeconds = timer.turnSeconds === null ? null : Math.max(0, timer.turnSeconds - drained);
  const move = turnSeconds === null ? '' : `Move ${clockText(turnSeconds)} · `;
  return {
    text: `${move}Bank ${clockText(seconds)}`,
    urgent: timer.running && ((turnSeconds !== null && turnSeconds <= 20) || seconds <= 60),
    running: timer.running,
  };
}

function monRank(mon: MonView): number {
  if (mon.slot) return mon.slot.charCodeAt(0) - 65;
  return mon.fainted ? 9 : 5;
}

function Side({
  pid,
  side,
  right,
  timer,
  receivedAt,
  warning,
}: {
  pid: string;
  side: SideView;
  right: boolean;
  timer: SideTimerView | null | undefined;
  receivedAt: number;
  warning: string;
}) {
  const clock = timerInfo(timer, receivedAt);
  const mons = [...side.mons].sort((a, b) => monRank(a) - monRank(b));
  return (
    <div class={`side ${right ? 'right' : ''}`}>
      <div class="side-name">
        <div class="side-model">
          {warning && (
            <span
              class="side-fallback-warning"
              role="img"
              aria-label={`Latest model decision used a fallback. ${warning}`}
              title={warning}
            />
          )}
          <b>{side.player}</b>
        </div>
        <span>
          {pid.toUpperCase()} · {side.conditions.length ? side.conditions.join(' · ') : 'No side conditions'}
        </span>
        {clock && (
          <span class={`side-timer ${clock.urgent ? 'urgent' : ''}`} aria-live="off">
            {clock.running && (
              <>
                <span class="thinking-dot" aria-hidden="true" />
                <span class="visually-hidden">Thinking. </span>
              </>
            )}
            {clock.text}
          </span>
        )}
      </div>
      {mons.length ? (
        mons.map((mon, index) => <Mon key={`${mon.slot || 'x'}-${mon.species}-${index}`} mon={mon} />)
      ) : (
        <div class="mon">
          <span class="mon-data">Roster not revealed</span>
        </div>
      )}
    </div>
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

function latestFallback(decisions: DecisionView[], pid: string): string {
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (decision.pid !== pid || decision.automatic) continue;
    return decision.fallback ? decision.error || 'The latest model decision used a fallback.' : '';
  }
  return '';
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

export function ArenaView({ run, battles, selected, onSelect, onLoadGame, onGoFixtures }: ArenaProps) {
  const [stopError, setStopError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [pastGame, setPastGame] = useState<StoredBattle | null>(null);

  useEffect(() => {
    setStopError('');
    setStopping(false);
  }, [run?.runId]);

  useEffect(() => {
    setPastGame(null);
  }, [selected, run?.runId]);

  if (!run) {
    return (
      <div class="panel no-run">
        <div class="no-run-inner">
          <div class="no-run-mark">VS</div>
          <p class="eyebrow">No active run</p>
          <h2>No run in progress</h2>
          <p class="lede">Set up models and start a run. Live turns appear here as Showdown resolves them.</p>
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
  const shown = entry && pastGame?.index === effective && pastGame.game !== entry.game ? pastGame : entry;
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

  const stop = () => {
    setStopError('');
    setStopping(true);
    api('/api/run/stop', {})
      .catch((error: Error) => setStopError(error.message))
      .finally(() => setStopping(false));
  };

  return (
    <div>
      <div class="arena-topline">
        <div>
          <p class="eyebrow">
            {runKind} · protocol v{run.protocolVersion} · {run.runId}
            {run.seed === null ? '' : ` · seed ${run.seed}`}
          </p>
          <div class="run-identity">
            <h1>
              {run.state === 'running'
                ? 'Run in progress'
                : run.state === 'done'
                  ? 'Run complete'
                  : run.state === 'stopped'
                    ? 'Run stopped'
                    : 'Run failed'}
            </h1>
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
          {run.canControl && (
            <button type="button" class="button danger" disabled={run.state !== 'running' || stopping} onClick={stop}>
              {stopping ? 'Stopping…' : 'Stop run'}
            </button>
          )}
        </div>
      </div>
      {(run.error || stopError) && (
        <div class="message error" role="alert">
          {run.error || stopError}
        </div>
      )}
      {run.draft && <DraftPanel draft={run.draft} />}
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
                      {item.players.p1} <span class="muted">vs</span> {item.players.p2}
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
                <p>The scheduler is building the series list.</p>
              </div>
            </div>
          ) : !shown?.snapshot ? (
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
          ) : (
            <>
              <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                Game {shown.game}. {shown.snapshot.turn ? `Turn ${shown.snapshot.turn}.` : 'Team preview.'} Score{' '}
                {row.score.p1} to {row.score.p2}.
                {shown.snapshot.log.length > 0
                  ? ` ${shown.snapshot.log[shown.snapshot.log.length - 1]?.text ?? ''}`
                  : ''}
              </div>
              <div class="field-meta">
                <span>Game {shown.game} · Bo3</span>
                <span class="series-score">
                  {row.score.p1}-{row.score.p2}
                </span>
                <span class="turn-badge">{shown.snapshot.turn ? `Turn ${shown.snapshot.turn}` : 'Team preview'}</span>
                <span class={shown.snapshot.weather === 'none' ? '' : 'condition-active'}>
                  {shown.snapshot.weather === 'none' ? 'Clear skies' : shown.snapshot.weather}
                </span>
                <span class={shown.snapshot.fields.length ? 'condition-active' : ''}>
                  {shown.snapshot.fields.join(' · ') || 'Open field'}
                </span>
              </div>
              <div class="field-surface">
                <Side
                  pid="p1"
                  side={shown.snapshot.sides.p1}
                  right={false}
                  timer={shown.snapshot.timers?.p1}
                  receivedAt={shown.receivedAt}
                  warning={latestFallback(shown.snapshot.decisions, 'p1')}
                />
                <div class="center-mark">VS</div>
                <Side
                  pid="p2"
                  side={shown.snapshot.sides.p2}
                  right={true}
                  timer={shown.snapshot.timers?.p2}
                  receivedAt={shown.receivedAt}
                  warning={latestFallback(shown.snapshot.decisions, 'p2')}
                />
              </div>
              <TurnLog
                log={shown.snapshot.log ?? []}
                decisions={shown.snapshot.decisions ?? []}
                players={row.players}
                game={shown.game}
                games={entry?.games?.length ? entry.games : shown.games}
                onSelectGame={viewGame}
              />
            </>
          )}
          {run.notices.length > 0 && (
            <div class="notice-strip" aria-live="polite">
              {run.notices.join('\n')}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
