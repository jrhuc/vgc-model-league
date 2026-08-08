export function titleCase(value: string): string {
  const words = value.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Unavailable';
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function count(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString();
}

export function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}
