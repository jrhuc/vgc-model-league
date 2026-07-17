import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppState, ModelInfo, ModelsResponse, ProviderInfo, RunSnapshot } from '../../api';
import { Dropdown, resolveOption } from '../components/dropdown';
import { api } from '../http';

interface FixturesProps {
  app: AppState;
  run: RunSnapshot | null;
  onStarted: () => void;
}

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

export function FixturesView({ app, run, onStarted }: FixturesProps) {
  const providers = app.providers.filter((provider) => provider.discovery === 'list' || provider.models.length > 0);
  const [models, setModels] = useState<string[]>([]);
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
  const [pool, setPool] = useState(
    () => app.pools.find((info) => info.name !== 'test')?.name ?? app.pools[0]?.name ?? '',
  );
  const [series, setSeries] = useState('2');
  const [concurrency, setConcurrency] = useState('2');
  const [reasoning, setReasoning] = useState('');
  const [seed, setSeed] = useState('');
  const [starting, setStarting] = useState(false);

  const provider = providers.find((item) => item.id === providerId) ?? null;
  const curated = Boolean(provider && provider.models.length > 0);

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

  const addModel = (spec: string, key: string) => {
    setSetupMsg('');
    if (key.trim()) apiKeysRef.current[spec] = key.trim();
    setModels((previous) => [...previous, spec]);
  };

  const removeModel = (index: number) => {
    setModels((previous) => {
      const next = [...previous];
      const [removed] = next.splice(index, 1);
      if (removed !== undefined && !next.includes(removed)) delete apiKeysRef.current[removed];
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
    addModel(spec, key);
    setApiKeyText('');
    setModelText('');
  };

  const addManual = () => {
    const spec = manualSpec.trim();
    if (!spec) return;
    if (needsKey(providers, spec) && !manualKey.trim()) {
      setSetupMsg('Bring an API key for this manual provider.');
      return;
    }
    addModel(spec, manualKey);
    setManualSpec('');
    setManualKey('');
  };

  const start = () => {
    setLaunchMsg('');
    setStarting(true);
    const apiKeys: Record<string, string> = {};
    for (const spec of models) if (apiKeysRef.current[spec]) apiKeys[spec] = apiKeysRef.current[spec]!;
    api('/api/run', {
      models,
      apiKeys,
      pool,
      seriesPerPair: Number(series),
      concurrency: Number(concurrency),
      seed: seed.trim(),
      reasoning: reasoning || undefined,
    })
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
    ...app.reasoningLevels.map((level) => ({ value: level, label: level })),
  ];
  const pairs = pairings(models);
  const seriesPerPair = Math.max(1, Number(series) || 1);
  const total = pairs.length * seriesPerPair;
  const active = run?.state === 'running';
  const missingKeys = models.filter((spec) => needsKey(providers, spec) && !apiKeysRef.current[spec]);
  const poolInfo = app.pools.find((info) => info.name === pool);
  const shownPairs = pairs.slice(0, 8);
  const startDisabled = models.length < 2 || active || !pool || missingKeys.length > 0 || starting;
  const startLabel = active
    ? 'Run already in progress'
    : models.length < 2
      ? 'Add two models'
      : missingKeys.length
        ? 'Add run-only API keys'
        : `Start ${total} series`;
  const launchNote = active
    ? 'Stop or finish the current run before starting another.'
    : missingKeys.length
      ? `${missingKeys.length} model${missingKeys.length === 1 ? ' needs' : 's need'} a browser-supplied key.`
      : pairs.length
        ? `${total} best-of-three series, mirrored in pairs · up to ${concurrency} in parallel.`
        : 'The run card updates as you add models.';

  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Rotation · protocol v1</p>
          <h1>
            Set up a
            <br />
            Rotation run.
          </h1>
        </div>
        <p class="lede">
          Pick an immutable team pool and at least two models. Every pairing plays mirrored best-of-three series on the
          pinned Pokémon Showdown simulator; results are appended to the local record book.
        </p>
      </div>
      <div class="fixture-layout">
        <section class="panel stage" aria-labelledby="lineupTitle">
          <div class="section-head">
            <div>
              <h2 id="lineupTitle">Model lineup</h2>
              <p>Two models make a head-to-head. Three or more make a round robin.</p>
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
              <button type="button" class="button" onClick={() => addModel('random', '')}>
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
                <button type="button" class="button" onClick={addManual}>
                  Add manual model
                </button>
              </div>
            </details>
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
                {pairs.length
                  ? `${pairs.length} matchup${pairs.length === 1 ? '' : 's'} · ${total} series · mirrored in pairs`
                  : 'Waiting for models'}
              </span>
            </div>
            <div>
              {pairs.length === 0 ? (
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
              <p class="eyebrow">Run conditions</p>
              <h2 id="settingsTitle">Control sheet</h2>
            </div>
          </div>
          <div class="settings-body">
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
            <div class="setting-grid">
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
              <div class="wide">
                <Dropdown
                  id="reasoning"
                  label="Reasoning effort"
                  options={reasoningOptions}
                  value={reasoning}
                  onChange={setReasoning}
                />
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
    </>
  );
}
