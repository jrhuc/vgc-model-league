import { useEffect, useRef, useState } from 'preact/hooks';

import type { AppState, ModelInfo, ModelsResponse, ProviderInfo } from '../../api';
import { resolveOption } from '../components/dropdown';
import { api } from '../http';
import { needsProviderKey, type RunMode } from './run-draft';

export function keyStatus(providers: ProviderInfo[], keys: Record<string, string>, spec: string) {
  if (spec === 'random') return { text: 'Random baseline', cls: '' };
  if (keys[spec]) return { text: 'Run-only key ready', cls: 'good' };
  return needsProviderKey(providers, spec)
    ? { text: 'API key required', cls: 'bad' }
    : { text: 'No key required', cls: 'warn' };
}

export function useModelLineup({
  app,
  mode,
  maxModels,
  onAddSlot,
  onRemoveSlot,
}: {
  app: AppState;
  mode: RunMode;
  maxModels: number;
  onAddSlot: (slot: number) => void;
  onRemoveSlot: (slot: number) => void;
}) {
  const providers = app.providers.filter((provider) => provider.id !== 'random');
  const [models, setModels] = useState<string[]>([]);
  const [reasoningLevelsByModel, setReasoningLevelsByModel] = useState<Record<string, string[]>>({});
  const apiKeysRef = useRef<Record<string, string>>({});
  const catalogKeyRef = useRef('');
  const providerSessionsRef = useRef<Record<string, { key: string; catalog: ModelInfo[] }>>({});
  const catalogGenerationRef = useRef(0);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [apiKeyText, setApiKeyText] = useState('');
  const [keyHeld, setKeyHeld] = useState(false);
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [catalogProvider, setCatalogProvider] = useState('');
  const [modelText, setModelText] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [setupMsg, setSetupMsg] = useState('');
  const [manualSpec, setManualSpec] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [sharedReasoning, setSharedReasoning] = useState(true);
  const [reasoningByModel, setReasoningByModel] = useState<Record<string, string>>({});
  const lineupRef = useRef({ models, maxModels, mode });
  lineupRef.current = { models, maxModels, mode };

  const provider = providers.find((item) => item.id === providerId) ?? null;
  const discoverable = provider?.discovery === 'list';
  const reasoningModels = models.filter((model) => model !== 'random');
  const sharedReasoningLevels =
    reasoningModels.length > 0
      ? (reasoningLevelsByModel[reasoningModels[0]!] ?? []).filter((level) =>
          reasoningModels.every((model) => reasoningLevelsByModel[model]?.includes(level)),
        )
      : [];
  const sharedReasoningKey = sharedReasoningLevels.join('\u0000');
  const modelOptions = catalog.map((model) => ({
    value: model.id,
    label: model.id,
    ...(model.label && model.label !== model.id ? { description: model.label } : {}),
  }));

  useEffect(() => {
    catalogGenerationRef.current += 1;
    setLoadingModels(false);
    setApiKeyText('');
    setKeyHeld(false);
    setSetupMsg('');
    setModelText('');
    catalogKeyRef.current = '';
    const session = providerSessionsRef.current[providerId];
    if (session) {
      setCatalog(session.catalog);
      setCatalogProvider(providerId);
      catalogKeyRef.current = session.key;
      setKeyHeld(true);
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
    onAddSlot(slot);
    setModels((previous) => (previous.length >= limit ? previous : [...previous, spec]));
    lineupRef.current = { models: [...current, spec], maxModels: limit, mode: currentMode };
  };

  const removeModel = (index: number) => {
    onRemoveSlot(index);
    setModels((previous) => {
      const next = [...previous];
      const [removed] = next.splice(index, 1);
      if (removed !== undefined && !next.includes(removed)) {
        delete apiKeysRef.current[removed];
        const removedProvider = removed.split(':')[0]!;
        if (!next.some((spec) => spec.startsWith(`${removedProvider}:`))) {
          delete providerSessionsRef.current[removedProvider];
          if (catalogProvider === removedProvider) {
            catalogKeyRef.current = '';
            setKeyHeld(false);
          }
        }
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
        providerSessionsRef.current[selectedProvider] = { key: apiKey, catalog: data.models };
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
    if (!provider || !catalog.length) return;
    const option = resolveOption(modelOptions, modelText);
    if (!option) {
      setSetupMsg('Pick a model from the search list first.');
      return;
    }
    const spec = `${provider.id}:${option.value}`;
    const key = catalogKeyRef.current && catalogProvider === provider.id ? catalogKeyRef.current : apiKeyText.trim();
    if (needsProviderKey(providers, spec) && !key) {
      setSetupMsg(`Paste a run-only ${provider.label} key first.`);
      return;
    }
    addModel(spec, key, catalog.find((model) => model.id === option.value)?.reasoningLevels ?? []);
    setApiKeyText('');
    setModelText('');
  };

  const addManual = () => {
    if (provider?.discovery !== 'manual') return;
    const model = manualSpec.trim();
    if (!model) return;
    const key = apiKeyText.trim();
    if (!key) {
      setSetupMsg(`Paste a run-only ${provider.label} key first.`);
      return;
    }
    setSetupMsg('');
    addModel(`${provider.id}:${model}`, key);
    setManualSpec('');
    setApiKeyText('');
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

  const apiKeys = () =>
    Object.fromEntries(models.flatMap((spec) => (apiKeysRef.current[spec] ? [[spec, apiKeysRef.current[spec]!]] : [])));
  const clearCatalogKey = () => {
    catalogKeyRef.current = '';
    setApiKeyText('');
    setKeyHeld(false);
  };

  return {
    providers,
    models,
    apiKeys,
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
  };
}
