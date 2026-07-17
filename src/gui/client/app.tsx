import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppState, BattleMessage, PoolInfo, RunSnapshot, ServerEvent } from '../api';
import { api } from './http';
import { ArenaView } from './views/arena';
import { FixturesView } from './views/fixtures';
import { PoolsView } from './views/pools';
import { ResultsView } from './views/results';

const NAV = [
  { id: 'fixtures', label: 'New run' },
  { id: 'arena', label: 'Live run' },
  { id: 'results', label: 'Record book' },
  { id: 'pools', label: 'Team pools' },
] as const;

export type ViewId = (typeof NAV)[number]['id'];

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [bootError, setBootError] = useState('');
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [battles, setBattles] = useState<Record<number, BattleMessage>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<ViewId>('fixtures');
  const [recordsEpoch, setRecordsEpoch] = useState(0);
  const [, setClockTick] = useState(0);
  const runWasLive = useRef(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    api<AppState>('/api/state')
      .then((state) => {
        setApp(state);
        setRun(state.run);
        runWasLive.current = state.run?.state === 'running';
        runIdRef.current = state.run?.runId ?? null;
      })
      .catch((error: Error) => setBootError(error.message));
  }, []);

  const booted = app !== null;
  useEffect(() => {
    if (!booted) return;
    const events = new EventSource('/api/events');
    events.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerEvent;
      if (message.type === 'run') {
        const nextRunId = message.run?.runId ?? null;
        if (runIdRef.current !== nextRunId) {
          runIdRef.current = nextRunId;
          setBattles({});
          setSelected(null);
        }
        const live = message.run?.state === 'running';
        if (runWasLive.current && !live) setRecordsEpoch((epoch) => epoch + 1);
        runWasLive.current = live;
        setRun(message.run);
      } else {
        setBattles((previous) => ({ ...previous, [message.index]: message }));
      }
    };
    return () => events.close();
  }, [booted]);

  useEffect(() => {
    if (run?.state !== 'running') return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.state]);

  const navigate = (next: ViewId) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const selectBattle = (index: number) => {
    setSelected(index);
    api<BattleMessage>(`/api/battle?index=${index}`)
      .then((data) => {
        if (data.snapshot) setBattles((previous) => ({ ...previous, [index]: data }));
      })
      .catch(() => {});
  };

  const onStarted = () => {
    setSelected(null);
    setBattles({});
    navigate('arena');
  };

  const onPools = (pools: PoolInfo[]) => {
    setApp((previous) => (previous ? { ...previous, pools } : previous));
  };

  if (bootError) {
    return (
      <main class="shell">
        <div class="message error">Could not load the control room: {bootError}</div>
      </main>
    );
  }
  if (!app) return <main class="shell" />;

  const live = run?.state === 'running';
  return (
    <>
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div class="brand-name">
            VGC MODEL LEAGUE<small>Frontier model evaluation on Pokémon Showdown</small>
          </div>
        </div>
        <nav class="primary-nav" aria-label="Main navigation">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              class={`nav-button ${view === item.id ? 'on' : ''}`}
              onClick={() => navigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div class={`header-state ${live ? 'live' : ''}`}>
          <span class="live-dot" />
          <span>{live ? 'Run in progress' : run ? `Last run ${run.state}` : 'Idle'}</span>
        </div>
      </header>
      <main class="shell">
        <section class={`view ${view === 'fixtures' ? 'on' : ''}`}>
          <FixturesView app={app} run={run} onStarted={onStarted} />
        </section>
        <section class={`view ${view === 'arena' ? 'on' : ''}`}>
          <ArenaView
            run={run}
            battles={battles}
            selected={selected}
            onSelect={selectBattle}
            onGoFixtures={() => navigate('fixtures')}
          />
        </section>
        <section class={`view ${view === 'results' ? 'on' : ''}`}>
          <ResultsView active={view === 'results'} epoch={recordsEpoch} />
        </section>
        <section class={`view ${view === 'pools' ? 'on' : ''}`}>
          <PoolsView app={app} onPools={onPools} />
        </section>
      </main>
    </>
  );
}
