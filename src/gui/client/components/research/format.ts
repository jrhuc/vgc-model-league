export function titleCase(value: string): string {
  const words = value.replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Not declared';
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function count(value: number | null): string {
  return value === null ? 'Not declared' : value.toLocaleString();
}

export function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

export function releaseDeclaration(value: boolean | null): {
  className: string;
  label: string;
  sentence: string;
} {
  if (value === true)
    return { className: 'ready', label: 'Declared release-ready', sentence: 'Declared release-ready.' };
  if (value === false)
    return { className: 'not-ready', label: 'Declared not release-ready', sentence: 'Explicitly not release-ready.' };
  return {
    className: 'unknown',
    label: 'Release declaration unknown',
    sentence: 'Release readiness is unknown because the artifact declaration is unavailable or untrusted.',
  };
}
