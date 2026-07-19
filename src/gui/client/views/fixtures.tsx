import { useEffect, useRef, useState } from 'preact/hooks';

import type {
  AppState,
  ModelInfo,
  ModelsResponse,
  PoolInfo,
  ProviderInfo,
  ReasoningLevelsResponse,
  RunSnapshot,
} from '../../api';
import { Dropdown, resolveOption } from '../components/dropdown';
import { api } from '../http';
import { PoolsView } from './pools';

interface FixturesProps {
  app: AppState;
  run: RunSnapshot | null;
  onStarted: () => void;
  onPools: (pools: PoolInfo[]) => void;
}

type RunMode = 'match' | 'tournament' | 'draft' | 'rotation';

const MODES: Array<{ id: RunMode; label: string; hint: string }> = [
  { id: 'match', label: 'Match', hint: 'Two models, two teams, one best-of-three' },
  { id: 'tournament', label: 'Tournament', hint: 'Knockout bracket until a champion' },
  { id: 'draft', label: 'Draft league', hint: 'Snake draft, round robin, playoffs' },
  { id: 'rotation', label: 'Rotation', hint: 'Mirrored round robin for ratings' },
];

function pairings(models: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < models.length; i += 1)
    for (let j = i + 1; j < models.length; j += 1) pairs.push([models[i]!, models[j]!]);
  return pairs;
}

function needsKey(providers: ProviderInfo[], spec: string): boolean {
  if (spec === 'random') return false;
  const providerId = spec.split(':')[0]!;
  const info = providers.find((item) => item.id === providerId);
  return info ? info.requiresKey : providerId !== 'compat';
}

function keyStatus(providers: ProviderInfo[], keys: Record<string, string>, spec: string) {
  if (spec === 'random') return { text: 'Random baseline', cls: '' };
  if (keys[spec]) return { text: 'Run-only key ready', cls: 'good' };
  return needsKey(providers, spec)
    ? { text: 'Bring an API key', cls: 'bad' }
    : { text: 'No key required', cls: 'warn' };
}

function bracketPreview(count: number): string {
  if (count < 2) return '';
  if (count === 2) return 'A direct final — one best-of-three decides it.';
  if (count === 3) return 'One semifinal plus a final; the odd model out gets a bye.';
  let size = 1;
  while (size < count) size *= 2;
  const byes = size - count;
  return `${count - 1} best-of-three series over ${Math.log2(size)} rounds${byes ? ` · ${byes} first-round bye${byes === 1 ? '' : 's'}` : ''}.`;
}

const HEADINGS: Record<RunMode, { eyebrow: string; title: [string, string]; lede: string }> = {
  match: {
    eyebrow: 'Exhibition match',
    title: ['Two models.', 'One best-of-three.'],
    lede: 'Pick two models and hand each a team — paste any Poképaste export or keep the bundled teams. The winner is decided on the pinned Pokémon Showdown simulator.',
  },
  tournament: {
    eyebrow: 'Tournament · protocol v1',
    title: ['Build a', 'knockout bracket.'],
    lede: 'Every model draws one team from the pool and defends it through a single-elimination best-of-three bracket until a champion is crowned. Four or more models make a real bracket; fewer play a direct final.',
  },
  draft: {
    eyebrow: 'Draft league · protocol v1',
    title: ['Draft rosters.', 'Crown a champion.'],
    lede: 'Models snake-draft six fixed sets each from a tiered board under a points budget, explaining every pick. The drafted rosters then play a full round robin and the top seeds meet in playoffs.',
  },
  rotation: {
    eyebrow: 'Rotation · protocol v1',
    title: ['Set up a', 'Rotation run.'],
    lede: 'Pick an immutable team pool and at least two models. Every pairing plays mirrored best-of-three series on the pinned Pokémon Showdown simulator; results are appended to the local record book.',
  },
};

