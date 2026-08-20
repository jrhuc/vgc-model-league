import { useState } from 'preact/hooks';

import { draftLeagueTopology } from '../../../draftleague-topology';

import type { AppState, PoolInfo, PoolTeamsResponse, RunSnapshot, RunView } from '../../api';
import { Dropdown } from '../components/dropdown';
import { api } from '../http';
import { buildStartRunRequest, type RunMode, runReadiness, type TeamSource } from '../lib/run-draft';
import { keyStatus, useModelLineup } from '../lib/use-model-lineup';
import { PoolsView } from './pools';
import { type TeamAssignment, TeamEditor } from './team-editor';

interface FixturesProps {
  app: AppState;
  run: RunView | null;
  onStarted: (run: RunSnapshot) => void;
  onPools: (pools: PoolInfo[]) => void;
}

const MODES: Array<{ id: RunMode; label: string; hint: string }> = [
  { id: 'match', label: 'Match', hint: 'Two models, two teams, one best-of-three' },
  { id: 'tournament', label: 'Tournament', hint: 'Knockout bracket until a champion' },
  { id: 'draft', label: 'Draft league', hint: 'Snake draft, round robin, playoffs' },
  { id: 'rotation', label: 'Rotation', hint: 'Mirrored round robin for ratings' },
];
const TEAM_SHEET_OPTIONS = [
  {
    value: 'open',
    label: 'Open team sheets',
    description: 'Opposing moves, ability, item, and nature are shown; stat points stay hidden.',
  },
  {
    value: 'closed',
    label: 'Closed team sheets',
    description: 'Sets stay hidden and must be deduced through play.',
  },
];

const DRAFT_SCOPE_OPTIONS = [
  {
    value: 'season',
    label: 'Full season',
    description: 'Draft, then play the round robin and playoffs.',
  },
  {
    value: 'draft-only',
    label: 'Draft only',
    description: 'Stop once rosters are drafted; play the season later from the run.',
  },
];

const DRAFT_SCHEDULE_OPTIONS = [
  {
    value: 'parallel',
    label: 'Parallel weeks',
    description: 'Round-robin games run concurrently and builds stay blind.',
  },
  {
    value: 'sequential',
    label: 'Sequential weeks',
    description: 'Weeks play in order for adaptation data.',
  },
];

const OPENROUTER_ROUTING_OPTIONS = [
  {
    value: 'default',
    label: 'Default routing',
    description: 'Use the cheapest available upstream.',
  },
  {
    value: 'nitro',
    label: 'Nitro routing',
    description: 'Sort by throughput; usually faster and pricier.',
  },
];

function pairings(models: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < models.length; i += 1)
    for (let j = i + 1; j < models.length; j += 1) pairs.push([models[i]!, models[j]!]);
  return pairs;
}

function bracketPreview(count: number): string {
  if (count < 2) return '';
  if (count === 2) return 'A direct final. One best-of-three decides it.';
  if (count === 3) return 'One semifinal plus a final. The odd model out gets a bye.';
  let size = 1;
  while (size < count) size *= 2;
  const byes = size - count;
  return `${count - 1} best-of-three series over ${Math.log2(size)} rounds${byes ? ` · ${byes} first-round bye${byes === 1 ? '' : 's'}` : ''}.`;
}

const HEADINGS: Record<RunMode, { eyebrow: string; title: [string, string]; lede: string }> = {
  match: {
    eyebrow: 'Exhibition match',
    title: ['Set up an', 'exhibition match'],
    lede: 'Pick two models and assign each a team from a pool or a Poképaste export. The match runs on the pinned Pokémon Showdown simulator.',
  },
  tournament: {
    eyebrow: 'Tournament',
    title: ['Set up a', 'tournament'],
    lede: 'Assign each model a team from a pool draw or by hand. Models keep that team through a single-elimination best-of-three bracket.',
  },
  draft: {
    eyebrow: 'Draft league',
    title: ['Set up a', 'draft league'],
    lede: 'Coaches snake-draft ten Pokémon each under a points budget, then build six for each matchup. A full season adds a round robin, roster window, and playoffs.',
  },
  rotation: {
    eyebrow: 'Rotation run',
    title: ['Set up a', 'rotation run'],
    lede: 'Pick an immutable team pool and at least two models. Every pairing plays mirrored best-of-three series. Results append to the local records.',
  },
};

