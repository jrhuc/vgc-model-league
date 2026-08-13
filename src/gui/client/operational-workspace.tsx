import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { AppStateResponse, BattleView, PoolInfo, RunSnapshot, RunView, ServerEvent } from '../api';
import { api } from './http';
import type { ViewId } from './routes';
import type { StoredBattle } from './views/arena';
import { ArenaView } from './views/arena';
import { FixturesView } from './views/fixtures';
import { DraftRoomView } from './views/league';
import { TournamentsView } from './views/tournaments';
import './styles/fixtures.css';
import './styles/arena.css';

export interface OperationalStatus {
  label: string;
  tone: '' | 'live' | 'paused';
}

export interface OperationalWorkspaceProps {
  app: AppStateResponse | null;
  stateError: string;
  view: ViewId;
  navigate: (view: ViewId) => void;
  openLeague: (runId: string) => void;
  openTournament: (runId: string) => void;
  onPools: (pools: PoolInfo[]) => void;
  onRunSettled: () => void;
  onStatus: (status: OperationalStatus | null) => void;
}

function isFresherBattle(candidate: BattleView, current: BattleView | undefined): boolean {
  if (candidate.snapshot === null) return false;
  if (!current) return true;
  return candidate.revision > current.revision;
}

function isActiveRunState(state: RunView['state'] | undefined | null): state is 'running' | 'paused' {
  return state === 'running' || state === 'paused';
}

