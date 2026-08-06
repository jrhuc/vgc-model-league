import fs from 'node:fs';
import path from 'node:path';

export interface PoolOutput {
  id: string;
  format: string;
  event?: Record<string, unknown> | null;
  spreads?: Record<string, unknown>;
  teams: Array<Record<string, unknown>>;
  files: Record<string, string>;
  extra?: Record<string, string>;
}

export function publishPool(poolDir: string, output: PoolOutput): string {
  const manifest = {
    id: output.id,
    format: output.format,
    ...(output.event ? { event: output.event } : {}),
    ...(output.spreads ? { spreads: output.spreads } : {}),
    teams: output.teams,
  };
  const contents: Record<string, string> = {
    ...output.files,
    ...(output.extra ?? {}),
    'pool.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
  const names = Object.keys(contents);
  const blocked = names.map((name) => path.join(poolDir, name)).find((file) => fs.existsSync(file));
  if (blocked) throw new Error(`refusing to overwrite existing output: ${blocked}`);

  fs.mkdirSync(poolDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(poolDir), `.${path.basename(poolDir)}.`));
  try {
    for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(staging, name), body, 'utf8');
    const conflict = names.map((name) => path.join(poolDir, name)).find((file) => fs.existsSync(file));
    if (conflict) throw new Error(`refusing to overwrite existing output: ${conflict}`);
    const published: string[] = [];
    try {
      for (const name of names) {
        const target = path.join(poolDir, name);
        fs.linkSync(path.join(staging, name), target);
        published.push(target);
      }
    } catch (error) {
      for (const target of published.reverse()) fs.rmSync(target, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return path.join(poolDir, 'pool.json');
}
