import { useEffect, useState } from 'preact/hooks';

import type { BattleMessage, MonView, RunSnapshot, SeriesRowView, SideView } from '../../api';
import { api } from '../http';

interface ArenaProps {
  run: RunSnapshot | null;
  battles: Record<number, BattleMessage>;
  selected: number | null;
  onSelect: (index: number) => void;
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

function hpPercent(value: string): number {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(value);
  if (!match || !Number(match[2])) return value === 'fainted' ? 0 : 100;
  return Math.max(0, Math.min(100, Math.round((Number(match[1]) * 100) / Number(match[2]))));
}

function Mon({ mon }: { mon: MonView }) {
  const details: string[] = [];
  if (mon.fainted) details.push('Fainted');
  else if (mon.hp) details.push(`HP ${mon.hp}`);
  if (mon.status) details.push(mon.status);
  if (mon.boosts) details.push(mon.boosts);
  if (mon.lastMove) details.push(mon.lastMove);
  return (
    <div class={`mon ${mon.slot ? 'active ' : ''}${mon.fainted ? 'fainted' : ''}`}>
      <div class="mon-top">
        <span class="mon-name">{mon.species}</span>
        <span class="slot">{mon.slot ? `${mon.slot} ACTIVE` : ''}</span>
      </div>
      <div class="hp-track">
        <i style={`width:${hpPercent(mon.hp)}%`} />
      </div>
      <div class="mon-data">{details.join(' · ') || 'Not revealed'}</div>
    </div>
  );
}

function Side({ pid, side, right }: { pid: string; side: SideView; right: boolean }) {
  return (
    <div class={`side ${right ? 'right' : ''}`}>
      <div class="side-name">
        <b>{side.player}</b>
        <span>
          {pid.toUpperCase()} · {side.conditions.length ? side.conditions.join(' · ') : 'No side conditions'}
        </span>
      </div>
      {side.mons.length ? (
        side.mons.map((mon, index) => <Mon key={`${mon.species}-${index}`} mon={mon} />)
      ) : (
        <div class="mon">
          <span class="mon-data">Roster not revealed</span>
        </div>
      )}
    </div>
  );
}

export function ArenaView({ run, battles, selected, onSelect, onGoFixtures }: ArenaProps) {
  const [stopError, setStopError] = useState('');
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    setStopError('');
    setStopping(false);
  }, [run?.runId]);

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
  const done = run.rows.filter((item) => item.status === 'done').length;
  const total = run.rows.length;

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
            Rotation · protocol v{run.protocolVersion} · {run.runId}
            {run.seed === null ? '' : ` · seed ${run.seed}`}
          </p>
          <div class="run-identity">
            <h1>
              {run.state === 'running' ? 'Run in progress' : run.state === 'done' ? 'Run complete' : 'Run failed'}
            </h1>
            <span class={`status-pill ${run.state}`}>{run.state}</span>
          </div>
          <p class="kicker" style="margin:10px 0 0">
            {run.pool} · {run.models.join(' vs ')}
          </p>
          <div class="progress-rail">
            <div class="progress-fill" style={`width:${total ? Math.round((done * 100) / total) : 0}%`} />
          </div>
        </div>
        <div>
          <p class="kicker" style="text-align:right">
            {done} / {total} series · {elapsedText(run)}
          </p>
          <button type="button" class="button danger" disabled={run.state !== 'running' || stopping} onClick={stop}>
            {stopping ? 'Stopping…' : 'Stop run'}
          </button>
        </div>
      </div>
      {(run.error || stopError) && (
        <div class="message error" role="alert">
          {run.error || stopError}
        </div>
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
                Planning series assignments…
              </div>
            ) : (
              run.rows.map((item, index) => (
                <button
                  type="button"
                  key={index}
                  class={`board-row ${effective === index ? 'selected' : ''}`}
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
                    {item.score.p1}—{item.score.p2}
                    <small>{item.status === 'done' ? `${item.turns} turns` : item.status}</small>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>
        <section class="panel battlefield" aria-live="polite">
          {!row ? (
            <div class="field-surface">
              <div class="field-empty">
                <h2>Waiting for assignments</h2>
                <p>The scheduler is planning the series.</p>
              </div>
            </div>
          ) : !entry?.snapshot ? (
            <>
              <div class="field-meta">
                <span>Series {(effective ?? 0) + 1}</span>
                <span class="turn-badge">{rowState(row)}</span>
              </div>
              <div class="field-surface">
                <div class="field-empty">
                  <h2>{row.status === 'queued' ? 'Queued' : 'Waiting for battle output'}</h2>
                  <p>
                    {row.players.p1} vs {row.players.p2}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <div class="field-meta">
                <span>Game {entry.game}</span>
                <span class="turn-badge">{entry.snapshot.turn ? `Turn ${entry.snapshot.turn}` : 'Team preview'}</span>
                <span>{entry.snapshot.weather || 'Clear'}</span>
                <span>{entry.snapshot.fields.join(' · ') || 'Open field'}</span>
              </div>
              <div class="field-surface">
                <Side pid="p1" side={entry.snapshot.sides.p1} right={false} />
                <div class="center-mark">VS</div>
                <Side pid="p2" side={entry.snapshot.sides.p2} right={true} />
              </div>
            </>
          )}
          {run.notices.length > 0 && <div class="notice-strip">{run.notices.join('\n')}</div>}
        </section>
      </div>
    </div>
  );
}
