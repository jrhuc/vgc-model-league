import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { AppState, AuthView, BattleMessage, PoolInfo, RunSnapshot, ServerEvent } from '../api';
import { api, configureCsrf } from './http';
import type { StoredBattle } from './views/arena';
import { ArenaView } from './views/arena';
import { DataRoomView } from './views/dataroom';
import { FixturesView } from './views/fixtures';
import { DraftRoomView } from './views/league';
import { LeaguesView } from './views/leagues';
import { ModelProfileView } from './views/model';
import { ResearchOverviewView } from './views/research';
import { TournamentsView } from './views/tournaments';

const NAV_SETS = [
  {
    label: 'Research',
    items: [
      { id: 'research', label: 'Overview' },
      { id: 'data', label: 'Position Lab' },
      { id: 'leagues', label: 'Draft leagues' },
    ],
  },
  {
    label: 'Observe',
    items: [
      { id: 'arena', label: 'Live run' },
      { id: 'tournaments', label: 'Tournaments' },
    ],
  },
  {
    label: 'Operate',
    items: [{ id: 'fixtures', label: 'New run' }],
  },
] as const;

export type ViewId = (typeof NAV_SETS)[number]['items'][number]['id'];
type RouteViewId = ViewId | 'observations';

interface Route {
  view: RouteViewId;
  run?: string;
  team?: string;
  series?: number;
  model?: string;
}

function decodeHashSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function routeFromHash(): Route {
  const [head = '', second = '', third = '', fourth = ''] = window.location.hash
    .slice(1)
    .split('/')
    .map(decodeHashSegment);
  if (head === 'leagues' || head === 'draft-circuit') {
    const series = /^\d+$/.test(fourth) ? Number(fourth) : undefined;
    return {
      view: 'leagues',
      ...(second ? { run: second } : {}),
      ...(third ? { team: third } : {}),
      ...(series === undefined ? {} : { series }),
    };
  }
  if (head === 'tournaments') return { view: 'tournaments', ...(second ? { run: second } : {}) };
  if (head === 'position-lab') return { view: 'data' };
  if (head === 'observations') return second ? { view: 'observations', model: second } : { view: 'data' };
  if (head === 'data') {
    const retiredSections = new Set(['play', 'ladder', 'deliberation', 'reliability', 'chance']);
    return second && !retiredSections.has(second) ? { view: 'observations', model: second } : { view: 'data' };
  }
  if (head === 'arena' || head === 'league' || head === 'live') return { view: 'arena' };
  if (head === 'fixtures' || head === 'new-run') return { view: 'fixtures' };
  if (head === 'results') {
    if (second === 'brackets') return { view: 'tournaments' };
    return { view: 'data' };
  }
  return { view: 'research' };
}

function titleForRoute(route: Route): string {
  if (route.view === 'research') return 'Research overview';
  if (route.view === 'data') return 'Position Lab';
  if (route.view === 'leagues') {
    if (route.series !== undefined) return 'Draft league series';
    if (route.team) return 'Draft league team';
    return route.run ? 'Draft league' : 'Draft leagues';
  }
  if (route.view === 'tournaments') return route.run ? 'Tournament' : 'Tournaments';
  if (route.view === 'arena') return 'Live run';
  if (route.view === 'fixtures') return 'New run';
  return 'Legacy Observation Index';
}

function focusMainContent(event: MouseEvent, main: HTMLElement | null): void {
  event.preventDefault();
  main?.focus();
}

function isFresherBattle(candidate: BattleMessage, current: BattleMessage | undefined): boolean {
  if (!candidate.snapshot) return false;
  return !current?.snapshot || candidate.revision > current.revision;
}

function canContribute(auth: AuthView): boolean {
  return auth.mode === 'local' || auth.user?.role === 'contributor' || auth.user?.role === 'operator';
}

