import { useEffect, useRef, useState } from 'preact/hooks';

import type {
  AppState,
  ModelInfo,
  ModelsResponse,
  PokepasteResponse,
  PoolInfo,
  PoolTeamsResponse,
  ProviderInfo,
  ReasoningLevelsResponse,
  RunSnapshot,
  ValidateResponse,
} from '../../api';
import { Dropdown, resolveOption } from '../components/dropdown';
import { api } from '../http';
import { PoolsView } from './pools';

interface FixturesProps {
  app: AppState;
  run: RunSnapshot | null;
  onStarted: (run: RunSnapshot) => void;
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
    title: ['Two models.', 'One best-of-three.'],
    lede: 'Pick two models and assign each a team from a pool or a Poképaste export. The match runs on the pinned Pokémon Showdown simulator.',
  },
  tournament: {
    eyebrow: 'Tournament · protocol v1',
    title: ['Build a', 'knockout bracket.'],
    lede: 'Assign each model a team from a pool draw or by hand. Models keep that team through a single-elimination best-of-three bracket.',
  },
  draft: {
    eyebrow: 'Draft league · protocol v1',
    title: ['Draft rosters.', 'Crown a champion.'],
    lede: 'Models snake-draft six fixed sets each from a tiered board under a points budget. Rosters then play a round robin, and the top seeds meet in playoffs.',
  },
  rotation: {
    eyebrow: 'Rotation · protocol v1',
    title: ['Set up a', 'Rotation run.'],
    lede: 'Pick an immutable team pool and at least two models. Every pairing plays mirrored best-of-three series. Results append to the local record book.',
  },
};

export interface TeamAssignment {
  paste: string;
  label: string;
}

