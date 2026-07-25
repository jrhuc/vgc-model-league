import { useState } from 'preact/hooks';

export interface Tip {
  x: number;
  y: number;
  lines: string[];
}

export function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div class="chart-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>
      {tip.lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

export function useTip(): [Tip | null, (event: MouseEvent, lines: string[]) => void, () => void] {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (event: MouseEvent, lines: string[]) => {
    const host = (event.currentTarget as Element).closest('.chart-host');
    if (!host) return;
    const box = host.getBoundingClientRect();
    setTip({ x: event.clientX - box.left + 14, y: event.clientY - box.top + 6, lines });
  };
  return [tip, show, () => setTip(null)];
}

export function barPath(x0: number, x1: number, y: number, height: number): string {
  const r = Math.min(4, Math.abs(x1 - x0));
  if (x1 >= x0) {
    return `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + height - r} Q${x1},${y + height} ${x1 - r},${y + height} H${x0} Z`;
  }
  return `M${x0},${y} H${x1 + r} Q${x1},${y} ${x1},${y + r} V${y + height - r} Q${x1},${y + height} ${x1 + r},${y + height} H${x0} Z`;
}

export function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div class="stat-tile">
      <span class="stat-label">{label}</span>
      <span class="stat-value">{value}</span>
      <span class="stat-note">{note}</span>
    </div>
  );
}
