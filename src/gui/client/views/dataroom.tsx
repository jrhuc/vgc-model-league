import { useEffect, useMemo, useState } from 'preact/hooks';

import type { EvidenceResponse, ModelEvidence, RecordsResponse, SeriesLuckEntry } from '../../api';
import { barPath, StatTile, Tooltip, useTip } from '../components/chartkit';
import { Dropdown } from '../components/dropdown';
import { Mark } from '../components/mark';
import { api } from '../http';

const BLUE = 'var(--chart-blue)';
const RED = 'var(--chart-red)';
const INK = 'var(--chart-ink)';
const LINE = 'var(--chart-line)';
const GRAY = 'var(--chart-gray)';

function seconds(ms: number): string {
  return ms >= 100_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function pct(value: number | null): string {
  return value === null ? '–' : `${(100 * value).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

function perDecision(value: number | null): string {
  return value === null ? '–' : value.toFixed(2);
}

const STRIP = { label: 220, plot: 520, median: 74, tokens: 90, row: 27, top: 26, bottom: 8 };

function LatencyStrip({ models }: { models: ModelEvidence[] }) {
  const [tip, showTip, hideTip] = useTip();
  const ranked = models
    .filter((model) => model.latency && model.points.length > 0)
    .sort((a, b) => a.spec.localeCompare(b.spec));
  if (ranked.length === 0) return <div class="results-empty">Decision logs appear after the first recorded run.</div>;
  const tokensSeen = ranked.some((model) => model.tokens);
  const values = ranked.flatMap((model) => model.points.map((point) => point.ms));
  const low = Math.max(1000, Math.min(...values) * 0.85);
  const high = Math.max(...values) * 1.1;
  const x = (ms: number) =>
    STRIP.label + ((Math.log(ms) - Math.log(low)) / (Math.log(high) - Math.log(low))) * STRIP.plot;
  const ticks = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000].filter(
    (tick) => tick >= low && tick <= high,
  );
  const width = STRIP.label + STRIP.plot + STRIP.median + (tokensSeen ? STRIP.tokens : 0);
  const medianX = STRIP.label + STRIP.plot + STRIP.median - 6;
  const height = STRIP.top + ranked.length * STRIP.row + STRIP.bottom;
  return (
    <div class="chart-host">
      <div class="table-scroll">
        <svg width={width} height={height} role="img" aria-label="Decision latency by model">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={STRIP.top - 8} y2={height - STRIP.bottom} stroke={LINE} />
              <text x={x(tick)} y={STRIP.top - 13} text-anchor="middle" class="chart-tick">
                {tick >= 60_000 ? `${tick / 60_000}m` : `${tick / 1000}s`}
              </text>
            </g>
          ))}
          {ranked.map((model, index) => {
            const y = STRIP.top + index * STRIP.row + STRIP.row / 2;
            const stat = model.latency!;
            return (
              <g key={model.spec}>
                <text x={STRIP.label - 12} y={y + 3.5} text-anchor="end" class="chart-label">
                  <title>
                    {model.spec} · {model.points.length} logged decisions
                  </title>
                  {model.spec}
                </text>
                <rect
                  x={x(stat.p25)}
                  y={y - 7}
                  width={Math.max(1, x(stat.p75) - x(stat.p25))}
                  height={14}
                  fill={BLUE}
                  opacity={0.1}
                />
                {model.points.map((point, pointIndex) => (
                  /* biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip supplements the visible median labels */
                  <circle
                    key={pointIndex}
                    aria-label={`${model.spec} game ${point.game} turn ${point.turn}: ${seconds(point.ms)}`}
                    cx={x(point.ms)}
                    cy={y}
                    r={4}
                    fill={BLUE}
                    fill-opacity={0.3}
                    stroke="#ffffff"
                    stroke-width={1}
                    onMouseMove={(event) =>
                      showTip(event as unknown as MouseEvent, [
                        `${model.spec}`,
                        `game ${point.game}, turn ${point.turn} (${point.phase.replaceAll('_', ' ')})`,
                        `${seconds(point.ms)} to decide${point.tokens ? ` · ${point.tokens} tokens` : ''}`,
                      ])
                    }
                    onMouseLeave={hideTip}
                  />
                ))}
                <line x1={x(stat.median)} x2={x(stat.median)} y1={y - 9} y2={y + 9} stroke={INK} stroke-width={2} />
                <text x={medianX} y={y + 3.5} text-anchor="end" class="chart-value">
                  {seconds(stat.median)}
                </text>
                {tokensSeen && (
                  <text x={width - 6} y={y + 3.5} text-anchor="end" class="chart-value">
                    {model.tokens ? Math.round(model.tokens.median).toLocaleString() : '–'}
                  </text>
                )}
              </g>
            );
          })}
          <text x={medianX} y={STRIP.top - 13} text-anchor="end" class="chart-tick">
            median
          </text>
          {tokensSeen && (
            <text x={width - 6} y={STRIP.top - 13} text-anchor="end" class="chart-tick">
              med tokens
            </text>
          )}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

interface RateColumn {
  label: string;
  title: string;
  value: (model: ModelEvidence) => number | null;
  format: (value: number | null) => string;
}

const PROFILE_COLUMNS: RateColumn[] = [
  {
    label: 'Switch',
    title: 'Switch share of action selections',
    value: (model) => model.rates.switch,
    format: pct,
  },
  {
    label: 'Protect',
    title: 'Protect share of action selections',
    value: (model) => model.rates.protect,
    format: pct,
  },
  {
    label: 'Tools',
    title: 'Mechanics tool lookups per decision',
    value: (model) => model.rates.toolLookups,
    format: perDecision,
  },
];

const RELIABILITY_COLUMNS: RateColumn[] = [
  {
    label: 'Fallback',
    title: 'Decisions replaced by the uniform random fallback',
    value: (model) => model.rates.fallback,
    format: pct,
  },
  {
    label: 'Parse fail',
    title: 'Replies that failed JSON parsing, per decision',
    value: (model) => model.rates.parseFailure,
    format: pct,
  },
  {
    label: 'Retries',
    title: 'Provider retries per decision',
    value: (model) => model.rates.providerRetry,
    format: perDecision,
  },
  {
    label: 'Refl. fallback',
    title: 'Reflections that fell back',
    value: (model) => model.rates.reflectionFallback,
    format: pct,
  },
];

function shade(value: number | null, max: number, rgb: string): string | undefined {
  if (value === null || max <= 0 || value <= 0) return undefined;
  return `rgba(${rgb}, ${(0.82 * value) / max})`;
}

function cellInk(value: number | null, max: number): string | undefined {
  return value !== null && max > 0 && value / max > 0.62 ? '#ffffff' : undefined;
}

function ranked(models: ModelEvidence[], order: string[]): ModelEvidence[] {
  return [...models].sort((a, b) => {
    const rankA = order.indexOf(a.spec);
    const rankB = order.indexOf(b.spec);
    return (
      (rankA === -1 ? order.length : rankA) - (rankB === -1 ? order.length : rankB) || a.spec.localeCompare(b.spec)
    );
  });
}

function RatesTable({
  models,
  order,
  columns,
  rgb,
  onOpenModel,
}: {
  models: ModelEvidence[];
  order: string[];
  columns: RateColumn[];
  rgb: string;
  onOpenModel: (id: string) => void;
}) {
  const rows = ranked(models, order);
  if (rows.length === 0) return <div class="results-empty">Behavior counters appear after the first recorded run.</div>;
  const maxima = columns.map((column) => Math.max(...rows.map((model) => column.value(model) ?? 0)));
  return (
    <div class="table-scroll">
      <table class="data-table fingerprint">
        <thead>
          <tr>
            <th>Model</th>
            <th class="num">Decisions</th>
            {columns.map((column) => (
              <th key={column.label} class="num" title={column.title}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((model) => (
            <tr key={model.spec}>
              <td class="spec-cell" title={model.providers.join(', ')}>
                <button type="button" class="model-link" onClick={() => onOpenModel(model.spec)}>
                  <Mark spec={model.spec} size={14} />
                  <span>{model.spec}</span>
                </button>
              </td>
              <td class="num muted">{model.decisions}</td>
              {columns.map((column, index) => {
                const value = column.value(model);
                return (
                  <td
                    key={column.label}
                    class="num cell"
                    title={column.title}
                    style={{
                      background: shade(value, maxima[index]!, rgb),
                      color: cellInk(value, maxima[index]!),
                    }}
                  >
                    {column.format(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LUCK = { label: 330, plot: 400, tail: 108, row: 27, top: 34, bottom: 40 };

function LuckLedger({ series }: { series: SeriesLuckEntry[] }) {
  const [tip, showTip, hideTip] = useTip();
  const decided = series
    .filter((entry) => entry.winner !== null)
    .map((entry) => {
      const winnerFirst = entry.winner === entry.p1;
      return {
        entry,
        delta: entry.winnerLuckDelta ?? 0,
        loser: winnerFirst ? entry.p2 : entry.p1,
        winnerLuck: winnerFirst ? entry.luck.p1 : entry.luck.p2,
        loserLuck: winnerFirst ? entry.luck.p2 : entry.luck.p1,
      };
    })
    .sort((a, b) => b.delta - a.delta || a.entry.timestamp.localeCompare(b.entry.timestamp));
  if (decided.length === 0) return <div class="results-empty">The ledger fills in as series resolve.</div>;
  const winnerHadMore = decided.filter((row) => row.delta > 0).length;
  const winnerHadFewer = decided.filter((row) => row.delta < 0).length;
  const quiet = decided.filter((row) => row.winnerLuck === 0 && row.loserLuck === 0).length;
  const span = Math.max(2, ...decided.map((row) => Math.abs(row.delta)));
  const center = LUCK.label + LUCK.plot / 2;
  const scale = LUCK.plot / 2 / (span + 1);
  const width = LUCK.label + LUCK.plot + LUCK.tail;
  const height = LUCK.top + decided.length * LUCK.row + LUCK.bottom;
  const ticks = [-span, -Math.ceil(span / 2), 0, Math.ceil(span / 2), span];
  const tailX = LUCK.label + LUCK.plot + LUCK.tail - 6;
  return (
    <div class="chart-host">
      <div class="chart-legend">
        <span>
          <i style={{ background: BLUE }} /> winner had more counted events
        </span>
        <span>
          <i style={{ background: RED }} /> winner had fewer counted events
        </span>
        <span>
          <i style={{ background: GRAY }} /> even
        </span>
      </div>
      <div class="table-scroll">
        <svg width={width} height={height} role="img" aria-label="Recorded adverse-event count differential per series">
          {ticks.map((tick) => (
            <line
              key={tick}
              x1={center + tick * scale}
              x2={center + tick * scale}
              y1={LUCK.top - 8}
              y2={height - LUCK.bottom}
              stroke={tick === 0 ? '#aebbd0' : LINE}
            />
          ))}
          {ticks.map((tick) => (
            <text key={tick} x={center + tick * scale} y={height - 22} text-anchor="middle" class="chart-tick">
              {tick > 0 ? `+${tick}` : tick}
            </text>
          ))}
          <text x={tailX} y={LUCK.top - 13} text-anchor="end" class="chart-tick">
            events W–L
          </text>
          <text x={0} y={height - 6} class="chart-tick">
            {winnerHadMore} winners had more counted events · {winnerHadFewer} had fewer ·{' '}
            {decided.length - winnerHadMore - winnerHadFewer} equal, of which {quiet} had no counted event
          </text>
          {decided.map(({ entry, delta, loser, winnerLuck, loserLuck }, index) => {
            const y = LUCK.top + index * LUCK.row;
            const lines = [
              `${entry.winner} beat ${loser} ${Math.max(...entry.score)}-${Math.min(...entry.score)}`,
              `adverse events (misses, crits taken, flinches, full para)`,
              `winner suffered ${winnerLuck}, loser ${loserLuck}`,
            ];
            return (
              /* biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip supplements the aria-label */
              <g
                key={entry.seriesId}
                aria-label={lines.join('; ')}
                onMouseMove={(event) => showTip(event as unknown as MouseEvent, lines)}
                onMouseLeave={hideTip}
              >
                <rect x={0} y={y} width={width} height={LUCK.row} fill="transparent" />
                <text x={LUCK.label - 12} y={y + LUCK.row / 2 + 3.5} text-anchor="end" class="chart-label">
                  {entry.winner} · {loser}
                </text>
                {delta === 0 ? (
                  <circle cx={center} cy={y + LUCK.row / 2} r={4} fill={GRAY} stroke="#ffffff" stroke-width={1} />
                ) : (
                  <path
                    d={barPath(center, center + delta * scale, y + LUCK.row / 2 - 6, 12)}
                    fill={delta > 0 ? BLUE : RED}
                  />
                )}
                <text x={tailX} y={y + LUCK.row / 2 + 3.5} text-anchor="end" class="chart-value">
                  {winnerLuck}–{loserLuck}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function DataRoomView({
  active,
  epoch,
  onOpenModel,
}: {
  active: boolean;
  epoch: number;
  onOpenModel: (id: string) => void;
}) {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [pool, setPool] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    const query = pool ? `?pool=${encodeURIComponent(pool)}` : '';
    Promise.all([api<RecordsResponse>(`/api/records${query}`), api<EvidenceResponse>(`/api/evidence${query}`)])
      .then(([records, nextEvidence]) => {
        setData(records);
        setEvidence(nextEvidence);
        setError('');
      })
      .catch((failure: Error) => setError(failure.message));
  }, [active, epoch, pool]);

  const models = evidence?.models ?? [];
  const order = useMemo(() => [...models].map((model) => model.spec).sort(), [models]);
  const totals = useMemo(() => {
    const decisions = models.reduce((total, model) => total + model.decisions, 0);
    const turns = (evidence?.series ?? []).map((entry) => entry.turns).sort((first, second) => first - second);
    return { decisions, medianTurns: turns.length ? turns[Math.floor(turns.length / 2)]! : null };
  }, [models, evidence]);
  const poolOptions = [
    { value: '', label: 'All play data', description: 'Every format and mode except the test pool' },
    ...(data?.pools ?? []).map((name) => ({ value: name, label: name })),
  ];
  const provenance = data && data.imported > 0 ? ` ${data.imported} imported.` : '';
  const scopeText = data
    ? data.pool
      ? `${data.count} recorded series in pool ${data.pool}.${provenance}`
      : `${data.count} recorded series across every format and mode except the test pool.${provenance}`
    : 'Loading records...';
  return (
    <>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Data room / {pool || 'overall'}</p>
          <h1>Recorded play</h1>
        </div>
        <p class="lede">
          Descriptive action, tool, reliability, and chance-event records. The overall view merges providers, formats,
          and modes, so it is not a controlled model comparison. Test runs are excluded.
        </p>
      </div>
      <div class="filter-row">
        <div style="min-width:220px">
          <Dropdown id="recordsPool" label="Scope" options={poolOptions} value={pool} onChange={setPool} />
        </div>
        <p class="kicker">{error || scopeText}</p>
      </div>
      <div class="stat-row">
        <StatTile
          label="Recorded series"
          value={String(evidence?.count ?? 0)}
          note="every format and battle speed in scope"
        />
        <StatTile label="Decisions logged" value={String(totals.decisions)} note="engine decisions with evidence" />
        <StatTile
          label="Median series"
          value={totals.medianTurns === null ? '\u2013' : `${totals.medianTurns} turns`}
          note="across a best-of-three"
        />
      </div>
      <section class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2>Play profile</h2>
            <p>
              Observed action mix and tool use under the teams, formats, positions, providers, and scaffolds in scope.
              These are not stable model traits or measures of quality. Rows are ordered by name.
            </p>
          </div>
        </div>
        <RatesTable
          models={models}
          order={order}
          columns={PROFILE_COLUMNS.filter(
            (column) => column.label !== 'Tools' || models.some((model) => model.rates.toolLookups > 0),
          )}
          rgb="20, 88, 230"
          onOpenModel={onOpenModel}
        />
      </section>
      <section class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2>Decision latency</h2>
            <p>
              Raw per-decision provider latency with interquartile bands and medians. It is execution telemetry, not a
              measure of intelligence: routing, load, token use, tools, and scaffold all affect it.
            </p>
          </div>
        </div>
        <div class="chart-body">
          <LatencyStrip models={models} />
        </div>
      </section>
      <section class="panel chart-panel">
        <div class="section-head">
          <div>
            <h2>Recorded chance events</h2>
            <p>
              Misses, critical hits taken, flinches, and full paralysis counted for the winner minus the loser, per
              decided series. The ledger does not include damage rolls or the impact of an event and makes no causal
              claim about the result. The right column shows the raw winner–loser counts.
            </p>
          </div>
        </div>
        <div class="chart-body">
          <LuckLedger series={evidence?.series ?? []} />
        </div>
      </section>
      <details class="audit-details">
        <summary>Scaffold health: fallbacks, parse failures, retries (audit data, not play quality)</summary>
        <section class="panel chart-panel">
          <RatesTable
            models={models}
            order={order}
            columns={RELIABILITY_COLUMNS}
            rgb="232, 75, 79"
            onOpenModel={onOpenModel}
          />
        </section>
      </details>
    </>
  );
}
