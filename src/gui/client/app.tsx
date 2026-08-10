import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  AppStateResponse,
  AuthView,
  BattleView,
  PoolInfo,
  RunSnapshot,
  RunView,
  SelectedTraceView,
  ServerEvent,
} from '../api';
import { api } from './http';
import type { StoredBattle } from './views/arena';
import { ArenaView } from './views/arena';
import { DocsView } from './views/docs';
import { FixturesView } from './views/fixtures';
import { HomeView } from './views/home';
import { DraftRoomView } from './views/league';
import { LeaguesView } from './views/leagues';
import { MethodView } from './views/method';
import { TournamentsView } from './views/tournaments';

const NAV_SETS = [
  {
    label: 'Research',
    items: [
      { id: 'home', label: 'Home' },
      { id: 'method', label: 'Method' },
      { id: 'docs', label: 'Docs' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { id: 'leagues', label: 'Draft leagues' },
      { id: 'arena', label: 'Live' },
      { id: 'tournaments', label: 'Tournaments' },
      { id: 'fixtures', label: 'New run' },
    ],
  },
] as const;

export type ViewId = (typeof NAV_SETS)[number]['items'][number]['id'];

interface Route {
  view: ViewId;
  run?: string;
  team?: string;
  series?: number;
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
  if (head === '') return { view: 'home' };
  if (head === 'method') return { view: 'method' };
  if (head === 'docs') return { view: 'docs' };
  if (head === 'leagues') {
    const series = /^\d+$/.test(fourth) ? Number(fourth) : undefined;
    return {
      view: 'leagues',
      ...(second ? { run: second } : {}),
      ...(third ? { team: third } : {}),
      ...(series === undefined ? {} : { series }),
    };
  }
  if (head === 'tournaments') return { view: 'tournaments', ...(second ? { run: second } : {}) };
  if (head === 'live') return { view: 'arena' };
  if (head === 'new-run') return { view: 'fixtures' };
  return { view: 'home' };
}

function titleForRoute(route: Route): string {
  if (route.view === 'home') return 'Home';
  if (route.view === 'method') return 'Method';
  if (route.view === 'docs') return 'Docs';
  if (route.view === 'leagues') {
    if (route.series !== undefined) return 'Draft league series';
    if (route.team) return 'Draft league team';
    return route.run ? 'Draft league' : 'Draft leagues';
  }
  if (route.view === 'tournaments') return route.run ? 'Tournament' : 'Tournaments';
  if (route.view === 'arena') return 'Live';
  if (route.view === 'fixtures') return 'New run';
  return 'Home';
}

const VIEW_HASH: Record<ViewId, string> = {
  home: '',
  method: 'method',
  docs: 'docs',
  leagues: 'leagues',
  arena: 'live',
  tournaments: 'tournaments',
  fixtures: 'new-run',
};

function hrefForView(view: ViewId): string {
  return VIEW_HASH[view] ? `#${VIEW_HASH[view]}` : '#';
}

function focusMainContent(event: MouseEvent, main: HTMLElement | null): void {
  event.preventDefault();
  main?.focus();
}

function isFresherBattle(candidate: BattleView, current: BattleView | undefined): boolean {
  if (candidate.snapshot === null) return false;
  if (!current) return true;
  return candidate.revision > current.revision;
}

function canContribute(auth: AuthView): boolean {
  return auth.mode === 'local';
}

function isActiveRunState(state: RunView['state'] | undefined | null): state is 'running' | 'paused' {
  return state === 'running' || state === 'paused';
}

function SiteFooter({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  return (
    <footer class="site-footer">
      <div class="site-footer-inner">
        <div class="site-footer-brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <strong>VGC Model League</strong>
            <p>Decision research in a pinned VGC simulator.</p>
          </div>
        </div>
        {NAV_SETS.map((set) => (
          <nav class="site-footer-nav" aria-label={`${set.label} links`} key={set.label}>
            <strong>{set.label}</strong>
            {set.items.map((item) => (
              <a
                key={item.id}
                href={hrefForView(item.id)}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(item.id);
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>
        ))}
        <div class="site-footer-project">
          <strong>Project updates</strong>
          <a href="https://github.com/jrhuc/vgc-model-league" target="_blank" rel="noreferrer">
            GitHub repository <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </footer>
  );
}

function AccessGate() {
  return (
    <div class="access-gate panel">
      <p class="eyebrow">Published archive</p>
      <h1>Read-only</h1>
      <p class="lede">You can browse records, but runs start from the local operator console, not this deployment.</p>
    </div>
  );
}

export function App() {
  const [app, setApp] = useState<AppStateResponse | null>(null);
  const [stateError, setStateError] = useState('');
  const [selectedTrace, setSelectedTrace] = useState<SelectedTraceView | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
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
    let current = true;
    api<AppStateResponse>('/api/state')
      .then((state) => {
        if (!current) return;
        setApp(state);
        setRun(state.run);
        setStateError('');
        runWasLive.current = isActiveRunState(state.run?.state);
        runIdRef.current = state.run?.runId ?? null;
        if (state.run?.mode === 'draft' && state.run.draft?.phase === 'draft') setLiveTab('draft');
      })
      .catch((error: Error) => {
        if (current) setStateError(error.message);
      });
    return () => {
      current = false;
    };
  }, []);

  const needsSelectedTrace = route.view === 'home' || route.view === 'method';
  useEffect(() => {
    if (selectedTrace || !needsSelectedTrace) return;
    let current = true;
    api<SelectedTraceView>('/api/selected-trace')
      .then((trace) => {
        if (current) setSelectedTrace(trace);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [selectedTrace, needsSelectedTrace]);

  useEffect(() => {
    const link = skipLinkRef.current;
    if (!link) return;
    const onClick = (event: MouseEvent) => focusMainContent(event, mainRef.current);
    link.addEventListener('click', onClick);
    return () => link.removeEventListener('click', onClick);
  }, [app]);

  const contribute = app ? canContribute(app.auth) : false;
  const eventsPath =
    !__STATIC_SITE__ && app && contribute && (route.view === 'arena' || isActiveRunState(run?.state))
      ? '/api/events'
      : null;

  const acceptRun = (next: RunView | null) => {
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
    if (route.view !== 'arena' || run?.state !== 'running') return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [route.view, run?.state]);

  useEffect(() => {
    const onRouteChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    return () => {
      window.removeEventListener('hashchange', onRouteChange);
      window.removeEventListener('popstate', onRouteChange);
    };
  }, []);

  useEffect(() => {
    document.title = `${titleForRoute(route)} · VGC Model League`;
    if (!routeFocusReady.current) {
      routeFocusReady.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [route.view, route.run, route.team, route.series]);

  const view = route.view;
  useLayoutEffect(() => {
    document.body.classList.toggle('research-dark', view !== 'arena' && view !== 'fixtures');
  }, [view]);

  const navigate = (next: ViewId) => {
    setRoute({ view: next });
    const href = hrefForView(next);
    if (`${window.location.hash || '#'}` !== href) history.pushState(null, '', href);
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

  const onPools = (pools: PoolInfo[]) => {
    setApp((previous) => (previous ? { ...previous, pools } : previous));
  };

  const fixturesSection = useMemo(
    () =>
      app ? (
        contribute ? (
          <FixturesView app={app} run={run} onStarted={onStarted} onPools={onPools} />
        ) : (
          <AccessGate />
        )
      ) : null,
    [app, run, contribute],
  );
  const draftRoomSection = useMemo(
    () => (run?.mode === 'draft' && run.draft ? <DraftRoomView run={run} /> : null),
    [run],
  );

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
  const showLiveTabs = Boolean(run?.mode === 'draft' && run.draft);
  const liveShowsDraft = showLiveTabs && liveTab === 'draft';
  const externalTournament = externalRun?.mode === 'tournament' ? externalRun : null;
  const showHeaderState = Boolean(
    app && (running || paused || externallyRunning || view === 'arena' || view === 'fixtures'),
  );
  const showHeaderReadOnly = view === 'fixtures' && app?.auth.mode === 'read-only';
  const showHeaderAside = showHeaderState || showHeaderReadOnly;
  return (
    <>
      <a ref={skipLinkRef} class="skip-link" href="#main-content" aria-controls="main-content">
        Skip to main content
      </a>
      <header class={`app-header ${showHeaderAside ? 'has-aside' : ''}`}>
        <button type="button" class="brand" aria-label="VGC Model League home" onClick={() => navigate('home')}>
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-name">
            VGC MODEL LEAGUE<small>Decisions in a forkable VGC simulator</small>
          </span>
        </button>
        <nav class="primary-nav" aria-label="Main navigation">
          {NAV_SETS.map((set) => (
            <div class="nav-set" key={set.label}>
              <span class="nav-set-label">{set.label}</span>
              <div class="nav-set-items">
                {set.items.map((item) => (
                  <a
                    key={item.id}
                    href={hrefForView(item.id)}
                    class={`nav-button ${view === item.id ? 'on' : ''}`}
                    aria-current={view === item.id ? 'page' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item.id);
                    }}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {showHeaderAside ? (
          <div class="header-aside">
            {showHeaderState ? (
              <div class={`header-state ${running || externallyRunning ? 'live' : paused ? 'paused' : ''}`}>
                <span class="live-dot" />
                <span>{headerLabel}</span>
              </div>
            ) : null}
            {showHeaderReadOnly ? <span class="header-readonly">Read-only</span> : null}
          </div>
        ) : null}
      </header>
      <main id="main-content" class="shell" tabIndex={-1} ref={mainRef}>
        {view === 'home' ? (
          <section class="view on public-ia-view">
            <HomeView
              trace={selectedTrace}
              onOpenMethod={() => navigate('method')}
              onOpenDocs={() => navigate('docs')}
            />
          </section>
        ) : null}
        {view === 'method' ? (
          <section class="view on public-ia-view">
            <MethodView trace={selectedTrace} onOpenDocs={() => navigate('docs')} />
          </section>
        ) : null}
        {view === 'docs' ? (
          <section class="view on public-ia-view">
            <DocsView />
          </section>
        ) : null}
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
                    Could not load the run workspace: {stateError}
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
                epoch={recordsEpoch}
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
                        Could not load the live workspace: {stateError}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {draftRoomSection ? (
                <div
                  hidden={!liveShowsDraft}
                  inert={!liveShowsDraft}
                  aria-hidden={!liveShowsDraft ? 'true' : undefined}
                >
                  {draftRoomSection}
                </div>
              ) : null}
            </>
          )}
        </section>
        {view === 'leagues' ? (
          <section class="view on">
            <LeaguesView
              epoch={recordsEpoch}
              boards={app?.boards ?? null}
              run={route.run}
              team={route.team}
              series={route.series}
              onOpenLeague={openLeague}
              onOpenTeam={openTeam}
              onBack={() => openLeague('')}
            />
          </section>
        ) : null}
        {view === 'tournaments' ? (
          <section class="view on">
            <TournamentsView epoch={recordsEpoch} run={route.run} onOpenRun={openTournament} />
          </section>
        ) : null}
      </main>
      <SiteFooter onNavigate={navigate} />
    </>
  );
}