function TeamEditor({
  slot,
  spec,
  team,
  pools,
  poolTeams,
  onLoadPool,
  onAssign,
  formatLabel,
  format,
  onDone,
}: {
  slot: number;
  spec: string;
  team: TeamAssignment | null;
  pools: PoolInfo[];
  poolTeams: Record<string, PoolTeamsResponse | 'loading' | { error: string } | undefined>;
  onLoadPool: (name: string, force?: boolean) => void;
  onAssign: (team: TeamAssignment | null, format?: string) => void;
  formatLabel: string;
  format: string;
  onDone: () => void;
}) {
  const [selPool, setSelPool] = useState(
    () => pools.find((info) => info.name !== 'test')?.name ?? pools[0]?.name ?? '',
  );
  const [selTeam, setSelTeam] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [pasteLink, setPasteLink] = useState('');
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (selPool) onLoadPool(selPool);
  }, [selPool]);
  const loaded = poolTeams[selPool];
  const teams = loaded && typeof loaded === 'object' && 'teams' in loaded ? loaded : null;
  const teamOptions = teams ? teams.teams.map((entry) => ({ value: entry.name, label: entry.name })) : [];
  const insert = () => {
    if (!teams) return;
    const found = teams.teams.find((entry) => entry.name === selTeam);
    if (!found) return;
    onAssign({ paste: found.paste, label: `${selPool} · ${found.name}` }, teams.format);
    onDone();
  };
  const validatePaste = (paste: string) => {
    if (!paste.trim()) return;
    setChecking(true);
    setProblems([]);
    api<ValidateResponse>('/api/team/validate', { paste, format })
      .then((data) => {
        if (data.problems.length) {
          setProblems(data.problems);
          return;
        }
        onAssign({ paste, label: `Pasted team ✓ (${data.species.length})` });
        onDone();
      })
      .catch((error: Error) => setProblems([error.message]))
      .finally(() => setChecking(false));
  };
  const importPokepaste = () => {
    if (!pasteLink.trim() || importing) return;
    setImporting(true);
    setProblems([]);
    api<PokepasteResponse>('/api/team/pokepaste', { url: pasteLink.trim() })
      .then((data) => {
        onAssign({ paste: data.paste, label: 'Poképaste import' });
        setPasteLink('');
        validatePaste(data.paste);
      })
      .catch((error: Error) => setProblems([error.message]))
      .finally(() => setImporting(false));
  };
  const clearTeam = () => {
    setProblems([]);
    setPasteLink('');
    onAssign(null);
  };
  return (
    <div class="team-editor">
      <div class="team-editor-head">
        <b>
          Team {String.fromCharCode(65 + slot)} · {spec}
        </b>
        <span>{formatLabel} · Poképaste export</span>
      </div>
      {pools.length > 0 && (
        <div class="team-editor-pool">
          <Dropdown
            id={`teamPool${slot}`}
            label="From pool"
            options={pools.map((info) => ({
              value: info.name,
              label: info.name,
              description: `${info.teamCount} teams`,
            }))}
            value={selPool}
            onChange={(name) => {
              setSelPool(name);
              setSelTeam('');
            }}
          />
          <Dropdown
            id={`teamPick${slot}`}
            label="Pool team"
            options={teamOptions}
            value={selTeam}
            onChange={setSelTeam}
            placeholder={
              loaded === 'loading'
                ? 'Loading teams…'
                : loaded && typeof loaded === 'object' && 'error' in loaded
                  ? 'Pool teams unavailable'
                  : 'Pick a team'
            }
            disabled={loaded === 'loading' || (loaded !== undefined && typeof loaded === 'object' && 'error' in loaded)}
          />
          <button type="button" class="button" disabled={!selTeam || !teams} onClick={insert}>
            Use this team
          </button>
        </div>
      )}
      {loaded && typeof loaded === 'object' && 'error' in loaded && (
        <div class="message error" role="alert">
          {loaded.error}{' '}
          <button type="button" class="button" onClick={() => onLoadPool(selPool, true)}>
            Retry
          </button>
        </div>
      )}
      <div class="field">
        <label class="field-label" for={`teamLink${slot}`}>
          Import from a Poképaste link
        </label>
        <div class="paste-import">
          <input
            id={`teamLink${slot}`}
            autocomplete="off"
            spellcheck={false}
            placeholder="https://pokepast.es/0123456789abcdef"
            value={pasteLink}
            onInput={(event) => setPasteLink(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') importPokepaste();
            }}
          />
          <button type="button" class="button" disabled={importing || !pasteLink.trim()} onClick={importPokepaste}>
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for={`teamPaste${slot}`}>
          Or paste a team
        </label>
        <textarea
          id={`teamPaste${slot}`}
          rows={8}
          spellcheck={false}
          value={team?.paste ?? ''}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setProblems([]);
            onAssign(value.trim() ? { paste: value, label: 'Pasted team' } : null);
          }}
        />
        <div class="paste-actions">
          <button
            type="button"
            class="button"
            disabled={checking || !team?.paste.trim()}
            onClick={() => validatePaste(team?.paste ?? '')}
          >
            {checking ? 'Validating…' : 'Validate team'}
          </button>
          <button type="button" class="button" disabled={checking || !team} onClick={clearTeam}>
            Clear team
          </button>
        </div>
        {problems.length > 0 && (
          <div class="message error" role="alert">
            {problems.join('\n')}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [teamSource, setTeamSource] = useState<'pool' | 'custom'>('pool');
  const [teamBySlot, setTeamBySlot] = useState<Array<TeamAssignment | null>>([]);
  const [editingTeam, setEditingTeam] = useState<number | null>(null);
  const [assignFormat, setAssignFormat] = useState(app.defaultFormat);
  const [poolTeams, setPoolTeams] = useState<
    Record<string, PoolTeamsResponse | 'loading' | { error: string } | undefined>
  >({});
  const [series, setSeries] = useState('2');
  const [concurrency, setConcurrency] = useState('2');
  const [reasoning, setReasoning] = useState('');
  const [sharedReasoning, setSharedReasoning] = useState(true);
  const [reasoningByModel, setReasoningByModel] = useState<Record<string, string>>({});
  const [seed, setSeed] = useState('');
  const [starting, setStarting] = useState(false);

  const provider = providers.find((item) => item.id === providerId) ?? null;
  const curated = Boolean(provider && provider.models.length > 0);
  const maxModels = mode === 'match' ? 2 : mode === 'draft' ? Math.min(8, board?.maxEntrants ?? 8) : 8;
  const teamsMode = mode === 'match' || (mode === 'tournament' && teamSource === 'custom');
  const lineupRef = useRef({ models, maxModels, mode });
  lineupRef.current = { models, maxModels, mode };
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
    const { models: current, maxModels: limit, mode: currentMode } = lineupRef.current;
    if (current.length >= limit) {
      setSetupMsg(
        currentMode === 'match' ? 'An exhibition match takes exactly two models.' : `At most ${limit} models.`,
      );
      return;
    }
    const slot = current.length;
    if (key.trim()) apiKeysRef.current[spec] = key.trim();
    setReasoningLevelsByModel((previous) => ({ ...previous, [spec]: supportedReasoning }));
    const sample = currentMode === 'match' ? app.sampleTeams[slot] : undefined;
    setTeamBySlot((previous) => [
      ...previous,
      sample ? { paste: sample.paste, label: `Sample · ${sample.name}` } : null,
    ]);
    setModels((previous) => (previous.length >= limit ? previous : [...previous, spec]));
    lineupRef.current = { models: [...current, spec], maxModels: limit, mode: currentMode };
  };

  const removeModel = (index: number) => {
    setEditingTeam(null);
    setTeamBySlot((previous) => {
      const next = [...previous];
      next.splice(index, 1);
      return next;
    });
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
        for (const spec of lineupRef.current.models) {
          if (spec.startsWith(`${selectedProvider}:`)) apiKeysRef.current[spec] = apiKey;
        }
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
    if (!provider || !catalog.length || resolvingManual) return;
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
    const key = manualKey;
    api<ReasoningLevelsResponse>(`/api/reasoning?spec=${encodeURIComponent(spec)}`)
      .then((data) => {
        const { models: current, maxModels: limit, mode: currentMode } = lineupRef.current;
        if (current.length >= limit) {
          setSetupMsg(
            currentMode === 'match' ? 'An exhibition match takes exactly two models.' : `At most ${limit} models.`,
          );
          return;
        }
        addModel(spec, key, data.levels);
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
            teams: models.map((_, index) => teamBySlot[index]?.paste ?? ''),
            format: assignFormat,
            concurrency: 1,
          }
        : mode === 'tournament'
          ? teamSource === 'custom'
            ? {
                mode: 'tournament',
                teams: models.map((_, index) => teamBySlot[index]?.paste ?? ''),
                format: assignFormat,
                concurrency: Number(concurrency),
              }
            : { mode: 'tournament', pool, concurrency: Number(concurrency) }
          : mode === 'draft'
            ? { mode: 'draft', board: board?.id ?? '', concurrency: Number(concurrency) }
            : { pool, seriesPerPair: Number(series), concurrency: Number(concurrency) }),
    };
    api('/api/run', request)
      .then(() => api<AppState>('/api/state'))
      .then((state) => {
        if (!state.run) throw new Error('The run started, but its live state is unavailable.');
        catalogKeyRef.current = '';
        setApiKeyText('');
        setKeyHeld(false);
        setManualKey('');
        onStarted(state.run);
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
  const formatLabel = app.formats.find((info) => info.id === assignFormat)?.label ?? assignFormat;

  const missingTeam = teamsMode && models.some((_, index) => !teamBySlot[index]?.paste.trim());
  const poolTooSmall =
    mode === 'tournament' && teamSource === 'pool' && poolInfo !== undefined && poolInfo.teamCount < models.length;
  const boardOverflow = mode === 'draft' && (!board || models.length > board.maxEntrants);
  const startDisabled =
    models.length < 2 ||
    active ||
    missingKeys.length > 0 ||
    starting ||
    (mode === 'match'
      ? models.length !== 2 || missingTeam
      : mode === 'draft'
        ? boardOverflow
        : mode === 'tournament' && teamSource === 'custom'
          ? missingTeam
          : !pool || poolTooSmall);
  const startLabel = active
    ? 'Run already in progress'
    : models.length < 2
      ? 'Add two models'
      : missingKeys.length
        ? 'Add run-only API keys'
        : mode === 'match'
          ? models.length !== 2
            ? 'Exactly two models'
            : missingTeam
              ? 'Assign both teams'
              : 'Start the match'
          : mode === 'tournament'
            ? missingTeam
              ? 'Assign every team'
              : `Start the ${models.length}-model bracket`
            : mode === 'draft'
              ? `Start the ${models.length}-coach draft`
              : `Start ${total} series`;
  const launchNote = active
    ? 'Stop or finish the current run before starting another.'
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
                ? `${models.length * (board?.picks ?? 6)} picks, then ${pairs.length} round-robin and ${models.length >= 4 ? 3 : 1} playoff series.`
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
                const status = keyStatus(providers, apiKeysRef.current, spec);
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
              {!curated && (
                <button type="button" class="button" disabled={loadingModels} onClick={connect}>
                  Connect &amp; find models
                </button>
              )}
            </div>
            <p class="provider-help">
              {provider
                ? provider.description +
                  (curated ? ' · Built-in catalog. Paste a run-only key to add it.' : ' · Your key is not stored.')
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
                emptyText="No matching models. Use manual entry for an unlisted ID."
              />
              <button
                type="button"
                class="button primary"
                disabled={!catalog.length || resolvingManual}
                onClick={addFromCatalog}
              >
                Add model
              </button>
              <button
                type="button"
                class="button"
                disabled={resolvingManual}
                onClick={() => addModel('random', '', [])}
              >
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
                        ? `${models.length} coaches · ${total} series after the draft`
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
                ) : (
                  <p class="muted">
                    Snake draft over {board?.monCount ?? '?'} tiered sets with a {board?.budget ?? '?'}-point budget. A
                    full round robin then seeds the {models.length >= 4 ? 'top-four playoffs' : 'final'}. Pick notes
                    appear live in the arena.
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
              <p class="eyebrow">Run conditions</p>
              <h2 id="settingsTitle">Control sheet</h2>
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
                        ? `${board.monCount} tiered sets · ${board.budget} points · ${board.picks} picks each`
                        : 'Bundle a board file before starting a draft.'}
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
