import { useEffect, useMemo, useState } from 'preact/hooks';

import type {
  EvidenceResponse,
  ModelEvidence,
  RecordsResponse,
  SeriesLuckEntry,
  StandingView,
  TrajectoryPointView,
} from '../../api';
import { barPath, StatTile, Tooltip, useTip } from '../components/chartkit';
import { Dropdown } from '../components/dropdown';
import { Mark } from '../components/mark';
import { api } from '../http';

const BLUE = 'var(--chart-blue)';
const RED = 'var(--chart-red)';
const INK = 'var(--chart-ink)';
const LINE = 'var(--chart-line)';
const GRAY = 'var(--chart-gray)';
const EMPHASIS = [BLUE, RED, 'var(--chart-green)'];

function code(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `Z${index - 25}`;
}

function seconds(ms: number): string {
  return ms >= 100_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function pct(value: number | null): string {
  return value === null ? '–' : `${(100 * value).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

function perDecision(value: number | null): string {
  return value === null ? '–' : value.toFixed(2);
}

const TRAJ = { left: 52, plot: 610, gutter: 190, height: 250, top: 20, bottom: 30 };

function niceStep(span: number): number {
  const raw = span / 4;
  for (const step of [5, 10, 20, 25, 50, 100, 200]) if (step >= raw) return step;
  return 400;
}

function TrajectoryChart({ trajectory, count }: { trajectory: TrajectoryPointView[]; count: number }) {
  const [tip, showTip, hideTip] = useTip();
  const [focus, setFocus] = useState('');
  const bySpec = new Map<string, TrajectoryPointView[]>();
  for (const point of trajectory) {
    const list = bySpec.get(point.spec) ?? [];
    list.push(point);
    bySpec.set(point.spec, list);
  }
  if (bySpec.size === 0 || count === 0)
    return <div class="results-empty">The trajectory draws as rated series accumulate.</div>;
  const elos = [1000, ...trajectory.map((point) => point.elo)];
  const lowElo = Math.min(...elos) - 8;
  const highElo = Math.max(...elos) + 8;
  const x = (series: number) => TRAJ.left + (series / count) * TRAJ.plot;
  const y = (elo: number) =>
    TRAJ.top + (1 - (elo - lowElo) / (highElo - lowElo)) * (TRAJ.height - TRAJ.top - TRAJ.bottom);
  const finals = [...bySpec.entries()]
    .map(([spec, points]) => ({ spec, elo: points[points.length - 1]!.elo }))
    .sort((a, b) => b.elo - a.elo);
  const emphasized = new Map(finals.slice(0, 3).map((entry, index) => [entry.spec, EMPHASIS[index]!]));
  const ordered = [...bySpec.entries()].sort((a, b) => Number(emphasized.has(a[0])) - Number(emphasized.has(b[0])));
  const step = niceStep(highElo - lowElo);
  const yTicks: number[] = [];
  for (let tick = Math.ceil(lowElo / step) * step; tick <= highElo; tick += step) yTicks.push(tick);
  const xStep = Math.max(1, Math.ceil(count / 8));
  const xTicks: number[] = [];
  for (let tick = 0; tick <= count; tick += xStep) xTicks.push(tick);
  const labels: Array<{ spec: string; color: string; y: number }> = [];
  for (const entry of finals.slice(0, 3)) {
    let position = y(entry.elo) + 3.5;
    while (labels.some((label) => Math.abs(label.y - position) < 13)) position += 13;
    labels.push({ spec: entry.spec, color: emphasized.get(entry.spec)!, y: position });
  }
  const width = TRAJ.left + TRAJ.plot + TRAJ.gutter;
  const path = (points: TrajectoryPointView[]) => {
    let d = `M${x(0)},${y(1000)}`;
    for (const point of points) d += ` H${x(point.series)} V${y(point.elo)}`;
    return d;
  };
  return (
    <div class="chart-host">
      <div class="chart-legend">
        {finals.slice(0, 3).map((entry) => (
          <span key={entry.spec}>
            <i style={{ background: emphasized.get(entry.spec) }} /> {entry.spec}
          </span>
        ))}
        <span>
          <i style={{ background: GRAY }} /> the field
        </span>
      </div>
      <div class="table-scroll">
        <svg width={width} height={TRAJ.height} role="img" aria-label="Elo trajectory over rated series">
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={TRAJ.left} x2={TRAJ.left + TRAJ.plot} y1={y(tick)} y2={y(tick)} stroke={LINE} />
              <text x={TRAJ.left - 8} y={y(tick) + 3} text-anchor="end" class="chart-tick">
                {tick}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick} x={x(tick)} y={TRAJ.height - 8} text-anchor="middle" class="chart-tick">
              {tick}
            </text>
          ))}
          <text x={TRAJ.left + TRAJ.plot + 8} y={TRAJ.height - 8} text-anchor="start" class="chart-tick">
            rated series →
          </text>
          {ordered.map(([spec, points]) => {
            const color = emphasized.get(spec) ?? GRAY;
            const active = focus === spec;
            return (
              /* biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip supplements the legend and end labels */
              <g
                key={spec}
                onMouseMove={(event) => {
                  setFocus(spec);
                  showTip(event as unknown as MouseEvent, [
                    spec,
                    `Elo ${Math.round(points[points.length - 1]!.elo)} after ${points.length} rated series`,
                  ]);
                }}
                onMouseLeave={() => {
                  setFocus('');
                  hideTip();
                }}
              >
                <path d={path(points)} fill="none" stroke="transparent" stroke-width={11} />
                <path
                  d={path(points)}
                  fill="none"
                  stroke={active ? INK : color}
                  stroke-width={2}
                  stroke-linejoin="round"
                />
              </g>
            );
          })}
          {labels.map((label) => (
            <text key={label.spec} x={TRAJ.left + TRAJ.plot + 10} y={label.y} class="chart-label">
              {label.spec}
            </text>
          ))}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

const SCATTER = { left: 56, plot: 540, gutter: 180, height: 300, top: 18, bottom: 34 };

function SkillScatter({ models, standings }: { models: ModelEvidence[]; standings: StandingView[] }) {
  const [tip, showTip, hideTip] = useTip();
  const joined = models
    .filter((model) => model.latency)
    .map((model) => ({ model, standing: standings.find((entry) => entry.spec === model.spec) }))
    .filter((entry): entry is { model: ModelEvidence; standing: StandingView } => entry.standing !== undefined);
  if (joined.length === 0) return <div class="results-empty">The scatter fills in as rated series accumulate.</div>;
  const medians = joined.map((entry) => entry.model.latency!.median);
  const low = Math.min(...medians) * 0.7;
  const high = Math.max(...medians) * 1.45;
  const x = (ms: number) =>
    SCATTER.left + ((Math.log(ms) - Math.log(low)) / (Math.log(high) - Math.log(low))) * SCATTER.plot;
  const y = (winrate: number) => SCATTER.top + (1 - winrate) * (SCATTER.height - SCATTER.top - SCATTER.bottom);
  const ticks = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000].filter(
    (tick) => tick >= low && tick <= high,
  );
  const width = SCATTER.left + SCATTER.plot + SCATTER.gutter;
  const dots = joined.map((entry) => ({
    spec: entry.model.spec,
    x: x(entry.model.latency!.median),
    band: Math.round(y(entry.standing.winrate) / 14),
  }));
  const placed: Array<{ x0: number; x1: number; band: number }> = [];
  const labeled = new Set<string>();
  for (const dot of [...dots].sort((a, b) => a.x - b.x)) {
    const box = { x0: dot.x + 9, x1: dot.x + 9 + dot.spec.length * 5.7, band: dot.band };
    const hitsLabel = placed.some(
      (other) => Math.abs(other.band - box.band) <= 1 && box.x0 < other.x1 + 10 && other.x0 < box.x1 + 10,
    );
    const hitsDot = dots.some(
      (other) =>
        other.spec !== dot.spec && Math.abs(other.band - box.band) <= 1 && other.x + 7 > box.x0 && other.x - 7 < box.x1,
    );
    if (hitsLabel || hitsDot) continue;
    placed.push(box);
    labeled.add(dot.spec);
  }
  return (
    <div class="chart-host">
      <div class="table-scroll">
        <svg width={width} height={SCATTER.height} role="img" aria-label="Median deliberation against series win rate">
          {[0, 0.25, 0.5, 0.75, 1].map((line) => (
            <g key={line}>
              <line x1={SCATTER.left} x2={SCATTER.left + SCATTER.plot} y1={y(line)} y2={y(line)} stroke={LINE} />
              <text x={SCATTER.left - 8} y={y(line) + 3} text-anchor="end" class="chart-tick">
                {Math.round(line * 100)}%
              </text>
            </g>
          ))}
          {ticks.map((tick) => (
            <text key={tick} x={x(tick)} y={SCATTER.height - 12} text-anchor="middle" class="chart-tick">
              {tick >= 60_000 ? `${tick / 60_000}m` : `${tick / 1000}s`}
            </text>
          ))}
          <text x={SCATTER.left + SCATTER.plot + 8} y={SCATTER.height - 12} text-anchor="start" class="chart-tick">
            median deliberation →
          </text>
          {joined.map(({ model, standing }) => (
            /* biome-ignore lint/a11y/noStaticElementInteractions: hover tooltip carries the identity of unlabeled dots */
            <g
              key={model.spec}
              onMouseMove={(event) =>
                showTip(event as unknown as MouseEvent, [
                  model.spec,
                  `${standing.w}-${standing.l}-${standing.t} over ${standing.series} rated series`,
                  `median decision ${seconds(model.latency!.median)}`,
                ])
              }
              onMouseLeave={hideTip}
            >
              <circle
                cx={x(model.latency!.median)}
                cy={y(standing.winrate)}
                r={5.5}
                fill={BLUE}
                stroke="#ffffff"
                stroke-width={2}
              />
              {labeled.has(model.spec) && (
                <text x={x(model.latency!.median) + 9} y={y(standing.winrate) + 3.5} class="chart-tick">
                  {model.spec}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

const STRIP = { label: 220, plot: 520, median: 74, tokens: 90, row: 27, top: 26, bottom: 8 };

function LatencyStrip({ models }: { models: ModelEvidence[] }) {
  const [tip, showTip, hideTip] = useTip();
  const ranked = models
    .filter((model) => model.latency && model.points.length > 0)
    .sort((a, b) => b.latency!.median - a.latency!.median);
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
  {
    label: 'Threat conv.',
    title: 'Threatened KOs converted',
    value: (model) => model.rates.threatConversion,
    format: pct,
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
  const earned = decided.filter((row) => row.delta > 0).length;
  const favored = decided.filter((row) => row.delta < 0).length;
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
          <i style={{ background: BLUE }} /> won despite worse luck
        </span>
        <span>
          <i style={{ background: RED }} /> luck-favored win
        </span>
        <span>
          <i style={{ background: GRAY }} /> even
        </span>
      </div>
      <div class="table-scroll">
        <svg width={width} height={height} role="img" aria-label="Adverse luck differential per series">
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
            {earned} earned against the luck · {favored} luck-favored · {decided.length - earned - favored} even, of
            which {quiet} saw no adverse event at all
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

const SECTIONS = [
  { id: 'play', label: 'Play', blurb: 'How each model plays and how long it thinks, decision by decision.' },
  { id: 'ladder', label: 'Ladder', blurb: 'Rated rotation series: Elo, head to head, and how the ratings moved.' },
] as const;

export type DataRoomSection = (typeof SECTIONS)[number]['id'];

export function isDataRoomSection(value: string): value is DataRoomSection {
  return SECTIONS.some((section) => section.id === value);
}

export function DataRoomView({
  active,
  epoch,
  section,
  onSection,
  onOpenModel,
}: {
  active: boolean;
  epoch: number;
  section: DataRoomSection;
  onSection: (next: DataRoomSection) => void;
  onOpenModel: (id: string) => void;
}) {
  const [data, setData] = useState<RecordsResponse | null>(null);
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [pool, setPool] = useState('');
  const [speed, setSpeed] = useState('');
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

  const groups = data?.groups ?? [];
  const group = groups.find((entry) => String(entry.scale) === speed) ?? groups[0];
  const rows = group?.standings ?? [];
  const eloOrder = useMemo(() => rows.map((standing) => standing.spec), [rows]);
  const models = evidence?.models ?? [];
  const totals = useMemo(() => {
    const decisions = models.reduce((total, model) => total + model.decisions, 0);
    const points = models
      .flatMap((model) => model.points.map((point) => point.ms))
      .sort((first, second) => first - second);
    const turns = (evidence?.series ?? []).map((entry) => entry.turns).sort((first, second) => first - second);
    return {
      decisions,
      medianMs: points.length ? points[Math.floor(points.length / 2)]! : null,
      medianTurns: turns.length ? turns[Math.floor(turns.length / 2)]! : null,
    };
  }, [models, evidence]);
  const poolOptions = [
    { value: '', label: 'All play data', description: 'Every format and mode except the test pool' },
    ...(data?.pools ?? []).map((name) => ({ value: name, label: name })),
  ];
  const speedOptions = groups.map((entry) => ({
    value: String(entry.scale),
    label: entry.label,
    description: `${entry.count} rated series`,
  }));
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
          <p class="eyebrow">
            Data room / {SECTIONS.find((entry) => entry.id === section)?.label.toLowerCase()} / {pool || 'overall'}
          </p>
          <h1>Records.</h1>
        </div>
        <p class="lede">
          {SECTIONS.find((entry) => entry.id === section)?.blurb}{' '}
          {section === 'ladder'
            ? 'Rotation ratings stay split by battle speed; test runs stay excluded.'
            : 'Model behavior is merged across providers, formats, and modes; test runs stay excluded.'}
        </p>
      </div>
      <nav class="section-nav" aria-label="Data room sections">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            class={`section-tab ${section === entry.id ? 'on' : ''}`}
            onClick={() => onSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div class="filter-row">
        <div style="min-width:220px">
          <Dropdown id="recordsPool" label="Scope" options={poolOptions} value={pool} onChange={setPool} />
        </div>
        {section === 'ladder' && speedOptions.length > 1 && (
          <div style="min-width:220px">
            <Dropdown
              id="recordsSpeed"
              label="Battle speed"
              options={speedOptions}
              value={String(group?.scale ?? '')}
              onChange={setSpeed}
            />
          </div>
        )}
        <p class="kicker">{error || scopeText}</p>
      </div>
      {section === 'ladder' ? (
        <div class="stat-row">
          <StatTile
            label="Rated series"
            value={String(group?.count ?? 0)}
            note={group ? `${group.label.toLowerCase()} · ${pool || 'overall'}` : pool || 'overall scope'}
          />
          <StatTile label="Models rated" value={String(rows.length)} note="merged across providers" />
          <StatTile
            label="Elo spread"
            value={rows.length < 2 ? '–' : `${Math.round(rows[0]!.elo - rows[rows.length - 1]!.elo)} pts`}
            note="top to bottom of the table"
          />
          <StatTile
            label="Median series"
            value={totals.medianTurns === null ? '–' : `${totals.medianTurns} turns`}
            note="across a best-of-three"
          />
        </div>
      ) : (
        <div class="stat-row">
          <StatTile
            label="Recorded series"
            value={String(evidence?.count ?? 0)}
            note="every format and battle speed in scope"
          />
          <StatTile label="Decisions logged" value={String(totals.decisions)} note="engine decisions with evidence" />
          <StatTile
            label="Median decision"
            value={totals.medianMs === null ? '–' : seconds(totals.medianMs)}
            note="wall-clock latency per decision"
          />
          <StatTile
            label="Median series"
            value={totals.medianTurns === null ? '–' : `${totals.medianTurns} turns`}
            note="across a best-of-three"
          />
        </div>
      )}
      {section === 'ladder' && (
        <>
          <div class="results-grid">
            <section class="panel">
              <div class="section-head">
                <div>
                  <h2>Standings</h2>
                  <p>Rotation series rated by sequential Elo.</p>
                </div>
              </div>
              <div class="table-scroll">
                {rows.length === 0 ? (
                  <div class="results-empty">No completed series. Standings appear after the first recorded run.</div>
                ) : (
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th />
                        <th>Model</th>
                        <th class="num">Elo</th>
                        <th class="num">Series</th>
                        <th class="num">W-L-T</th>
                        <th class="num">Win %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((standing, index) => (
                        <tr key={standing.spec}>
                          <td>{code(index)}</td>
                          <td class="spec-cell" title={standing.spec}>
                            <button type="button" class="model-link" onClick={() => onOpenModel(standing.spec)}>
                              <Mark spec={standing.spec} size={14} />
                              <span>{standing.spec}</span>
                            </button>
                          </td>
                          <td class="num">{Math.round(standing.elo)}</td>
                          <td class="num">{standing.series}</td>
                          <td class="num">
                            {standing.w}-{standing.l}-{standing.t}
                          </td>
                          <td class="num">{Math.round(standing.winrate * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
            <section class="panel">
              <div class="section-head">
                <div>
                  <h2>Head to head</h2>
                  <p>Series W-L-T, row vs column.</p>
                </div>
              </div>
              <div class="table-scroll">
                {rows.length === 0 ? (
                  <div class="results-empty">The matrix fills in as pairings resolve.</div>
                ) : (
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th />
                        {rows.map((standing, index) => (
                          <th key={standing.spec} class="num" title={standing.spec}>
                            {code(index)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((rowStanding, rowIndex) => (
                        <tr key={rowStanding.spec}>
                          <td title={rowStanding.spec}>{code(rowIndex)}</td>
                          {rows.map((colStanding) => {
                            const cell = group?.h2h[rowStanding.spec]?.[colStanding.spec] ?? [0, 0, 0];
                            const played = cell[0] || cell[1] || cell[2];
                            return (
                              <td key={colStanding.spec} class="num">
                                {played ? `${cell[0]}-${cell[1]}-${cell[2]}` : <span class="muted">·</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
          <section class="panel chart-panel">
            <div class="section-head">
              <div>
                <h2>Rating trajectory</h2>
                <p>
                  Sequential Elo over rated series, everyone starting at 1000. The top three carry color; hover any line
                  for the rest of the field.
                </p>
              </div>
            </div>
            <div class="chart-body">
              <TrajectoryChart trajectory={group?.trajectory ?? []} count={group?.count ?? 0} />
            </div>
          </section>
        </>
      )}
      {section === 'play' && (
        <>
          <section class="panel chart-panel">
            <div class="section-head">
              <div>
                <h2>Thinking time and win rate</h2>
                <p>
                  Median deliberation per decision against series win rate, one dot per model. Small samples are noisy;
                  read alongside the series counts in the tooltip.
                </p>
              </div>
            </div>
            <div class="chart-body">
              <SkillScatter models={models} standings={rows} />
            </div>
          </section>
          <section class="panel chart-panel">
            <div class="section-head">
              <div>
                <h2>Deliberation</h2>
                <p>
                  Wall-clock seconds per decision, log scale. One dot per decision; the band is the interquartile range,
                  the tick the median. Slowest thinkers first.
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
                <h2>Play profile</h2>
                <p>
                  How each model plays, not how well: action mix and threat conversion, shaded against the column
                  maximum. Ordered by Elo.
                </p>
              </div>
            </div>
            <RatesTable
              models={models}
              order={eloOrder}
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
                <h2>Luck ledger</h2>
                <p>
                  Misses, crits taken, flinches, and full paralysis suffered by the winner minus the loser, per decided
                  series, sorted by that difference. Bars right of zero are series won despite worse luck. The right
                  column shows each side's raw counts, which separates an even series from one with few luck events.
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
                order={eloOrder}
                columns={RELIABILITY_COLUMNS}
                rgb="232, 75, 79"
                onOpenModel={onOpenModel}
              />
            </section>
          </details>
        </>
      )}
    </>
  );
}
