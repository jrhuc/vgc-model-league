import { accentBold, dim, displayWidth, padDisplay } from './term.js';

export function rule(label: string, width: number): string {
  const head = `  ${accentBold(label)} `;
  const remaining = Math.max(0, width - displayWidth(head) - 1);
  return head + dim('─'.repeat(remaining));
}

export interface TableColumn {
  title: string;
  align?: 'left' | 'right';
}

export function tableLines(columns: TableColumn[], rows: string[][], indent = '  '): string[] {
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.title), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const cell = (text: string, index: number): string => {
    const width = widths[index]!;
    if (columns[index]!.align === 'right') return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
    return padDisplay(text, width);
  };
  const header = indent + columns.map((column, index) => dim(cell(column.title, index))).join('  ');
  const divider = indent + dim(widths.map((width) => '─'.repeat(width)).join('──'));
  return [header, divider, ...rows.map((row) => indent + row.map((text, index) => cell(text, index)).join('  '))];
}

export function pinFooter(lines: string[], footer: string[], height: number): string[] {
  const body = lines.slice(0, Math.max(0, height - footer.length));
  return [...body, ...Array.from({ length: Math.max(0, height - footer.length - body.length) }, () => ''), ...footer];
}

export function wrapText(text: string, width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let chunk = word;
    while (chunk.length) {
      if ((current ? current.length + 1 : 0) + chunk.length <= width) {
        current = current ? `${current} ${chunk}` : chunk;
        break;
      }
      if (!current && chunk.length > width) {
        lines.push(chunk.slice(0, width));
        chunk = chunk.slice(width);
        continue;
      }
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, Math.max(0, width - 1))}…`;
  }
  return lines;
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes % 60)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