function isActiveRunState(state: RunSnapshot['state'] | undefined | null): state is 'running' | 'paused' {
  return state === 'running' || state === 'paused';
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
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [liveTab, setLiveTab] = useState<'arena' | 'draft'>('arena');
  const [recordsEpoch, setRecordsEpoch] = useState(0);
  const [, setClockTick] = useState(0);
  const runWasLive = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const skipLinkRef = useRef<HTMLAnchorElement | null>(null);
  const routeFocusReady = useRef(false);

  useEffect(() => {
    api<AppState>('/api/state')
      .then((state) => {
        configureCsrf(state.auth.csrfToken);
        setApp(state);
        setRun(state.run);
        runWasLive.current = isActiveRunState(state.run?.state);
        runIdRef.current = state.run?.runId ?? null;
        if (state.run?.mode === 'draft' && state.run.draft?.phase === 'draft') setLiveTab('draft');
      })
      .catch((error: Error) => setBootError(error.message));
  }, []);

  useEffect(() => {
    const link = skipLinkRef.current;
    if (!link) return;
    const onClick = (event: MouseEvent) => focusMainContent(event, mainRef.current);
    link.addEventListener('click', onClick);
    return () => link.removeEventListener('click', onClick);
  }, [app]);

  const contribute = app ? canContribute(app.auth) : false;
  const eventsPath = app ? (contribute ? '/api/events' : '/api/events/public') : null;

  const acceptRun = (next: RunSnapshot | null) => {
    const nextRunId = next?.runId ?? null;
    if (runIdRef.current !== nextRunId) {
      runIdRef.current = nextRunId;
      setBattles({});
      setSelected(null);
    }
    const active = isActiveRunState(next?.state);
    if (runWasLive.current && !active) setRecordsEpoch((epoch) => epoch + 1);
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
    if (run?.state !== 'running') return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.state]);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.title = `${titleForRoute(route)} · VGC Model League`;
    if (!routeFocusReady.current) {
      routeFocusReady.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [route.view, route.run, route.team, route.series, route.model]);

  const view = route.view;

  const navigate = (next: ViewId) => {
    setRoute({ view: next });
    history.replaceState(null, '', next === 'research' ? '#' : `#${next}`);
    window.scrollTo(0, 0);
  };

  const drill = (hash: string) => {
    window.location.hash = hash;
    window.scrollTo(0, 0);
  };
  const openLeague = (runId: string) => drill(runId ? `leagues/${runId}` : 'leagues');
  const openTeam = (runId: string, slug: string, series?: number) =>
    drill(series === undefined ? `leagues/${runId}/${slug}` : `leagues/${runId}/${slug}/${series}`);
  const openTournament = (runId: string) => drill(runId ? `tournaments/${runId}` : 'tournaments');
  const openModel = (id: string) => drill(`observations/${encodeURIComponent(id)}`);

  const fetchBattle = (index: number) => {
    api<BattleMessage>(`${contribute ? '/api/battle' : '/api/battle/public'}?index=${index}`)
      .then((data) => {
        setBattles((previous) => {
          if (!data.snapshot || !isFresherBattle(data, previous[index])) return previous;
          return { ...previous, [index]: { ...data, receivedAt: Date.now() } };
        });
      })
      .catch(() => {});
  };

  const selectBattle = (index: number) => {
    setSelected(index);
    fetchBattle(index);
  };

  const loadGame = (index: number, game: number) =>
    api<BattleMessage>(`${contribute ? '/api/battle' : '/api/battle/public'}?index=${index}&game=${game}`);

  const onStarted = (startedRun: RunSnapshot) => {
    acceptRun(startedRun);
    setLiveTab(startedRun.mode === 'draft' ? 'draft' : 'arena');
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

  const fixturesSection = useMemo(
    () =>
      app ? (
        contribute ? (
          <FixturesView app={app} run={run} onStarted={onStarted} onPools={onPools} />
        ) : (
          <AccessGate auth={app.auth} />
        )
      ) : null,
    [app, run, contribute],
  );
  const draftRoomSection = useMemo(
    () => (run?.mode === 'draft' && run.draft ? <DraftRoomView run={run} /> : null),
    [run],
  );

  if (bootError) {
    return (
      <main id="main-content" class="shell" tabIndex={-1} ref={mainRef}>
        <div class="message error" role="alert">
          Could not load the research workspace: {bootError}
        </div>
      </main>
    );
  }
  if (!app) {
    return (
      <main id="main-content" class="shell" tabIndex={-1} ref={mainRef}>
        <p class="muted">Loading the research workspace…</p>
      </main>
    );
  }

  const running = run?.state === 'running';
  const paused = run?.state === 'paused';
  const externalRun = run ? null : app.externalRun;
  const externallyRunning = externalRun !== null;
  const user = app.auth.user;
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
  const showLiveTabs = Boolean(run?.mode === 'draft' && run.draft);
  const liveShowsDraft = showLiveTabs && liveTab === 'draft';
  const externalTournament = externalRun?.mode === 'tournament' ? externalRun : null;
  const showHeaderState = running || paused || externallyRunning || view === 'arena' || view === 'fixtures';
  return (
    <>
      <a ref={skipLinkRef} class="skip-link" href="#main-content" aria-controls="main-content">
        Skip to main content
      </a>
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div class="brand-name">
            VGC MODEL LEAGUE<small>Decision research on Pokémon Showdown</small>
          </div>
        </div>
        <nav class="primary-nav" aria-label="Main navigation">
          {NAV_SETS.map((set) => (
            <div class="nav-set" key={set.label}>
              <span class="nav-set-label">{set.label}</span>
              <div class="nav-set-items">
                {set.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    class={`nav-button ${view === item.id ? 'on' : ''}`}
                    aria-current={view === item.id ? 'page' : undefined}
                    onClick={() => navigate(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div class="header-aside">
          {showHeaderState ? (
            <div class={`header-state ${running || externallyRunning ? 'live' : paused ? 'paused' : ''}`}>
              <span class="live-dot" />
              <span>{headerLabel}</span>
            </div>
          ) : null}
          {view === 'fixtures' && app.auth.mode === 'read-only' ? <span class="header-readonly">Read-only</span> : null}
          {view === 'fixtures' && app.auth.mode === 'github' && !user ? (
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
      <main id="main-content" class="shell" tabIndex={-1} ref={mainRef}>
        {view === 'research' ? (
          <section class="view on research-workspace-view">
            <ResearchOverviewView
              onOpenPositions={() => navigate('data')}
              onOpenDraftArchive={() => navigate('leagues')}
              onOpenLive={() => navigate('arena')}
              onOpenTournaments={() => navigate('tournaments')}
              onNewRun={() => navigate('fixtures')}
            />
          </section>
        ) : null}
        <section class={`view ${view === 'fixtures' ? 'on' : ''}`}>{fixturesSection}</section>
        <section class={`view ${view === 'arena' ? 'on' : ''}`}>
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
            <TournamentsView
              active={view === 'arena'}
              epoch={recordsEpoch}
              run={externalTournament.runId}
              focusRun={externalTournament.runId}
              onOpenRun={openTournament}
            />
          ) : (
            <div style={liveShowsDraft ? 'display:none' : ''}>
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
            </div>
          )}
          {liveShowsDraft ? draftRoomSection : null}
        </section>
        {view === 'leagues' ? (
          <section class="view on">
            <LeaguesView
              active
              epoch={recordsEpoch}
              boards={app.boards}
              run={route.run}
              team={route.team}
              series={route.series}
              onOpenLeague={openLeague}
              onOpenTeam={openTeam}
              onOpenModel={openModel}
              onBack={() => openLeague('')}
            />
          </section>
        ) : null}
        {view === 'tournaments' ? (
          <section class="view on">
            <TournamentsView active epoch={recordsEpoch} run={route.run} onOpenRun={openTournament} />
          </section>
        ) : null}
        {view === 'data' ? (
          <section class="view on">
            <DataRoomView active epoch={recordsEpoch} />
          </section>
        ) : null}
        {view === 'observations' && route.model ? (
          <section class="view on observation-index-view">
            <ModelProfileView
              active
              model={route.model}
              onBack={() => navigate('data')}
              onOpenLeague={openLeague}
              onOpenTournament={openTournament}
            />
          </section>
        ) : null}
      </main>
    </>
  );
}
