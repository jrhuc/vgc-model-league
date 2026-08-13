import { useMemo } from 'preact/hooks';

import type { DraftView, RunView, TeambuildView } from '../../api';
import { BoardBrowser, STAT_ORDER, useBoard } from '../components/boardbrowser';
import { Mark } from '../components/mark';
import { Sprite } from '../components/sprite';
import { modelName } from '../lib/labels';

const PHASE_LABELS: Record<DraftView['phase'], string> = {
  draft: 'Drafting',
  roundrobin: 'Round robin',
  window: 'Free agency',
  playoffs: 'Playoffs',
  done: 'Complete',
};

function coachLabel(draft: DraftView, entrant: number): string {
  const model = draft.entrants[entrant];
  return draft.teamNames[entrant] || (model ? modelName(model) : `Coach ${entrant + 1}`);
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
      {build.rationale ? <p class="teambuild-plan">{build.rationale}</p> : null}
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
            {set.repairs.length > 0 ? (
              <ul class="teambuild-repairs">
                {set.repairs.map((repair) => (
                  <li key={repair}>{repair}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

export function DraftRoomView({ run }: { run: RunView }) {
  const draft = run.draft!;
  const { board: fullBoard, error: boardError } = useBoard(draft.boardId);
  const byId = useMemo(() => new Map((fullBoard?.mons ?? []).map((mon) => [mon.id, mon] as const)), [fullBoard]);
  const owners = useMemo(
    () => new Map(draft.rosters.flatMap((roster, entrant) => roster.map((id) => [id, entrant] as const))),
    [draft.rosters],
  );
  const pickNumbers = useMemo(
    () => new Map(draft.picks.map((pick) => [pick.mon, { pick: pick.pick, entrant: pick.entrant }] as const)),
    [draft.picks],
  );

  const recent = [...draft.picks].reverse();
  const spent = (entrant: number) => draft.budget - (draft.budgets[entrant] ?? 0);
  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">Live run / draft league</p>
          <h1>Draft room</h1>
        </div>
        <p class="lede">Current franchises, submitted team builds, board state, and recorded picks.</p>
      </header>
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Franchises</h2>
            <p>
              Board {draft.boardId} · {draft.budget} points · {draft.picksPerEntrant} picks each
              {draft.phase === 'roundrobin'
                ? ` · week ${draft.week} of ${draft.weeks}`
                : draft.phase === 'window'
                  ? ` · after week ${draft.week}`
                  : ''}
            </p>
          </div>
          <span class="phase-pill">{PHASE_LABELS[draft.phase]}</span>
        </div>

        <div class="franchise-grid">
          {draft.entrants.map((model, entrant) => (
            <div class="franchise" key={entrant}>
              <div class="franchise-head">
                <Mark spec={model} size={18} />
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
            <p>Current availability and the pick log.</p>
          </div>
        </div>
        {boardError ? <p class="empty-note">Could not load the board: {boardError}</p> : null}
        {fullBoard ? (
          <BoardBrowser
            board={fullBoard.mons}
            owners={owners}
            picks={pickNumbers}
            coach={(entrant) => coachLabel(draft, entrant)}
          />
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
                {pick.rationale ? <p>{pick.rationale}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
