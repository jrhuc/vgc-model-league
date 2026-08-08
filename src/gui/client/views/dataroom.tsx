import { useEffect, useMemo, useState } from 'preact/hooks';

import type { ResearchArtifactView, ResearchResponse } from '../../api';
import { ArtifactLineage, ArtifactSummary, LegacyInventory } from '../components/research/artifact-lineage';
import { ErrorList } from '../components/research/feedback';
import { titleCase } from '../components/research/format';
import { ProtocolExplorer } from '../components/research/protocol-explorer';
import { ReleaseGates } from '../components/research/release-gates';
import { SplitBalance } from '../components/research/split-balance';
import { TaskBrowser } from '../components/research/task-browser';
import { ViewerBounds } from '../components/research/viewer-bounds';
import { api } from '../http';
import { decodeResearchResponse } from '../lib/research-response';

interface DataRoomViewProps {
  active: boolean;
  epoch: number;
}

export function DataRoomView({ active, epoch }: DataRoomViewProps) {
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [selectedKind, setSelectedKind] = useState<ResearchArtifactView['kind']>('frozen');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError('');
    setData(null);
    api<unknown>('/api/research')
      .then((response) => decodeResearchResponse(response))
      .then((response) => {
        if (!current) return;
        setData(response);
        setLoading(false);
      })
      .catch((failure: Error) => {
        if (!current) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, epoch]);

  const artifacts = useMemo(
    () =>
      [...(data?.artifacts ?? [])].sort((first, second) =>
        first.kind === second.kind ? 0 : first.kind === 'pilot' ? -1 : 1,
      ),
    [data],
  );
  const selected = artifacts.find((artifact) => artifact.kind === selectedKind) ?? artifacts[0] ?? null;

  return (
    <div class="research-view position-lab-view">
      <header class="page-heading research-heading">
        <div>
          <p class="eyebrow">Research / public artifacts</p>
          <h1>Position Lab / Artifact Room.</h1>
        </div>
        <p class="lede">
          Inspect schema-v2 artifact lineage, declared protocols, provenance digests, release gates, frozen split
          balance, and bounded model-visible position tasks. Comparative outcome telemetry does not belong here.
        </p>
      </header>

      <aside class="research-privacy-boundary" aria-label="Public artifact boundary">
        <b>Public boundary.</b> This view receives no score rows, sealed panels, source records, simulator snapshots,
        opponent requests, or rollout matrices. It is a viewer, not a scoring authority.
      </aside>

      {loading ? (
        <section class="panel research-loading-state" role="status" aria-live="polite">
          <p class="muted">Loading public research artifacts…</p>
        </section>
      ) : null}
      {error ? (
        <div class="message error" role="alert">
          Could not load public research artifacts: {error}
        </div>
      ) : null}
      {data && data.errors.length > 0 ? (
        <section class="message error research-root-errors" role="alert">
          <b>Some public artifacts were rejected.</b>
          <ErrorList errors={data.errors} />
        </section>
      ) : null}
      {data && data.warnings.length > 0 ? (
        <section class="notice-strip research-root-warnings" role="status" aria-live="polite">
          <b>Public boundary notice.</b>
          <ErrorList errors={data.warnings} />
        </section>
      ) : null}
      {data ? <LegacyInventory legacy={data.legacyPositions} /> : null}

      {data && data.status === 'empty' && artifacts.length === 0 ? (
        <section class="panel research-empty-state" role="status">
          <p class="eyebrow">
            {data.program.positions.target} / {titleCase(data.program.positions.stage)}
          </p>
          <h2>No schema-v2 public position artifact is available.</h2>
          <p>
            This is an empty research state, not a zero score or a successful release. Legacy position rows are not
            silently upgraded into manifests, validation results, or tasks.
          </p>
        </section>
      ) : null}

      {data && data.status !== 'empty' && artifacts.length === 0 ? (
        <section class="panel research-empty-state" role="alert">
          <p class="eyebrow">Degraded</p>
          <h2>No public artifact passed the discovery boundary.</h2>
          <p>Review the reported validation errors. No metadata or task rows are inferred from malformed files.</p>
        </section>
      ) : null}

      {data && selected ? (
        <>
          <ArtifactLineage artifacts={artifacts} selected={selected} onSelect={setSelectedKind} />
          <ArtifactSummary artifact={selected} />
          <ProtocolExplorer artifact={selected} />
          <ReleaseGates artifact={selected} />
          <SplitBalance artifact={selected} />
          <TaskBrowser key={selected.kind} artifact={selected} />
          <ViewerBounds data={data} />
        </>
      ) : null}
    </div>
  );
}
