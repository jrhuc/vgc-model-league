import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { AppStateResponse, SelectedTraceView } from '../api';
import { CLIENT_CAPABILITIES } from './capabilities.js';
import { api } from './http';
import { type OperationalStatus, OperationalWorkspace } from './operational-loader.js';
import {
  hrefForRoute,
  hrefForView,
  navigationFor,
  type Route,
  routeForView,
  routeFromHash,
  titleForRoute,
  type ViewId,
} from './routes';
import { DocsView } from './views/docs';
import { HomeView } from './views/home';
import { LeaguesView } from './views/leagues';
import { MethodView } from './views/method';
import { TournamentsView } from './views/tournaments';

const NAV_SETS = navigationFor(CLIENT_CAPABILITIES);

function focusMainContent(event: MouseEvent, main: HTMLElement | null): void {
  event.preventDefault();
  main?.focus();
}

function SiteFooter({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  return (
    <footer class="site-footer">
      <div class="site-footer-inner">
        <div class="site-footer-brand">
          <span class="brand-mark" aria-hidden="true" />
          <div>
            <strong>VGC Model League</strong>
            <p>A personal research project using a pinned VGC simulator.</p>
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
          <strong>Project</strong>
          <a href="https://github.com/jrhuc/vgc-model-league" target="_blank" rel="noreferrer">
            GitHub repository <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </footer>
  );
}

export function App() {
  const [app, setApp] = useState<AppStateResponse | null>(null);
  const [stateError, setStateError] = useState('');
  const [selectedTrace, setSelectedTrace] = useState<SelectedTraceView | null>(null);
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash, CLIENT_CAPABILITIES));
  const [recordsEpoch, setRecordsEpoch] = useState(0);
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatus | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const skipLinkRef = useRef<HTMLAnchorElement | null>(null);
  const routeFocusReady = useRef(false);

  useEffect(() => {
    let current = true;
    api<AppStateResponse>('/api/state')
      .then((state) => {
        if (!current) return;
        setApp(state);
        setStateError('');
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

  useEffect(() => {
    const onRouteChange = () => setRoute(routeFromHash(window.location.hash, CLIENT_CAPABILITIES));
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
  }, [route]);

  const view = route.view;
  useLayoutEffect(() => {
    document.body.classList.toggle('research-dark', view !== 'arena' && view !== 'fixtures');
  }, [view]);

  const drillRoute = (next: Route) => {
    setRoute(next);
    const href = hrefForRoute(next);
    if (`${window.location.hash || '#'}` !== href) history.pushState(null, '', href);
    window.scrollTo(0, 0);
  };

  const navigate = (next: ViewId) => drillRoute(routeForView(next));
  const openLeague = (runId: string) =>
    drillRoute(runId ? { view: 'leagues', page: 'league', run: runId } : { view: 'leagues', page: 'list' });
  const openTournament = (runId: string) =>
    drillRoute(runId ? { view: 'tournaments', run: runId } : { view: 'tournaments' });

  return (
    <>
      <a ref={skipLinkRef} class="skip-link" href="#main-content" aria-controls="main-content">
        Skip to main content
      </a>
      <header class={`app-header ${operationalStatus ? 'has-aside' : ''}`}>
        <button type="button" class="brand" aria-label="VGC Model League home" onClick={() => navigate('home')}>
          <span class="brand-mark" aria-hidden="true" />
          <span class="brand-name">
            VGC MODEL LEAGUE<small>Model decisions in a pinned VGC simulator</small>
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
        {operationalStatus ? (
          <div class="header-aside">
            <div class={`header-state ${operationalStatus.tone}`}>
              <span class="live-dot" />
              <span>{operationalStatus.label}</span>
            </div>
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
        <OperationalWorkspace
          app={app}
          stateError={stateError}
          view={view}
          navigate={navigate}
          openLeague={openLeague}
          openTournament={openTournament}
          onPools={(pools) => setApp((previous) => (previous ? { ...previous, pools } : previous))}
          onRunSettled={() => setRecordsEpoch((epoch) => epoch + 1)}
          onStatus={setOperationalStatus}
        />
        {view === 'leagues' ? (
          <section class="view on">
            <LeaguesView epoch={recordsEpoch} boards={app?.boards ?? null} route={route} onNavigate={drillRoute} />
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
