export interface Key {
  name:
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'enter'
    | 'escape'
    | 'tab'
    | 'backspace'
    | 'delete'
    | 'home'
    | 'end'
    | 'space'
    | 'ctrl-c'
    | 'char';
  char?: string;
}

const SEQUENCES: Record<string, Key['name']> = {
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[H': 'home',
  '[F': 'end',
  '[1~': 'home',
  '[4~': 'end',
  '[3~': 'delete',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OH: 'home',
  OF: 'end',
};

export function decodeKeys(data: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index]!;
    if (char === '\x1b') {
      const rest = data.slice(index + 1);
      const match = Object.keys(SEQUENCES).find((sequence) => rest.startsWith(sequence));
      if (match) {
        keys.push({ name: SEQUENCES[match]! });
        index += 1 + match.length;
        continue;
      }
      keys.push({ name: 'escape' });
      index += rest.startsWith('[') ? 3 : 1;
      continue;
    }
    index += 1;
    if (char === '\x03') keys.push({ name: 'ctrl-c' });
    else if (char === '\r' || char === '\n') keys.push({ name: 'enter' });
    else if (char === '\t') keys.push({ name: 'tab' });
    else if (char === '\x7f' || char === '\b') keys.push({ name: 'backspace' });
    else if (char === ' ') keys.push({ name: 'space' });
    else if (char >= ' ') keys.push({ name: 'char', char });
  }
  return keys;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const SGR_PREFIX = /^\x1b\[[0-9;]*m/;

export function stripSgr(text: string): string {
  return text.replaceAll(SGR_PATTERN, '');
}

export function displayWidth(text: string): number {
  return stripSgr(text).length;
}

export function truncateDisplay(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < width) {
    if (text[index] === '\x1b') {
      const match = SGR_PREFIX.exec(text.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    out += text[index];
    seen += 1;
    index += 1;
  }
  return out + (text.includes('\x1b') ? '\x1b[0m' : '');
}

export function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const RESET = '\x1b[0m';

function sgr(code: string): (text: string) => string {
  return (text) => `\x1b[${code}m${text}${RESET}`;
}

export const bold = sgr('1');
export const dim = sgr('2');
export const inverse = sgr('7');
export const accent = sgr('38;5;75');
export const accentBold = sgr('1;38;5;75');
export const good = sgr('38;5;78');
export const bad = sgr('38;5;203');
export const warn = sgr('38;5;179');

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
