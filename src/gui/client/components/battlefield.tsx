import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { BattleSnapshot, MonView, PublicTeamSheetSetView, SideTimerView, SideView, SpendView } from '../../api';
import { TeamLineup } from './lineup';
import { Mark } from './mark';
import { ItemIcon, Sprite } from './sprite';

function speciesSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A drafted mega enters play under its base species until it evolves, so match by slug prefix. */
function setMatchesMon(set: PublicTeamSheetSetView, mon: MonView): boolean {
  const setId = speciesSlug(set.species);
  const monId = speciesSlug(mon.species);
  return setId === monId || setId.startsWith(`${monId}-`) || monId.startsWith(`${setId}-`);
}

function TeamStrip({ team, mons }: { team: Array<PublicTeamSheetSetView>; mons: MonView[] }) {
  return (
    <ul class="team-strip" aria-label="Brought team">
      {team.map((set) => {
        const mon = mons.find((candidate) => setMatchesMon(set, candidate));
        const state = mon?.fainted ? 'fainted' : mon?.slot ? 'active' : '';
        return (
          <li
            key={set.species}
            class={`team-strip-mon ${state}`}
            title={`${set.species}${set.item ? ` @ ${set.item}` : ''}`}
          >
            <Sprite id={set.spriteId} size={36} />
            {set.item ? <ItemIcon item={set.item} size={16} /> : null}
          </li>
        );
      })}
    </ul>
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
        <Sprite id={mon.spriteId} size={32} />
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
  if (clamped >= 3600) {
    const minutes = Math.floor((clamped % 3600) / 60);
    return `${Math.floor(clamped / 3600)}:${String(minutes).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
  }
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, '0')}`;
}

function tokenText(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function timerInfo(
  timer: SideTimerView | null | undefined,
  spend: SpendView | undefined,
  receivedAt: number,
): { text: string; urgent: boolean; running: boolean } | null {
  const drained = timer?.running ? Math.max(0, (Date.now() - receivedAt) / 1000) : 0;
  if (!timer || timer.seconds === null) {
    const thinking = timer?.running && typeof timer.elapsedSeconds === 'number' ? timer.elapsedSeconds + drained : null;
    const total = (spend?.seconds ?? 0) + (thinking ?? 0);
    if (!spend && thinking === null && !total) return null;
    const parts = [
      thinking === null ? 'Decided' : `Thinking ${clockText(thinking)}`,
      `Total ${clockText(total)}`,
      ...(spend?.tokens ? [`${tokenText(spend.tokens)} tokens`] : []),
    ];
    return { text: parts.join(' · '), urgent: false, running: timer?.running ?? false };
  }
  const seconds = Math.max(0, timer.seconds - drained);
  const turnSeconds = timer.turnSeconds === null ? null : Math.max(0, timer.turnSeconds - drained);
  const move = turnSeconds === null ? '' : `Move ${clockText(turnSeconds)} · `;
  return {
    text: `${move}Bank ${clockText(seconds)}`,
    urgent: timer.running && ((turnSeconds !== null && turnSeconds <= 20) || seconds <= 60),
    running: timer.running,
  };
}

const FELL_BACK = 'Latest model decision used a fallback.';

function monRank(mon: MonView): number {
  if (mon.slot) return mon.slot.charCodeAt(0) - 65;
  return mon.fainted ? 9 : 5;
}

function Side({
  pid,
  side,
  right,
  timer,
  spend,
  receivedAt,
  warning,
  model,
  label,
  team,
}: {
  pid: 'p1' | 'p2';
  side: SideView;
  right: boolean;
  timer: SideTimerView | null | undefined;
  spend: SpendView | undefined;
  receivedAt: number;
  warning: string | null;
  model?: string | undefined;
  label?: string | undefined;
  team?: Array<PublicTeamSheetSetView> | undefined;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timer?.running) return;
    const interval = setInterval(() => setTick((count) => count + 1), 1000);
    return () => clearInterval(interval);
  }, [timer?.running, receivedAt]);
  const clock = timerInfo(timer, spend, receivedAt);
  const mons = [...side.mons].sort((a, b) => monRank(a) - monRank(b));
  return (
    <div class={`side ${right ? 'right' : ''}`}>
      <div class="side-name">
        <div class="side-model">
          {warning !== null && (
            <span
              class="side-fallback-warning"
              role="img"
              aria-label={warning ? `${FELL_BACK} ${warning}` : FELL_BACK}
              title={warning || FELL_BACK}
            />
          )}
          <Mark spec={model ?? side.player} size={16} />
          <b>{label ?? model ?? side.player}</b>
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
      <div class="side-body">
        {team && team.length > 0 ? <TeamStrip team={team} mons={side.mons} /> : null}
        <div class="side-mons">
          {mons.length ? (
            mons.map((mon, index) => <Mon key={`${mon.slot || 'x'}-${mon.species}-${index}`} mon={mon} />)
          ) : (
            <div class="mon">
              <span class="mon-data">Roster not revealed</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Battlefield({
  snapshot,
  receivedAt,
  players,
  labels,
  warnings,
  teams,
  meta,
}: {
  snapshot: BattleSnapshot;
  receivedAt: number;
  players?: Partial<Record<'p1' | 'p2', string>>;
  labels?: Partial<Record<'p1' | 'p2', string>>;
  warnings?: Partial<Record<'p1' | 'p2', string | null>>;
  teams?: Partial<Record<'p1' | 'p2', Array<PublicTeamSheetSetView> | undefined>>;
  meta?: ComponentChildren;
}) {
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const hasTeams = Boolean(teams?.p1?.length || teams?.p2?.length);

  return (
    <>
      <div class="field-meta">
        {meta}
        <span class={snapshot.weather === 'none' ? '' : 'condition-active'}>
          {snapshot.weather === 'none' ? 'Clear skies' : snapshot.weather}
        </span>
        <span class={snapshot.fields.length ? 'condition-active' : ''}>
          {snapshot.fields.join(' · ') || 'Open field'}
        </span>
      </div>
      <div class="field-surface">
        <div class="center-mark" aria-hidden="true">
          VS
        </div>
        <div class="field-sides">
          <Side
            pid="p1"
            side={snapshot.sides.p1}
            right={false}
            timer={snapshot.timers?.p1}
            spend={snapshot.spend?.p1}
            receivedAt={receivedAt}
            warning={warnings?.p1 ?? null}
            model={players?.p1}
            label={labels?.p1}
            team={teams?.p1}
          />
          <div class="field-gutter" aria-hidden="true" />
          <Side
            pid="p2"
            side={snapshot.sides.p2}
            right={true}
            timer={snapshot.timers?.p2}
            spend={snapshot.spend?.p2}
            receivedAt={receivedAt}
            warning={warnings?.p2 ?? null}
            model={players?.p2}
            label={labels?.p2}
            team={teams?.p2}
          />
        </div>
      </div>
      {hasTeams ? (
        <div class="sheet-tray">
          <button
            type="button"
            class="sheet-tray-toggle"
            aria-expanded={sheetsOpen}
            onClick={() => setSheetsOpen((open) => !open)}
          >
            <span>{sheetsOpen ? 'Hide team sheets' : 'Team sheets'}</span>
            <span class={`sheet-tray-chevron ${sheetsOpen ? 'open' : ''}`} aria-hidden="true" />
          </button>
          {sheetsOpen ? (
            <TeamLineup
              sides={[
                {
                  key: 'p1',
                  model: players?.p1 ?? labels?.p1 ?? 'p1',
                  label: labels?.p1 ?? players?.p1 ?? 'Player 1',
                  team: teams?.p1,
                },
                {
                  key: 'p2',
                  model: players?.p2 ?? labels?.p2 ?? 'p2',
                  label: labels?.p2 ?? players?.p2 ?? 'Player 2',
                  team: teams?.p2,
                },
              ]}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