export function FixturesView({ app, run, onStarted, onPools }: FixturesProps) {
  const [mode, setMode] = useState<RunMode>('match');
  const board = app.boards[0] ?? null;
  const [launchMsg, setLaunchMsg] = useState('');
  const [pool, setPool] = useState(
    () => app.pools.find((info) => info.name !== 'test')?.name ?? app.pools[0]?.name ?? '',
  );
  const [teamSource, setTeamSource] = useState<TeamSource>('pool');
  const [teamBySlot, setTeamBySlot] = useState<Array<TeamAssignment | null>>([]);
  const [editingTeam, setEditingTeam] = useState<number | null>(null);
  const [assignFormat, setAssignFormat] = useState(app.defaultFormat);
  const [poolTeams, setPoolTeams] = useState<
    Record<string, PoolTeamsResponse | 'loading' | { error: string } | undefined>
  >({});
  const [series, setSeries] = useState('2');
  const [concurrency, setConcurrency] = useState('2');
  const [closedSheets, setClosedSheets] = useState(false);
  const [sequentialWeeks, setSequentialWeeks] = useState(false);
  const [draftOnly, setDraftOnly] = useState(false);
  const [transactions, setTransactions] = useState('default');
  const [nitro, setNitro] = useState(false);
  const [timerScale, setTimerScale] = useState('off');
  const [seed, setSeed] = useState('');
  const [starting, setStarting] = useState(false);
  const maxModels = mode === 'match' ? 2 : mode === 'draft' ? Math.min(8, board?.maxEntrants ?? 8) : 8;
  const lineup = useModelLineup({
    app,
    mode,
    maxModels,
    onAddSlot: (slot) => {
      const sample = mode === 'match' ? app.sampleTeams[slot] : undefined;
      setTeamBySlot((previous) => [
        ...previous,
        sample ? { paste: sample.paste, label: `Sample · ${sample.name}` } : null,
      ]);
    },
    onRemoveSlot: (slot) => {
      setEditingTeam(null);
      setTeamBySlot((previous) => {
        const next = [...previous];
        next.splice(slot, 1);
        return next;
      });
    },
  });
  const {
    providers,
    models,
    provider,
    providerId,
    setProviderId,
    discoverable,
    apiKeyText,
    setApiKeyText,
    keyHeld,
    catalog,
    modelText,
    setModelText,
    modelOptions,
    loadingModels,
    setupMsg,
    setSetupMsg,
    manualSpec,
    setManualSpec,
    reasoning,
    setReasoning,
    sharedReasoning,
    reasoningByModel,
    setReasoningByModel,
    reasoningLevelsByModel,
    reasoningModels,
    sharedReasoningLevels,
    addModel,
    removeModel,
    connect,
    addFromCatalog,
    addManual,
    selectSharedReasoning,
    selectIndividualReasoning,
    clearCatalogKey,
  } = lineup;
  const draftTopology = draftLeagueTopology(models.length);
  const draftWeeks = models.length < 2 ? 7 : draftTopology.weekCount;
  const defaultWeeks = [1, 2, 3].filter((week) => week <= draftWeeks);
  const transactionOptions = [
    {
      value: 'default',
      label: `Windows after weeks ${defaultWeeks.join(', ')} (default)`,
      description: 'Coach trades run before free agency in each window; rosters lock after the last one.',
    },
    {
      value: 'off',
      label: 'Locked rosters',
      description: 'Keep draft-night rosters for the whole season.',
    },
    ...Array.from({ length: draftWeeks }, (_, index) => index + 1).map((week) => ({
      value: String(week),
      label: `One window after week ${week}`,
      description: 'Lowest seed chooses first; coach trades run before up to six free-agent swaps.',
    })),
  ];
  const teamsMode = mode === 'match' || (mode === 'tournament' && teamSource === 'custom');

  const loadPoolTeams = (name: string, force = false) => {
    if (!name) return;
    const current = poolTeams[name];
    if (!force && current && (current === 'loading' || (typeof current === 'object' && 'teams' in current))) return;
    setPoolTeams((previous) => ({ ...previous, [name]: 'loading' }));
    api<PoolTeamsResponse>(`/api/pool/teams?name=${encodeURIComponent(name)}`)
      .then((data) => setPoolTeams((previous) => ({ ...previous, [name]: data })))
      .catch((error: Error) =>
        setPoolTeams((previous) => ({
          ...previous,
          [name]: { error: error.message || 'Could not load pool teams.' },
        })),
      );
  };

  const assignTeam = (slot: number, team: TeamAssignment | null, format?: string) => {
    setTeamBySlot((previous) => {
      const next = [...previous];
      next[slot] = team;
      return next;
    });
    if (format) setAssignFormat(format);
  };

  const start = () => {
    setLaunchMsg('');
    setStarting(true);
    const request = buildStartRunRequest({
      mode,
      models,
      apiKeys: lineup.apiKeys(),
      teamBySlot,
      teamSource,
      assignFormat,
      pool,
      series,
      concurrency,
      closedSheets,
      sequentialWeeks,
      draftOnly,
      transactions,
      nitro,
      sharedReasoning,
      reasoning,
      reasoningByModel,
      timerScale,
      seed,
      board: board?.id ?? '',
    });
    api('/api/run', request)
      .then(() => api<AppState>('/api/state'))
      .then((state) => {
        if (!state.run) throw new Error('The run started, but its live state is unavailable.');
        clearCatalogKey();
        onStarted(state.run);
      })
      .catch((error: Error) => setLaunchMsg(error.message))
      .finally(() => setStarting(false));
  };

  const providerOptions = providers.map((item) => ({ value: item.id, label: item.label }));
  const poolOptions = app.pools.map((info) => ({
    value: info.name,
    label: info.name,
    description: `${info.teamCount} teams · ${info.format.replace(/^gen[0-9]+champions/, '')}`,
  }));
  const reasoningOptions = [
    { value: '', label: 'Provider default' },
    ...sharedReasoningLevels.map((level) => ({ value: level, label: level })),
  ];
  const timerScaleOptions = [
    { value: 'off', label: 'Untimed (full reasoning)' },
    { value: '1', label: '1x (standard VGC clock)' },
    { value: '1.25', label: '1.25x' },
    { value: '1.5', label: '1.5x' },
    { value: '2', label: '2x' },
  ];
  const pairs = pairings(models);
  const seriesPerPair = Math.max(1, Number(series) || 1);
  const total =
    mode === 'rotation'
      ? pairs.length * seriesPerPair
      : mode === 'draft'
        ? draftOnly
          ? 0
          : draftTopology.totalSeries
        : Math.max(0, models.length - 1);
  const poolInfo = app.pools.find((info) => info.name === pool);
  const shownPairs = pairs.slice(0, 8);
  const heading = HEADINGS[mode];
  const formatLabel = app.formats.find((info) => info.id === assignFormat)?.label ?? assignFormat;
  const apiKeys = lineup.apiKeys();
  const readiness = runReadiness({ mode, models, apiKeys, teamBySlot, teamSource, pool, series }, app, run, starting);
  const { active, missingKeys, missingTeam, poolTooSmall, boardOverflow } = readiness;
  const launchNote = active
    ? run?.state === 'paused'
      ? 'Resume or stop the current run before starting another.'
      : 'Stop or finish the current run before starting another.'
    : missingKeys.length
      ? `${missingKeys.length} model${missingKeys.length === 1 ? ' needs' : 's need'} a browser-supplied key.`
      : mode === 'match'
        ? missingTeam
          ? 'Click a model above and assign its team.'
          : `One best-of-three in ${formatLabel}.`
        : mode === 'tournament'
          ? poolTooSmall
            ? `Pool ${pool} has only ${poolInfo?.teamCount} teams for ${models.length} entrants.`
            : missingTeam
              ? 'Click each model above and assign its team.'
              : bracketPreview(models.length) || 'Add models to shape the bracket.'
          : mode === 'draft'
            ? boardOverflow
              ? `Board ${board?.id ?? ''} supports at most ${board?.maxEntrants ?? 0} coaches.`
              : models.length >= 2
                ? draftOnly
                  ? `${models.length * (board?.picks ?? 10)} picks; the run ends when every roster is drafted.`
                  : `${models.length * (board?.picks ?? 10)} picks, then ${draftTopology.roundRobinSeries} round-robin and ${draftTopology.playoffSeries} playoff series, each preceded by two teambuilds.`
                : 'Add models to shape the draft.'
            : pairs.length
              ? `${total} best-of-three series, mirrored in pairs · up to ${concurrency} in parallel.`
              : 'Add models to build the run card.';

  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">{heading.eyebrow}</p>
          <h1>
            {heading.title[0]}
            <br />
            {heading.title[1]}
          </h1>
        </div>
        <p class="lede">{heading.lede}</p>
      </div>
      <fieldset class="mode-tabs">
        <legend class="visually-hidden">Run mode</legend>
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={mode === item.id}
            class={`mode-tab ${mode === item.id ? 'on' : ''}`}
            onClick={() => {
              setMode(item.id);
              setEditingTeam(null);
              setSetupMsg('');
              setLaunchMsg('');
              if (item.id === 'match') {
                setTeamBySlot((previous) =>
                  models.map((_, index) => {
                    if (previous[index]?.paste.trim()) return previous[index]!;
                    const sample = app.sampleTeams[index];
                    return sample
                      ? { paste: sample.paste, label: `Sample · ${sample.name}` }
                      : (previous[index] ?? null);
                  }),
                );
              }
            }}
          >
            <b>{item.label}</b>
            <span>{item.hint}</span>
          </button>
        ))}
      </fieldset>
      <div class="fixture-layout">
        <section class="panel stage" aria-labelledby="lineupTitle">
          <div class="section-head">
            <div>
              <h2 id="lineupTitle">Model lineup</h2>
              <p>
                {mode === 'match'
                  ? 'Exactly two models play the match.'
                  : mode === 'tournament'
                    ? 'Each model enters the bracket with its own team.'
                    : mode === 'draft'
                      ? `Each model coaches its own drafted roster${board ? ` (up to ${board.maxEntrants} coaches)` : ''}.`
                      : 'Two models make a head-to-head. Three or more make a round robin.'}
              </p>
            </div>
            <div class="section-count">
              {models.length}
              <small>models</small>
            </div>
          </div>
          <div class="contender-deck">
            {models.length === 0 ? (
              <div class="empty-contenders">
                <b>No models selected.</b>
                <br />
                Add a model spec, or <span style="font-family:var(--mono)">random</span> for a legal-move baseline.
              </div>
            ) : (
              models.map((spec, index) => {
                const status = keyStatus(providers, apiKeys, spec);
                const team = teamBySlot[index] ?? null;
                const identity = (
                  <span class="contender-name">
                    {spec}
                    <span class={`contender-meta connection ${status.cls}`}>{status.text}</span>
                    {teamsMode && (
                      <span class={`team-tag ${team ? '' : 'missing'}`}>
                        {team ? team.label : 'No team · click to assign'}
                      </span>
                    )}
                  </span>
                );
                return (
                  <div key={`${spec}-${index}`}>
                    <div class="contender">
                      <div class="contender-code">{String.fromCharCode(65 + index)}</div>
                      {teamsMode ? (
                        <button
                          type="button"
                          class="contender-main"
                          aria-expanded={editingTeam === index}
                          onClick={() => setEditingTeam(editingTeam === index ? null : index)}
                        >
                          {identity}
                        </button>
                      ) : (
                        <div class="contender-main">{identity}</div>
                      )}
                      <button
                        type="button"
                        class="icon-button"
                        aria-label={`Remove ${spec}`}
                        onClick={() => removeModel(index)}
                      >
                        ×
                      </button>
                    </div>
                    {teamsMode && editingTeam === index && (
                      <TeamEditor
                        slot={index}
                        spec={spec}
                        team={team}
                        pools={app.pools}
                        poolTeams={poolTeams}
                        onLoadPool={loadPoolTeams}
                        onAssign={(next, format) => assignTeam(index, next, format)}
                        formatLabel={formatLabel}
                        format={assignFormat}
                        onDone={() => setEditingTeam(null)}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div class={`add-bay ${models.length >= maxModels ? 'hidden' : ''}`}>
            <div class="privacy-note">
              <b>Bring your own key</b>
              <span>
                Your key stays in this tab until you remove its model or close the page. It is sent only for catalog
                lookup and runs, and is never written to results or exposed to other users.
              </span>
            </div>
            <div class="provider-flow">
              <Dropdown
                id="provider"
                label="Provider"
                options={providerOptions}
                value={providerId}
                onChange={setProviderId}
                filterable
              />
              <div class="field">
                <label class="field-label" for="apiKey">
                  API key
                </label>
                <input
                  id="apiKey"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder={keyHeld ? 'Key held for this run' : 'Paste a run-only key'}
                  value={apiKeyText}
                  onInput={(event) => setApiKeyText(event.currentTarget.value)}
                />
              </div>
              {discoverable && (
                <button type="button" class="button" disabled={loadingModels} onClick={connect}>
                  Connect &amp; find models
                </button>
              )}
            </div>
            <p class="provider-help">{provider ? `${provider.description} · Your key is not stored.` : ''}</p>
            {discoverable ? (
              <div class="model-flow">
                <Dropdown
                  id="modelSearch"
                  label="Model"
                  options={modelOptions}
                  value={modelText}
                  onChange={setModelText}
                  searchable
                  placeholder={
                    loadingModels
                      ? 'Loading models…'
                      : catalog.length
                        ? `Search ${catalog.length} model${catalog.length === 1 ? '' : 's'}…`
                        : 'Connect OpenRouter first'
                  }
                  onSubmit={addFromCatalog}
                  emptyText="No matching models."
                />
                <button type="button" class="button primary" disabled={!catalog.length} onClick={addFromCatalog}>
                  Add model
                </button>
              </div>
            ) : (
              <div class="manual-flow">
                <div class="field">
                  <label class="field-label" for="manualSpec">
                    Prime model ID
                  </label>
                  <input
                    id="manualSpec"
                    autocomplete="off"
                    placeholder="Enter a Prime Inference model ID"
                    value={manualSpec}
                    onInput={(event) => setManualSpec(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addManual();
                    }}
                  />
                </div>
                <button type="button" class="button primary" onClick={addManual}>
                  Add Prime model
                </button>
              </div>
            )}
            <div class="model-flow">
              <button type="button" class="button" onClick={() => addModel('random', '', [])}>
                Add random baseline
              </button>
            </div>
            {setupMsg && (
              <div class="message error" role="alert">
                {setupMsg}
              </div>
            )}
          </div>
          <div class="schedule">
            <div class="schedule-title">
              <h3>Run card</h3>
              <span>
                {mode === 'match'
                  ? models.length === 2
                    ? `One best-of-three · ${formatLabel}`
                    : 'Waiting for models'
                  : mode === 'tournament'
                    ? models.length >= 2
                      ? `${models.length} entrants · single elimination`
                      : 'Waiting for models'
                    : mode === 'draft'
                      ? models.length >= 2
                        ? draftOnly
                          ? `${models.length} coaches · draft only`
                          : `${models.length} coaches · ${total} series after the draft`
                        : 'Waiting for models'
                      : pairs.length
                        ? `${pairs.length} matchup${pairs.length === 1 ? '' : 's'} · ${total} series · mirrored in pairs`
                        : 'Waiting for models'}
              </span>
            </div>
            <div>
              {mode === 'match' ? (
                models.length < 2 ? (
                  <p class="muted">Add two models, then click each one to assign its team.</p>
                ) : (
                  <p class="muted">
                    {missingTeam
                      ? 'Click each model above to assign its team from a pool or a Poképaste export.'
                      : `${models[0]} with ${teamBySlot[0]?.label ?? 'its team'} vs ${models[1]} with ${teamBySlot[1]?.label ?? 'its team'}.`}
                  </p>
                )
              ) : mode === 'draft' ? (
                models.length < 2 ? (
                  <p class="muted">Add at least two models to plan the draft.</p>
                ) : draftOnly ? (
                  <p class="muted">
                    Snake draft over {board?.monCount ?? '?'} priced species with a {board?.budget ?? '?'}-point budget.
                    The run records every pick and any supplied rationale, then stops with the completed rosters.
                  </p>
                ) : (
                  <p class="muted">
                    Snake draft over {board?.monCount ?? '?'} priced species with a {board?.budget ?? '?'}-point budget.
                    Coaches rebuild their six before every matchup. The round robin seeds a{' '}
                    {draftTopology.playoffEntrants === 4 ? 'top-four playoff' : 'two-coach final'}. Picks, teambuilds,
                    and any supplied rationale appear in the draft league view.
                  </p>
                )
              ) : mode === 'tournament' ? (
                models.length < 2 ? (
                  <p class="muted">Add at least two models to build the bracket.</p>
                ) : (
                  <p class="muted">
                    {bracketPreview(models.length)}{' '}
                    {teamSource === 'pool'
                      ? 'Teams are drawn from the pool at random. Each model keeps its team for the whole bracket.'
                      : 'Click each model above to assign its team. Each model keeps its team for the whole bracket.'}
                  </p>
                )
              ) : pairs.length === 0 ? (
                <p class="muted">Add at least two models to build the schedule.</p>
              ) : (
                <>
                  {shownPairs.map((pair, index) => (
                    <div class="ticket" key={`${pair[0]}-${pair[1]}-${index}`}>
                      <span class="ticket-number">{String(index + 1).padStart(2, '0')}</span>
                      <span class="ticket-player">{pair[0]}</span>
                      <span class="ticket-vs">VS</span>
                      <span class="ticket-player away">{pair[1]}</span>
                      <span class="ticket-series">× {seriesPerPair}</span>
                    </div>
                  ))}
                  {pairs.length > shownPairs.length && (
                    <p class="kicker" style="margin:12px 0 0">
                      + {pairs.length - shownPairs.length} more matchups on the run card
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
        <aside class="panel settings" aria-labelledby="settingsTitle">
          <div class="section-head">
            <div>
              <p class="eyebrow">Start</p>
              <h2 id="settingsTitle">Run settings</h2>
            </div>
          </div>
          <div class="settings-body">
            {mode === 'tournament' && (
              <div class="team-source">
                <span class="field-label">Team source</span>
                <fieldset class="reasoning-mode">
                  <legend class="visually-hidden">Team source</legend>
                  <button
                    type="button"
                    aria-pressed={teamSource === 'pool'}
                    class={teamSource === 'pool' ? 'on' : ''}
                    onClick={() => {
                      setTeamSource('pool');
                      setEditingTeam(null);
                    }}
                  >
                    Pool draw
                  </button>
                  <button
                    type="button"
                    aria-pressed={teamSource === 'custom'}
                    class={teamSource === 'custom' ? 'on' : ''}
                    onClick={() => setTeamSource('custom')}
                  >
                    Assign teams
                  </button>
                </fieldset>
              </div>
            )}
            {((mode === 'tournament' && teamSource === 'pool') || mode === 'rotation') && (
              <div class="pool-choice">
                <Dropdown
                  id="pool"
                  label="Team pool"
                  options={poolOptions}
                  value={pool}
                  onChange={setPool}
                  placeholder="No pools available"
                />
                <div class="pool-facts">
                  <span>{poolInfo ? poolInfo.format.replace(/^gen[0-9]+/, '') : 'No format'}</span>
                  <span>{poolInfo ? `${poolInfo.teamCount} teams` : 'Empty'}</span>
                </div>
              </div>
            )}
            {teamsMode && (
              <div class="assign-format">
                <Dropdown
                  id="format"
                  label="Format"
                  options={app.formats.map((info) => ({ value: info.id, label: info.label }))}
                  value={assignFormat}
                  onChange={setAssignFormat}
                />
                <p class="reasoning-help">Pool picks set this automatically. Pasted teams are validated against it.</p>
              </div>
            )}
            {mode === 'draft' && (
              <div class="pool-choice">
                <div class="field">
                  <span class="field-label">Draft board</span>
                  <div class="board-fact-card">
                    <b>{board ? board.id : 'No board bundled'}</b>
                    <span>
                      {board
                        ? `${board.monCount} priced species · ${board.budget} points · ${board.picks} picks each`
                        : 'Bundle a board file before starting a draft.'}
                    </span>
                  </div>
                </div>
                <Dropdown
                  id="draftScope"
                  label="Run scope"
                  options={DRAFT_SCOPE_OPTIONS}
                  value={draftOnly ? 'draft-only' : 'season'}
                  onChange={(value) => setDraftOnly(value === 'draft-only')}
                />
                <Dropdown
                  id="teamSheets"
                  label="Team sheets"
                  options={TEAM_SHEET_OPTIONS}
                  value={closedSheets ? 'closed' : 'open'}
                  onChange={(value) => setClosedSheets(value === 'closed')}
                />
                {!draftOnly && (
                  <>
                    <Dropdown
                      id="schedule"
                      label="Schedule"
                      options={DRAFT_SCHEDULE_OPTIONS}
                      value={sequentialWeeks ? 'sequential' : 'parallel'}
                      onChange={(value) => setSequentialWeeks(value === 'sequential')}
                    />
                    <Dropdown
                      id="transactions"
                      label="Roster changes"
                      options={transactionOptions}
                      value={transactions}
                      onChange={setTransactions}
                    />
                  </>
                )}
              </div>
            )}
            <div class="setting-grid">
              {mode === 'rotation' && (
                <div class="field">
                  <label class="field-label" for="series">
                    Series / matchup
                  </label>
                  <input
                    id="series"
                    type="number"
                    min={1}
                    max={20}
                    value={series}
                    onInput={(event) => setSeries(event.currentTarget.value)}
                  />
                </div>
              )}
              {mode !== 'match' && (
                <div class="field">
                  <label class="field-label" for="concurrency">
                    Parallel series
                  </label>
                  <input
                    id="concurrency"
                    type="number"
                    min={1}
                    max={8}
                    value={concurrency}
                    onInput={(event) => setConcurrency(event.currentTarget.value)}
                  />
                </div>
              )}
              <Dropdown
                id="nitroToggle"
                label="OpenRouter routing"
                options={OPENROUTER_ROUTING_OPTIONS}
                value={nitro ? 'nitro' : 'default'}
                onChange={(value) => setNitro(value === 'nitro')}
              />
              <div class="setting-stack wide">
                <div class="reasoning-heading">
                  <span class="field-label">Reasoning assignment</span>
                  <fieldset class="reasoning-mode">
                    <legend class="visually-hidden">Reasoning assignment</legend>
                    <button
                      type="button"
                      aria-pressed={sharedReasoning}
                      class={sharedReasoning ? 'on' : ''}
                      onClick={selectSharedReasoning}
                    >
                      Shared
                    </button>
                    <button
                      type="button"
                      aria-pressed={!sharedReasoning}
                      class={!sharedReasoning ? 'on' : ''}
                      onClick={selectIndividualReasoning}
                    >
                      Per model
                    </button>
                  </fieldset>
                </div>
                {sharedReasoning ? (
                  <>
                    <Dropdown
                      id="reasoning"
                      label="Shared reasoning effort"
                      options={reasoningOptions}
                      value={reasoning}
                      onChange={setReasoning}
                    />
                    <p class="reasoning-help">
                      {reasoningModels.length
                        ? sharedReasoningLevels.length
                          ? `${sharedReasoningLevels.length} level${sharedReasoningLevels.length === 1 ? '' : 's'} supported by every selected model.`
                          : 'The selected models share no configurable level; use provider defaults or assign levels individually.'
                        : 'Random baselines do not use reasoning controls.'}
                    </p>
                  </>
                ) : reasoningModels.length ? (
                  <div class="individual-reasoning">
                    {models.map((model, index) =>
                      model === 'random' ? null : (
                        <Dropdown
                          id={`reasoning-${index}`}
                          key={`${model}-${index}`}
                          label={`${String.fromCharCode(65 + index)} · ${model}`}
                          options={[
                            { value: '', label: 'Provider default' },
                            ...(reasoningLevelsByModel[model] ?? []).map((level) => ({
                              value: level,
                              label: level,
                            })),
                          ]}
                          value={reasoningByModel[model] ?? ''}
                          onChange={(level) => setReasoningByModel((previous) => ({ ...previous, [model]: level }))}
                        />
                      ),
                    )}
                  </div>
                ) : (
                  <p class="reasoning-help">Random baselines do not use reasoning controls.</p>
                )}
              </div>
              <div class="setting-stack wide">
                <Dropdown
                  id="timer-scale"
                  label="Battle timer"
                  options={timerScaleOptions}
                  value={timerScale}
                  onChange={setTimerScale}
                />
                <p class="reasoning-help">
                  {timerScale === 'off'
                    ? 'No Showdown clock is applied. Provider calls still have failure guards.'
                    : 'The Showdown clock caps decision time, so a slow provider can lose a turn to the timer.'}
                </p>
              </div>
              <div class="field wide">
                <label class="field-label" for="seed">
                  Seed
                </label>
                <input
                  id="seed"
                  inputMode="numeric"
                  placeholder="Automatic"
                  value={seed}
                  onInput={(event) => setSeed(event.currentTarget.value)}
                />
              </div>
            </div>
            <div class="run-launch">
              <button type="button" class="button primary" disabled={readiness.disabled} onClick={start}>
                {readiness.label}
              </button>
              <p class="launch-note">{launchNote}</p>
              {launchMsg && (
                <div class="message error" role="alert">
                  {launchMsg}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
      {(mode === 'tournament' || mode === 'rotation') && (
        <details class="pools-manager">
          <summary>Manage team pools</summary>
          <PoolsView app={app} onPools={onPools} />
        </details>
      )}
    </>
  );
}
