import { useEffect, useState } from 'preact/hooks';

import type { ModelProfileResponse, QuartileView } from '../../api';
import { StatTile } from '../components/chartkit';
import { Mark } from '../components/mark';
import { api } from '../http';
import { when } from '../lib/labels';

function seconds(ms: number): string {
  return ms >= 100_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function pct(value: number | null): string {
  return value === null ? '–' : `${(100 * value).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

function tokensLabel(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  return tokens.toLocaleString();
}

function quartileText(quartile: QuartileView | null, format: (value: number) => string): string {
  if (!quartile) return 'no logged decisions';
  return `IQR ${format(quartile.p25)}–${format(quartile.p75)}`;
}

const MODE_LABELS: Record<string, string> = {
  rotation: 'Rotation',
  draft: 'Draft leagues',
  tournament: 'Tournaments',
  exhibition: 'Exhibitions',
};

interface RateRow {
  label: string;
  title: string;
  value: string;
}

function RatesPanel({ heading, blurb, rows }: { heading: string; blurb: string; rows: RateRow[] }) {
  return (
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>{heading}</h2>
          <p>{blurb}</p>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table profile-rates">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td title={row.title}>{row.label}</td>
                <td class="num">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
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
  const [profile, setProfile] = useState<ModelProfileResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !model) return;
    if (profile?.id === model) return;
    setProfile(null);
    api<ModelProfileResponse>(`/api/model?id=${encodeURIComponent(model)}`)
      .then((response) => {
        setProfile(response);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, model, profile?.id]);

  if (error) {
    return (
      <div class="league-view">
        <div class="message error">Could not load this model: {error}</div>
      </div>
    );
  }
  if (!profile || profile.id !== model) return <p class="muted">Loading the profile…</p>;

  const decisions = Math.max(1, profile.decisions);
  const wins = profile.modes.reduce((total, mode) => total + mode.w, 0);
  const losses = profile.modes.reduce((total, mode) => total + mode.l, 0);
  const playRows: RateRow[] = [
    { label: 'Switch share', title: 'Switch share of action selections', value: pct(profile.rates.switch) },
    { label: 'Protect share', title: 'Protect share of action selections', value: pct(profile.rates.protect) },
    { label: 'Spread moves', title: 'Spread-move share of move selections', value: pct(profile.rates.spread) },
    { label: 'Ally targeting', title: 'Ally-targeted moves per move selection', value: pct(profile.rates.allyTarget) },
    {
      label: 'Megas per game',
      title: 'Mega Evolutions clicked per game',
      value: profile.rates.megaPerGame.toFixed(2),
    },
    {
      label: 'Tool lookups',
      title: 'Mechanics tool lookups per decision',
      value: profile.rates.toolLookups.toFixed(2),
    },
    {
      label: 'Repeated joint actions',
      title: 'Turns repeating the exact previous joint action',
      value: pct(profile.rates.repeatedActions),
    },
    {
      label: 'Bring changes',
      title: 'Changed the four brought between games of a series',
      value: pct(profile.rates.bringChanges),
    },
    {
      label: 'Lead changes',
      title: 'Changed the two leads between games of a series',
      value: pct(profile.rates.leadChanges),
    },
  ];
  const reliabilityRows: RateRow[] = [
    { label: 'Fallbacks', title: 'Decisions replaced by the first legal option', value: pct(profile.rates.fallback) },
    {
      label: 'Parse failures',
      title: 'Replies that failed parsing, per decision',
      value: pct(profile.rates.parseFailure),
    },
    {
      label: 'Provider retries',
      title: 'Provider retries per decision',
      value: profile.rates.providerRetry.toFixed(2),
    },
    { label: 'Abandoned decisions', title: 'Decisions abandoned entirely', value: pct(profile.rates.abandoned) },
    {
      label: 'Reflection fallbacks',
      title: 'Between-game reflections that fell back',
      value: pct(profile.rates.reflectionFallback),
    },
  ];

  return (
    <div class="league-view">
      <header class="page-heading league-heading">
        <div>
          <p class="eyebrow">
            <button type="button" class="text-link" onClick={onBack}>
              ← Data room
            </button>{' '}
            / model profile
          </p>
          <h1 class="profile-title">
            <Mark spec={profile.id} size={28} />
            {profile.id}.
          </h1>
        </div>
        <p class="lede">
          Seen as {profile.providers.join(', ')} from {when(profile.firstSeen)} to {when(profile.lastSeen)}. Aggregated
          across every mode outside the test pool.
        </p>
      </header>

      <div class="stat-row">
        <StatTile
          label="Series"
          value={`${wins}-${losses}`}
          note={`${profile.series} series, ${profile.games} games`}
        />
        <StatTile
          label="Decisions"
          value={profile.decisions.toLocaleString()}
          note={`${profile.reflections} reflections`}
        />
        <StatTile
          label="Median decision"
          value={profile.latency ? seconds(profile.latency.median) : '–'}
          note={quartileText(profile.latency, seconds)}
        />
        <StatTile
          label="Tokens"
          value={tokensLabel(profile.totalTokens)}
          note={
            profile.reasoningTokens !== null
              ? `${tokensLabel(Math.round(profile.reasoningTokens / decisions))} reasoning per decision`
              : 'no reasoning breakdown reported'
          }
        />
        {profile.cost !== null ? (
          <StatTile label="Known cost" value={`$${profile.cost.toFixed(2)}`} note="metered API spend" />
        ) : null}
      </div>

      <div class="results-grid">
        <RatesPanel
          heading="Play profile"
          blurb="How this model plays, counted across every logged decision."
          rows={playRows}
        />
        <RatesPanel
          heading="Reliability"
          blurb="Scaffold health: where responses failed and what it cost."
          rows={reliabilityRows}
        />
      </div>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>Records by mode</h2>
            <p>Series records per mode, with links to the stored events.</p>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th class="num">Series</th>
                <th class="num">W-L</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {profile.modes.map((mode) => (
                <tr key={mode.mode}>
                  <td>{MODE_LABELS[mode.mode] ?? mode.mode}</td>
                  <td class="num">{mode.series}</td>
                  <td class="num">
                    {mode.w}-{mode.l}
                  </td>
                  <td>
                    {mode.runs.length === 0 ? (
                      <span class="muted">–</span>
                    ) : (
                      mode.runs.map((run) => (
                        <button
                          key={run.runId}
                          type="button"
                          class="text-link event-link"
                          onClick={() =>
                            mode.mode === 'draft' ? onOpenLeague(run.runId) : onOpenTournament(run.runId)
                          }
                        >
                          {when(run.when)}
                        </button>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
