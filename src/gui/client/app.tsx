import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppState, AuthView, BattleMessage, PoolInfo, RunSnapshot, ServerEvent } from '../api';
import { api, configureCsrf } from './http';
import type { StoredBattle } from './views/arena';
import { ArenaView } from './views/arena';
import { FixturesView } from './views/fixtures';
import { ResultsView } from './views/results';

const NAV = [
  { id: 'fixtures', label: 'New run' },
  { id: 'arena', label: 'Live run' },
  { id: 'results', label: 'Record book' },
] as const;

export type ViewId = (typeof NAV)[number]['id'];

function isFresherBattle(candidate: BattleMessage, current: BattleMessage | undefined): boolean {
  if (!candidate.snapshot) return false;
  return !current?.snapshot || candidate.revision > current.revision;
}

function canContribute(auth: AuthView): boolean {
  return auth.mode === 'local' || auth.user?.role === 'contributor' || auth.user?.role === 'operator';
}

function AccessGate({ auth }: { auth: AuthView }) {
  if (auth.mode === 'read-only') {
    return (
      <div class="access-gate panel">
        <p class="eyebrow">Hosted mode</p>
        <h2>Read-only</h2>
        <p class="lede">
          Public records stay open. Starting runs and publishing pools require GitHub authentication on this deployment.
        </p>
      </div>
    );
  }
  if (!auth.user) {
    return (
      <div class="access-gate panel">
        <p class="eyebrow">Sign in</p>
        <h2>GitHub sign-in required</h2>
        <p class="lede">
          Sign in to start runs and publish team pools. Public records remain available without an account.
        </p>
        <a class="button primary" href="/auth/github">
          Sign in with GitHub
        </a>
      </div>
    );
  }
  return (
    <div class="access-gate panel">
      <p class="eyebrow">Access</p>
      <h2>Insufficient role</h2>
      <p class="lede">
        Signed in as {auth.user.login} with role {auth.user.role}. Contributor or operator access is required for runs
        and team pools.
      </p>
    </div>
  );
}

export function App() {
  const [app, setApp] = useState<AppState | null>(null);
  const [bootError, setBootError] = useState('');
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [battles, setBattles] = useState<Record<number, StoredBattle>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<ViewId>('fixtures');
  const [recordsEpoch, setRecordsEpoch] = useState(0);
  const [, setClockTick] = useState(0);
  const runWasLive = useRef(false);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    api<AppState>('/api/state')
      .then((state) => {
        configureCsrf(state.auth.csrfToken);
        setApp(state);
        setRun(state.run);
        runWasLive.current = state.run?.state === 'running';
        runIdRef.current = state.run?.runId ?? null;
      })
      .catch((error: Error) => setBootError(error.message));
  }, []);

  const contribute = app ? canContribute(app.auth) : false;
  const eventsPath = app ? (contribute ? '/api/events' : '/api/events/public') : null;
  useEffect(() => {
    if (!eventsPath) return;
    const events = new EventSource(eventsPath);
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
        setBattles((previous) => {
          if (!isFresherBattle(message, previous[message.index])) return previous;
          return { ...previous, [message.index]: { ...message, receivedAt: Date.now() } };
        });
      }
    };
    return () => events.close();
  }, [eventsPath]);

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
    api<BattleMessage>(`${contribute ? '/api/battle' : '/api/battle/public'}?index=${index}`)
      .then((data) => {
        setBattles((previous) => {
          if (!data.snapshot || !isFresherBattle(data, previous[index])) return previous;
          return { ...previous, [index]: { ...data, receivedAt: Date.now() } };
        });
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

  const logout = () => {
    api<{ ok: boolean }>('/api/logout', {})
      .catch(() => {})
      .finally(() => {
        configureCsrf(null);
        window.location.assign('/');
      });
  };

  if (bootError) {
    return (
      <main class="shell">
        <div class="message error" role="alert">
          Could not load the league: {bootError}
        </div>
      </main>
    );
  }
  if (!app) {
    return (
      <main class="shell">
        <p class="muted">Loading the league…</p>
      </main>
    );
  }

  const live = run?.state === 'running';
  const user = app.auth.user;
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
        <div class="header-aside">
          <div class={`header-state ${live ? 'live' : ''}`}>
            <span class="live-dot" />
            <span>{live ? 'Run in progress' : run ? `Last run ${run.state}` : 'Idle'}</span>
          </div>
          {app.auth.mode === 'read-only' ? <span class="header-readonly">Read-only</span> : null}
          {app.auth.mode === 'github' && !user ? (
            <a class="header-auth-link" href="/auth/github">
              Sign in with GitHub
            </a>
          ) : null}
          {user ? (
            <div class="header-user">
              <span class="header-avatar" aria-hidden="true">
                {user.login.slice(0, 1).toUpperCase()}
              </span>
              <div class="header-user-text">
                <span class="header-login">{user.login}</span>
                <span class="header-role">{user.role}</span>
              </div>
              <button type="button" class="header-logout" onClick={logout}>
                Log out
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <main class="shell">
        <section class={`view ${view === 'fixtures' ? 'on' : ''}`}>
          {contribute ? (
            <FixturesView app={app} run={run} onStarted={onStarted} onPools={onPools} />
          ) : (
            <AccessGate auth={app.auth} />
          )}
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
      </main>
    </>
  );
}
