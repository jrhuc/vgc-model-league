import { useEffect, useState } from 'preact/hooks';

import type { LegacyObservationIndexResponse } from '../../api';
import { api } from '../http';
import { when } from '../lib/labels';

const MODE_LABELS: Record<string, string> = {
  rotation: 'Rotation',
  draft: 'Draft leagues',
  tournament: 'Tournaments',
  exhibition: 'Exhibitions',
};

interface ArchiveRun {
  mode: string;
  runId: string;
  when: string;
}

function compareArchiveRuns(a: ArchiveRun, b: ArchiveRun): number {
  if (!a.when && b.when) return 1;
  if (a.when && !b.when) return -1;
  return a.when.localeCompare(b.when) || a.runId.localeCompare(b.runId);
}

export function ModelProfileView({
  active,
  model,
  onBack,
  onOpenLeague,
  onOpenTournament,
}: {
  active: boolean;
  model: string;
  onBack: () => void;
  onOpenLeague: (runId: string) => void;
  onOpenTournament: (runId: string) => void;
}) {
  const [profile, setProfile] = useState<LegacyObservationIndexResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !model) return;
    if (profile?.id === model) return;
    setProfile(null);
    setError('');
    api<LegacyObservationIndexResponse>(`/api/model?id=${encodeURIComponent(model)}`)
      .then((response) => {
        setProfile(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, model, profile?.id]);

  if (error) {
    return (
      <div class="league-view research-observation-index">
        <div class="message error">Could not load this model archive: {error}</div>
      </div>
    );
  }
  if (!profile || profile.id !== model) return <p class="muted">Loading the model archive…</p>;

  const modes = [...profile.modes].sort((a, b) =>
    (MODE_LABELS[a.mode] ?? a.mode).localeCompare(MODE_LABELS[b.mode] ?? b.mode),
  );
  const archiveRuns = modes
    .filter((mode) => mode.mode === 'draft' || mode.mode === 'tournament')
    .flatMap((mode) => mode.runs.map((run): ArchiveRun => ({ mode: mode.mode, runId: run.runId, when: run.when })))
    .sort(compareArchiveRuns);

  return (
    <div class="league-view research-observation-index">
      <header class="page-heading league-heading research-index-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← Position Lab
            </button>{' '}
            / model archive
          </p>
          <h1>Model archive</h1>
          <p class="legacy-model-key-value">
            Archive key: <code>{profile.id}</code>
          </p>
        </div>
        <p class="lede research-coverage-span">
          Recorded runs span {when(profile.firstSeen)} to {when(profile.lastSeen)}.
        </p>
      </header>

      <section class="panel legacy-identity-panel" aria-labelledby="legacy-identity-heading">
        <div class="section-head">
          <div>
            <h2 id="legacy-identity-heading">Model identifiers</h2>
            <p>
              Older records group models by the short <code>modelKey</code> shown above.
            </p>
          </div>
        </div>
        <p>These full provider and model identifiers appear in the grouped records:</p>
        {profile.providers.length === 0 ? (
          <p class="muted">No full provider and model identifier is available.</p>
        ) : (
          <ul class="legacy-provider-spec-list">
            {profile.providers.map((provider) => (
              <li key={provider}>
                <code>{provider}</code>
              </li>
            ))}
          </ul>
        )}
        <div class="message legacy-identity-warning">
          The counts below combine every identifier listed above. Provider-specific totals are unavailable.
        </div>
      </section>

      <section class="panel research-coverage-panel" aria-labelledby="coverage-inventory-heading">
        <div class="section-head">
          <div>
            <h2 id="coverage-inventory-heading">Recorded activity</h2>
            <p>These are record counts, not performance results.</p>
          </div>
        </div>
        <div class="message legacy-denominator-warning">
          <b>Count limits.</b> Series and games count each recorded side, so a match with this archive key on both sides
          can be counted twice. Totals for available and missing decision or reflection logs are unavailable.
        </div>
        <div class="table-scroll">
          <table class="data-table research-coverage-table">
            <thead>
              <tr>
                <th>Record type</th>
                <th class="num">Records</th>
                <th>What is counted</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Series</td>
                <td class="num">{profile.series.toLocaleString()}</td>
                <td>Recorded sides in series outside the test pool. Distinct-series totals are unavailable.</td>
              </tr>
              <tr>
                <td>Games</td>
                <td class="num">{profile.games.toLocaleString()}</td>
                <td>Games attached to those recorded sides. Distinct-game totals are unavailable.</td>
              </tr>
              <tr>
                <td>Decisions</td>
                <td class="num">{profile.decisions.toLocaleString()}</td>
                <td>Logged decisions for those sides. Missing-decision totals are unavailable.</td>
              </tr>
              <tr>
                <td>Reflections</td>
                <td class="num">{profile.reflections.toLocaleString()}</td>
                <td>Logged reflections for those sides. Missing-reflection totals are unavailable.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel research-mode-inventory" aria-labelledby="mode-inventory-heading">
        <div class="section-head">
          <div>
            <h2 id="mode-inventory-heading">Recorded modes</h2>
            <p>Recorded series sides, grouped by run type.</p>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table research-mode-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th class="num">Recorded sides</th>
              </tr>
            </thead>
            <tbody>
              {modes.map((mode) => (
                <tr key={mode.mode}>
                  <td>{MODE_LABELS[mode.mode] ?? mode.mode}</td>
                  <td class="num">{mode.series.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel research-archive-chronology" aria-labelledby="archive-chronology-heading">
        <div class="section-head">
          <div>
            <h2 id="archive-chronology-heading">Linked archive runs</h2>
            <p>Recorded leagues and tournaments, oldest first.</p>
          </div>
        </div>
        {archiveRuns.length === 0 ? (
          <p class="muted">No league or tournament run is available for this archive key.</p>
        ) : (
          <div class="table-scroll">
            <table class="data-table research-archive-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Mode</th>
                  <th>Archive run</th>
                </tr>
              </thead>
              <tbody>
                {archiveRuns.map((run) => (
                  <tr key={`${run.mode}:${run.runId}`}>
                    <td>{when(run.when)}</td>
                    <td>{MODE_LABELS[run.mode] ?? run.mode}</td>
                    <td>
                      <button
                        type="button"
                        class="text-link research-archive-link"
                        onClick={() => (run.mode === 'draft' ? onOpenLeague(run.runId) : onOpenTournament(run.runId))}
                      >
                        {run.runId}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