export function OperationalWorkspace({
  app,
  stateError,
  view,
  navigate,
  openLeague,
  openTournament,
  onPools,
  onRunSettled,
  onStatus,
}: OperationalWorkspaceProps) {
  const [run, setRun] = useState<RunView | null>(null);
  const [battles, setBattles] = useState<Record<number, StoredBattle>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [liveTab, setLiveTab] = useState<'arena' | 'draft'>('arena');
  const [, setClockTick] = useState(0);
  const initialized = useRef(false);
  const runWasLive = useRef(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!app || initialized.current) return;
    initialized.current = true;
    setRun(app.run);
    runWasLive.current = isActiveRunState(app.run?.state);
    runIdRef.current = app.run?.runId ?? null;
    if (app.run?.mode === 'draft' && app.run.draft?.phase === 'draft') setLiveTab('draft');
  }, [app]);

  const eventsPath = app && (view === 'arena' || isActiveRunState(run?.state)) ? '/api/events' : null;

  const acceptRun = (next: RunView | null) => {
    const nextRunId = next?.runId ?? null;
    if (runIdRef.current !== nextRunId) {
      runIdRef.current = nextRunId;
      setBattles({});
      setSelected(null);
    }
    const active = isActiveRunState(next?.state);
    if (runWasLive.current && !active) onRunSettled();
    runWasLive.current = active;
    setRun(next);
  };

  useEffect(() => {
    if (!eventsPath) return;
    const events = new EventSource(eventsPath);
    events.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerEvent;
      if (message.type === 'run') {
        acceptRun(message.run);
      } else {
        setBattles((previous) => {
          if (!isFresherBattle(message, previous[message.index])) return previous;
          return { ...previous, [message.index]: { ...message, receivedAt: Date.now() } };
        });
      }
    };
    return () => events.close();
  }, [eventsPath]);

  useEffect(() => {
    if (view !== 'arena' || run?.state !== 'running') return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [view, run?.state]);

  const running = run?.state === 'running';
  const paused = run?.state === 'paused';
  const externalRun = run ? null : (app?.externalRun ?? null);
  const externallyRunning = externalRun !== null;
  const headerLabel = running
    ? 'Run in progress'
    : paused
      ? 'Run paused'
      : externallyRunning
        ? externalRun.mode === 'tournament'
          ? 'Tournament in progress'
          : 'Draft league in progress'
        : run
          ? `Last run ${run.state}`
          : 'Idle';
  const showHeaderState = Boolean(
    app && (running || paused || externallyRunning || view === 'arena' || view === 'fixtures'),
  );
  useEffect(() => {
    onStatus(
      showHeaderState
        ? { label: headerLabel, tone: running || externallyRunning ? 'live' : paused ? 'paused' : '' }
        : null,
    );
  }, [headerLabel, running, paused, externallyRunning, showHeaderState, onStatus]);
  useEffect(() => () => onStatus(null), [onStatus]);

  const fetchBattle = (index: number) => {
    api<BattleView>(`/api/battle?index=${index}`)
      .then((data) => {
        setBattles((previous) => {
          if (!isFresherBattle(data, previous[index])) return previous;
          return { ...previous, [index]: { ...data, receivedAt: Date.now() } };
        });
      })
      .catch(() => {});
  };

  const selectBattle = (index: number) => {
    setSelected(index);
    fetchBattle(index);
  };

  const loadGame = (index: number, game: number) => api<BattleView>(`/api/battle?index=${index}&game=${game}`);

  const onStarted = (startedRun: RunSnapshot) => {
    acceptRun(startedRun);
    setLiveTab(startedRun.mode === 'draft' ? 'draft' : 'arena');
    navigate('arena');
  };

  const fixturesSection = useMemo(
    () => (app ? <FixturesView app={app} run={run} onStarted={onStarted} onPools={onPools} /> : null),
    [app, run],
  );
  const draftRoomSection = useMemo(
    () => (run?.mode === 'draft' && run.draft ? <DraftRoomView run={run} /> : null),
    [run],
  );
  const showLiveTabs = Boolean(run?.mode === 'draft' && run.draft);
  const liveShowsDraft = showLiveTabs && liveTab === 'draft';
  const externalTournament = externalRun?.mode === 'tournament' ? externalRun : null;

  return (
    <>
      <section
        class={`view ${view === 'fixtures' ? 'on' : ''}`}
        hidden={view !== 'fixtures'}
        inert={view !== 'fixtures'}
        aria-hidden={view !== 'fixtures' ? 'true' : undefined}
      >
        {fixturesSection ??
          (view === 'fixtures' ? (
            <div class="route-pending">
              <h1>New run</h1>
              {stateError ? (
                <div class="message error" role="alert">
                  Could not load the run setup: {stateError}
                </div>
              ) : null}
            </div>
          ) : null)}
      </section>
      <section
        class={`view ${view === 'arena' ? 'on' : ''}`}
        hidden={view !== 'arena'}
        inert={view !== 'arena'}
        aria-hidden={view !== 'arena' ? 'true' : undefined}
      >
        {showLiveTabs ? (
          <nav class="section-nav live-tabs" aria-label="Live run sections">
            <button
              type="button"
              class={`section-tab ${liveTab === 'arena' ? 'on' : ''}`}
              aria-current={liveTab === 'arena' ? 'page' : undefined}
              onClick={() => setLiveTab('arena')}
            >
              Arena
            </button>
            <button
              type="button"
              class={`section-tab ${liveTab === 'draft' ? 'on' : ''}`}
              aria-current={liveTab === 'draft' ? 'page' : undefined}
              onClick={() => setLiveTab('draft')}
            >
              Draft room
            </button>
          </nav>
        ) : null}
        {externalTournament ? (
          view === 'arena' ? (
            <TournamentsView
              epoch={0}
              run={externalTournament.runId}
              focusRun={externalTournament.runId}
              onOpenRun={openTournament}
            />
          ) : null
        ) : (
          <>
            <div hidden={liveShowsDraft} inert={liveShowsDraft} aria-hidden={liveShowsDraft ? 'true' : undefined}>
              {app && view === 'arena' ? (
                <ArenaView
                  run={run}
                  externalRun={externalRun?.mode === 'draft' ? externalRun : null}
                  battles={battles}
                  selected={selected}
                  onSelect={selectBattle}
                  onLoadGame={loadGame}
                  onFetchBattle={fetchBattle}
                  onGoFixtures={() => navigate('fixtures')}
                  onOpenLeague={openLeague}
                />
              ) : view === 'arena' ? (
                <div class="route-pending">
                  <h1>Live</h1>
                  {stateError ? (
                    <div class="message error" role="alert">
                      Could not load the live run: {stateError}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {draftRoomSection ? (
              <div hidden={!liveShowsDraft} inert={!liveShowsDraft} aria-hidden={!liveShowsDraft ? 'true' : undefined}>
                {draftRoomSection}
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
