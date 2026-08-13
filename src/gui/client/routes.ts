import type { ClientCapabilities } from './capability-contract.js';

const ROUTES = [
  { id: 'home', hash: '', label: 'Home', section: 'Research' },
  { id: 'method', hash: 'method', label: 'Method', section: 'Research' },
  { id: 'docs', hash: 'docs', label: 'Docs', section: 'Research' },
  { id: 'leagues', hash: 'leagues', label: 'Draft leagues', section: 'Workspace' },
  { id: 'arena', hash: 'live', label: 'Live', section: 'Workspace', capability: 'monitorRuns' },
  { id: 'tournaments', hash: 'tournaments', label: 'Tournaments', section: 'Workspace' },
  { id: 'fixtures', hash: 'new-run', label: 'New run', section: 'Workspace', capability: 'startRuns' },
] as const;

export type ViewId = (typeof ROUTES)[number]['id'];
type SimpleViewId = Exclude<ViewId, 'leagues' | 'tournaments'>;

export type LeagueRoute =
  | { view: 'leagues'; page: 'list' }
  | { view: 'leagues'; page: 'league'; run: string }
  | { view: 'leagues'; page: 'team'; run: string; entrant: number; series?: number }
  | { view: 'leagues'; page: 'game'; run: string; series: number; game: number };

export type Route = { view: SimpleViewId } | LeagueRoute | { view: 'tournaments'; run?: string };

export interface NavigationSet {
  label: (typeof ROUTES)[number]['section'];
  items: ReadonlyArray<{ id: ViewId; label: string }>;
}

function decodeHashSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function routeEnabled(route: (typeof ROUTES)[number], capabilities: Readonly<ClientCapabilities>): boolean {
  return !('capability' in route) || capabilities[route.capability];
}

function routeNumber(segment: string, minimum: number): number | undefined {
  if (!/^\d+$/.test(segment)) return undefined;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

export function navigationFor(capabilities: Readonly<ClientCapabilities>): NavigationSet[] {
  return (['Research', 'Workspace'] as const)
    .map((label) => ({
      label,
      items: ROUTES.filter((route) => route.section === label && routeEnabled(route, capabilities)).map((route) => ({
        id: route.id,
        label: route.label,
      })),
    }))
    .filter((set) => set.items.length > 0);
}

export function routeForView(view: ViewId): Route {
  if (view === 'leagues') return { view, page: 'list' };
  if (view === 'tournaments') return { view };
  return { view };
}

export function routeFromHash(hash: string, capabilities: Readonly<ClientCapabilities>): Route {
  const segments = hash.replace(/^#/, '').split('/').map(decodeHashSegment);
  const [head = '', run = '', page = '', first = '', second = ''] = segments;
  const definition = ROUTES.find((route) => route.hash === head && routeEnabled(route, capabilities));
  if (!definition) return { view: 'home' };
  if (definition.id === 'leagues') {
    if (!run) return { view: 'leagues', page: 'list' };
    if ((segments.length === 4 || segments.length === 5) && page === 'team') {
      const entrant = routeNumber(first, 0);
      const series = second ? routeNumber(second, 0) : undefined;
      if (entrant !== undefined && (!second || series !== undefined)) {
        return {
          view: 'leagues',
          page: 'team',
          run,
          entrant,
          ...(series === undefined ? {} : { series }),
        };
      }
    }
    if (segments.length === 5 && page === 'game') {
      const series = routeNumber(first, 0);
      const game = routeNumber(second, 1);
      if (series !== undefined && game !== undefined) return { view: 'leagues', page: 'game', run, series, game };
    }
    return { view: 'leagues', page: 'league', run };
  }
  if (definition.id === 'tournaments') return { view: definition.id, ...(run ? { run } : {}) };
  return { view: definition.id };
}

export function titleForRoute(route: Route): string {
  if (route.view === 'leagues') {
    if (route.page === 'game') return 'Draft league game';
    if (route.page === 'team') return 'Draft league team';
    return route.page === 'league' ? 'Draft league' : 'Draft leagues';
  }
  if (route.view === 'tournaments' && route.run) return 'Tournament';
  return ROUTES.find((definition) => definition.id === route.view)?.label ?? 'Home';
}

export function hrefForRoute(route: Route): string {
  if (route.view === 'leagues') {
    if (route.page === 'list') return '#leagues';
    const root = `#leagues/${encodeURIComponent(route.run)}`;
    if (route.page === 'league') return root;
    if (route.page === 'team') {
      const team = `${root}/team/${route.entrant}`;
      return route.series === undefined ? team : `${team}/${route.series}`;
    }
    return `${root}/game/${route.series}/${route.game}`;
  }
  if (route.view === 'tournaments' && route.run) return `#tournaments/${encodeURIComponent(route.run)}`;
  const hash = ROUTES.find((definition) => definition.id === route.view)?.hash ?? '';
  return hash ? `#${hash}` : '#';
}

export function hrefForView(view: ViewId): string {
  return hrefForRoute(routeForView(view));
}