export function FixturesView({ app, run, onStarted, onPools }: FixturesProps) {
  const providers = app.providers.filter((provider) => provider.discovery === 'list' || provider.models.length > 0);
  const [mode, setMode] = useState<RunMode>('match');
  const board = app.boards[0] ?? null;
  const [models, setModels] = useState<string[]>([]);
  const [reasoningLevelsByModel, setReasoningLevelsByModel] = useState<Record<string, string[]>>({});
  const apiKeysRef = useRef<Record<string, string>>({});
  const catalogKeyRef = useRef('');
  const catalogGenerationRef = useRef(0);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [apiKeyText, setApiKeyText] = useState('');
  const [keyHeld, setKeyHeld] = useState(false);
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [catalogProvider, setCatalogProvider] = useState('');
  const [modelText, setModelText] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [setupMsg, setSetupMsg] = useState('');
  const [launchMsg, setLaunchMsg] = useState('');
  const [manualSpec, setManualSpec] = useState('');
  const [manualKey, setManualKey] = useState('');
  const [resolvingManual, setResolvingManual] = useState(false);
  const [pool, setPool] = useState(
    () => app.pools.find((info) => info.name !== 'test')?.name ?? app.pools[0]?.name ?? '',
  );
  const [pastes, setPastes] = useState<[string, string]>([
    app.sampleTeams[0]?.paste ?? '',
    app.sampleTeams[1]?.paste ?? '',
  ]);
  const [series, setSeries] = useState('2');
  const [concurrency, setConcurrency] = useState('2');
  const [reasoning, setReasoning] = useState('');
  const [sharedReasoning, setSharedReasoning] = useState(true);
  const [reasoningByModel, setReasoningByModel] = useState<Record<string, string>>({});
  const [seed, setSeed] = useState('');
  const [starting, setStarting] = useState(false);

  const provider = providers.find((item) => item.id === providerId) ?? null;
  const curated = Boolean(provider && provider.models.length > 0);
  const maxModels = mode === 'match' ? 2 : mode === 'draft' ? (board?.maxEntrants ?? 8) : 8;
  const reasoningModels = models.filter((model) => model !== 'random');
  const sharedReasoningLevels = app.reasoningLevels.filter(
    (level) =>
      reasoningModels.length > 0 && reasoningModels.every((model) => reasoningLevelsByModel[model]?.includes(level)),
  );
  const sharedReasoningKey = sharedReasoningLevels.join('\0');

  useEffect(() => {
    catalogGenerationRef.current += 1;
    setLoadingModels(false);
    setApiKeyText('');
    setKeyHeld(false);
    setSetupMsg('');
    setModelText('');
    catalogKeyRef.current = '';
    const next = providers.find((item) => item.id === providerId);
    if (next && next.models.length > 0) {
      setCatalog(next.models);
      setCatalogProvider(next.id);
    } else {
      setCatalog([]);
      setCatalogProvider('');
    }
  }, [providerId]);

  useEffect(() => {
    if (reasoning && !sharedReasoningLevels.includes(reasoning)) setReasoning('');
  }, [reasoning, sharedReasoningKey]);

  const addModel = (spec: string, key: string, supportedReasoning: string[] = []) => {
    setSetupMsg('');
    if (models.length >= maxModels) {
      setSetupMsg(mode === 'match' ? 'An exhibition match takes exactly two models.' : `At most ${maxModels} models.`);
      return;
    }
    if (key.trim()) apiKeysRef.current[spec] = key.trim();
    setReasoningLevelsByModel((previous) => ({ ...previous, [spec]: supportedReasoning }));
    setModels((previous) => [...previous, spec]);
  };

  const removeModel = (index: number) => {
    setModels((previous) => {
      const next = [...previous];
      const [removed] = next.splice(index, 1);
      if (removed !== undefined && !next.includes(removed)) {
        delete apiKeysRef.current[removed];
        setReasoningLevelsByModel((levels) => {
          const updated = { ...levels };
          delete updated[removed];
          return updated;
        });
        setReasoningByModel((levels) => {
          const updated = { ...levels };
          delete updated[removed];
          return updated;
        });
      }
      return next;
    });
  };

  const connect = () => {
    const apiKey = apiKeyText.trim();
    const selectedProvider = providerId;
    const generation = ++catalogGenerationRef.current;
    setSetupMsg('');
    if (!apiKey) {
      setSetupMsg(`Paste your ${providerId} API key to load its current models.`);
      return;
    }
    setLoadingModels(true);
    api<ModelsResponse>('/api/models', { provider: selectedProvider, apiKey })
      .then((data) => {
        if (generation !== catalogGenerationRef.current) return;
        setCatalog(data.models);
        setCatalogProvider(selectedProvider);
        catalogKeyRef.current = apiKey;
        setModelText('');
        setApiKeyText('');
        setKeyHeld(true);
      })
      .catch((error: Error) => {
        if (generation !== catalogGenerationRef.current) return;
        setCatalog([]);
        setCatalogProvider('');
        catalogKeyRef.current = '';
        setSetupMsg(error.message);
      })
      .finally(() => {
        if (generation === catalogGenerationRef.current) setLoadingModels(false);
      });
  };

  const addFromCatalog = () => {
    if (!provider || !catalog.length) return;
    const option = resolveOption(modelOptions, modelText);
    if (!option) {
      setSetupMsg('Pick a model from the search list first.');
      return;
    }
    const spec = `${provider.id}:${option.value}`;
    const key = catalogKeyRef.current && catalogProvider === provider.id ? catalogKeyRef.current : apiKeyText.trim();
    if (needsKey(providers, spec) && !key) {
      setSetupMsg(`Paste a run-only ${provider.label} key first.`);
      return;
    }
    addModel(spec, key, catalog.find((model) => model.id === option.value)?.reasoningLevels ?? []);
    setApiKeyText('');
    setModelText('');
  };

  const addManual = () => {
    const spec = manualSpec.trim();
    if (!spec || resolvingManual) return;
    if (needsKey(providers, spec) && !manualKey.trim()) {
      setSetupMsg('Bring an API key for this manual provider.');
      return;
    }
    setSetupMsg('');
    setResolvingManual(true);
    api<ReasoningLevelsResponse>(`/api/reasoning?spec=${encodeURIComponent(spec)}`)
      .then((data) => {
        addModel(spec, manualKey, data.levels);
        setManualSpec('');
        setManualKey('');
      })
      .catch((error: Error) => setSetupMsg(error.message))
      .finally(() => setResolvingManual(false));
  };

  const selectSharedReasoning = () => {
    const configured = reasoningModels.map((model) => reasoningByModel[model] ?? '');
    const first = configured[0] ?? '';
    setReasoning(
      first && configured.every((level) => level === first) && sharedReasoningLevels.includes(first) ? first : '',
    );
    setSharedReasoning(true);
  };

  const selectIndividualReasoning = () => {
    if (reasoning) {
      setReasoningByModel((previous) => ({
        ...previous,
        ...Object.fromEntries(reasoningModels.map((model) => [model, reasoning])),
      }));
    }
    setSharedReasoning(false);
  };

  const start = () => {
    setLaunchMsg('');
    setStarting(true);
    const apiKeys: Record<string, string> = {};
    for (const spec of models) if (apiKeysRef.current[spec]) apiKeys[spec] = apiKeysRef.current[spec]!;
    const selectedReasoning = Object.fromEntries(
      Object.entries(reasoningByModel).filter(([model, level]) => models.includes(model) && level),
    );
    const reasoningRequest = sharedReasoning
      ? { ...(reasoning ? { reasoning } : {}) }
      : { ...(Object.keys(selectedReasoning).length ? { reasoningByModel: selectedReasoning } : {}) };
    const request = {
      models,
      apiKeys,
      seed: seed.trim(),
      ...reasoningRequest,
      ...(mode === 'match'
        ? {
            mode: 'tournament',
            teams: [pastes[0], pastes[1]],
            format: app.defaultFormat,
            concurrency: 1,
          }
        : mode === 'tournament'
          ? { mode: 'tournament', pool, concurrency: Number(concurrency) }
          : mode === 'draft'
            ? { mode: 'draft', board: board?.id ?? '', concurrency: Number(concurrency) }
            : { pool, seriesPerPair: Number(series), concurrency: Number(concurrency) }),
    };
    api('/api/run', request)
      .then(() => {
        apiKeysRef.current = {};
        catalogKeyRef.current = '';
        setApiKeyText('');
        setKeyHeld(false);
        setManualKey('');
        onStarted();
      })
      .catch((error: Error) => setLaunchMsg(error.message))
      .finally(() => setStarting(false));
  };

  const providerOptions = providers.map((item) => ({ value: item.id, label: item.label }));
  const modelOptions = catalog.map((model) => ({
    value: model.id,
    label: model.id,
    ...(model.label && model.label !== model.id ? { description: model.label } : {}),
  }));
  const poolOptions = app.pools.map((info) => ({
    value: info.name,
    label: info.name,
    description: `${info.teamCount} teams · ${info.format.replace(/^gen[0-9]+champions/, '')}`,
  }));
  const reasoningOptions = [
    { value: '', label: 'Provider default' },
    ...sharedReasoningLevels.map((level) => ({ value: level, label: level })),
  ];
  const pairs = pairings(models);
  const seriesPerPair = Math.max(1, Number(series) || 1);
  const draftSeries = models.length >= 2 ? pairs.length + (models.length >= 4 ? 3 : 1) : 0;
  const total =
    mode === 'rotation'
      ? pairs.length * seriesPerPair
      : mode === 'draft'
        ? draftSeries
        : Math.max(0, models.length - 1);
  const active = run?.state === 'running';
  const missingKeys = models.filter((spec) => needsKey(providers, spec) && !apiKeysRef.current[spec]);
  const poolInfo = app.pools.find((info) => info.name === pool);
  const shownPairs = pairs.slice(0, 8);
  const heading = HEADINGS[mode];
  const formatLabel = app.formats.find((info) => info.id === app.defaultFormat)?.label ?? app.defaultFormat;

  const missingPaste = mode === 'match' && pastes.some((paste) => !paste.trim());
  const poolTooSmall = mode === 'tournament' && poolInfo !== undefined && poolInfo.teamCount < models.length;
  const boardOverflow = mode === 'draft' && (!board || models.length > board.maxEntrants);
  const startDisabled =
    models.length < 2 ||
    active ||
    missingKeys.length > 0 ||
    starting ||
    (mode === 'match' ? models.length !== 2 || missingPaste : mode === 'draft' ? boardOverflow : !pool || poolTooSmall);
  const startLabel = active
    ? 'Run already in progress'
    : models.length < 2
      ? 'Add two models'
      : missingKeys.length
        ? 'Add run-only API keys'
        : mode === 'match'
          ? models.length !== 2
            ? 'Exactly two models'
            : missingPaste
              ? 'Paste both teams'
              : 'Start the match'
          : mode === 'tournament'
            ? `Start the ${models.length}-model bracket`
            : mode === 'draft'
              ? `Start the ${models.length}-coach draft`
              : `Start ${total} series`;
  const launchNote = active
    ? 'Stop or finish the current run before starting another.'
    : missingKeys.length
      ? `${missingKeys.length} model${missingKeys.length === 1 ? ' needs' : 's need'} a browser-supplied key.`
      : mode === 'match'
        ? `One best-of-three in ${formatLabel}.`
        : mode === 'tournament'
          ? poolTooSmall
            ? `Pool ${pool} has only ${poolInfo?.teamCount} teams for ${models.length} entrants.`
            : bracketPreview(models.length) || 'The bracket updates as you add models.'
          : mode === 'draft'
            ? boardOverflow
              ? `Board ${board?.id ?? ''} supports at most ${board?.maxEntrants ?? 0} coaches.`
              : models.length >= 2
                ? `${models.length * (board?.picks ?? 6)} picks, then ${pairs.length} round-robin and ${models.length >= 4 ? 3 : 1} playoff series.`
                : 'The draft plan updates as you add models.'
            : pairs.length
              ? `${total} best-of-three series, mirrored in pairs · up to ${concurrency} in parallel.`
              : 'The run card updates as you add models.';

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
      <div class="mode-tabs" role="tablist" aria-label="Run mode">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            class={`mode-tab ${mode === item.id ? 'on' : ''}`}
            onClick={() => {
              setMode(item.id);
              setSetupMsg('');
              setLaunchMsg('');
            }}
          >
            <b>{item.label}</b>
            <span>{item.hint}</span>
          </button>
        ))}
      </div>
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
                const status = keyStatus(providers, apiKeysRef.current, spec);
                return (
                  <div class="contender" key={`${spec}-${index}`}>
                    <div class="contender-code">{String.fromCharCode(65 + index)}</div>
                    <div class="contender-name">
                      {spec}
                      <span class={`contender-meta connection ${status.cls}`}>{status.text}</span>
                    </div>
                    <button
                      type="button"
                      class="icon-button"
                      aria-label={`Remove ${spec}`}
                      onClick={() => removeModel(index)}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div class="add-bay">
            <div class="privacy-note">
              <b>Bring your own key</b>
              <span>
                Your key stays in this tab, is sent only for catalog lookup and the run, and is never written to results
                or exposed to other users.
              </span>
            </div>
            <div class="provider-flow">
              <Dropdown
                id="provider"
                label="Provider"
                options={providerOptions}
                value={providerId}
                onChange={setProviderId}
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
                  placeholder={keyHeld ? 'Key held for this fixture' : 'Paste a run-only key'}
                  value={apiKeyText}
                  onInput={(event) => setApiKeyText(event.currentTarget.value)}
                />
              </div>
              {!curated && (
                <button type="button" class="button" disabled={loadingModels} onClick={connect}>
                  Connect &amp; find models
                </button>
              )}
            </div>
            <p class="provider-help">
              {provider
                ? provider.description +
                  (curated ? ' · Built-in catalog; paste a run-only key to add it.' : ' · Your key is not stored.')
                : ''}
            </p>
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
                      : 'Connect a provider first'
                }
                onSubmit={addFromCatalog}
                emptyText="No models match. Use manual entry for an unlisted ID."
              />
              <button type="button" class="button primary" disabled={!catalog.length} onClick={addFromCatalog}>
                Add model
              </button>
              <button type="button" class="button" onClick={() => addModel('random', '', [])}>
                Add random baseline
              </button>
            </div>
            <details class="advanced-entry">
              <summary>Manual model or custom endpoint</summary>
              <div class="manual-flow">
                <div class="field">
                  <label class="field-label" for="manualSpec">
                    Model spec
                  </label>
                  <input
                    id="manualSpec"
                    autocomplete="off"
                    placeholder="compat:https://host/v1:model"
                    value={manualSpec}
                    onInput={(event) => setManualSpec(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addManual();
                    }}
                  />
                </div>
                <div class="field">
                  <label class="field-label" for="manualKey">
                    API key (optional for local endpoints)
                  </label>
                  <input
                    id="manualKey"
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    value={manualKey}
                    onInput={(event) => setManualKey(event.currentTarget.value)}
                  />
                </div>
                <button type="button" class="button" disabled={resolvingManual} onClick={addManual}>
                  {resolvingManual ? 'Checking model…' : 'Add manual model'}
                </button>
              </div>
            </details>
            {setupMsg && (
              <div class="message error" role="alert">
                {setupMsg}
              </div>
            )}
          </div>
          {mode === 'match' ? (
            <div class="team-entry">
              <div class="schedule-title">
                <h3>Teams</h3>
                <span>{formatLabel} · Poképaste export format</span>
              </div>
              <div class="team-paste-grid">
                {([0, 1] as const).map((side) => (
                  <div class="field" key={side}>
                    <label class="field-label" for={`teamPaste${side}`}>
                      Team {side === 0 ? 'A' : 'B'}
                      {models[side] ? ` · ${models[side]}` : ''}
                    </label>
                    <textarea
                      id={`teamPaste${side}`}
                      rows={8}
                      spellcheck={false}
                      value={pastes[side]}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setPastes((previous) => (side === 0 ? [value, previous[1]] : [previous[0], value]));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div class="schedule">
              <div class="schedule-title">
                <h3>Run card</h3>
                <span>
                  {mode === 'tournament'
                    ? models.length >= 2
                      ? `${models.length} entrants · single elimination`
                      : 'Waiting for models'
                    : mode === 'draft'
                      ? models.length >= 2
                        ? `${models.length} coaches · ${total} series after the draft`
                        : 'Waiting for models'
                      : pairs.length
                        ? `${pairs.length} matchup${pairs.length === 1 ? '' : 's'} · ${total} series · mirrored in pairs`
                        : 'Waiting for models'}
                </span>
              </div>
              <div>
                {mode === 'draft' ? (
                  models.length < 2 ? (
                    <p class="muted">Add at least two models to plan the draft.</p>
                  ) : (
                    <p class="muted">
                      Snake draft over {board?.monCount ?? '?'} tiered sets with a {board?.budget ?? '?'}-point budget,
                      then a full round robin seeds the {models.length >= 4 ? 'top-four playoffs' : 'final'}. Every
                      pick's rationale is logged and shown live.
                    </p>
                  )
                ) : mode === 'tournament' ? (
                  models.length < 2 ? (
                    <p class="muted">Add at least two models to build the bracket.</p>
                  ) : (
                    <p class="muted">
                      {bracketPreview(models.length)} Teams are drawn from the pool at random; every model keeps its
                      team for the whole bracket.
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
          )}
        </section>
        <aside class="panel settings" aria-labelledby="settingsTitle">
          <div class="section-head">
            <div>
              <p class="eyebrow">Run conditions</p>
              <h2 id="settingsTitle">Control sheet</h2>
            </div>
          </div>
          <div class="settings-body">
            {(mode === 'tournament' || mode === 'rotation') && (
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
            {mode === 'draft' && (
              <div class="pool-choice">
                <div class="field">
                  <span class="field-label">Draft board</span>
                  <div class="board-fact-card">
                    <b>{board ? board.id : 'No board bundled'}</b>
                    <span>
                      {board
                        ? `${board.monCount} tiered sets · ${board.budget} points · ${board.picks} picks each`
                        : 'Draft runs need a bundled board file.'}
                    </span>
                  </div>
                </div>
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
              <div class="reasoning-settings wide">
                <div class="reasoning-heading">
                  <span class="field-label">Reasoning assignment</span>
                  <fieldset class="reasoning-mode">
                    <legend class="hidden">Reasoning assignment</legend>
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
              <button type="button" class="button primary" disabled={startDisabled} onClick={start}>
                {startLabel}
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
