import { useEffect, useState } from 'preact/hooks';

export function Sprite({ id, size = 40 }: { id: string; size?: number }) {
  if (!id) return null;
  return (
    <img class="sprite" src={`sprites/${id}.png`} alt="" width={size} height={size} loading="lazy" decoding="async" />
  );
}

interface ItemIconSheet {
  sheet: string;
  icons: Record<string, number>;
}

const SHEET_COLUMNS = 16;
const SHEET_CELL = 24;

let itemIconSheet: ItemIconSheet | null = null;
let itemIconRequest: Promise<ItemIconSheet | null> | null = null;

function loadItemIcons(): Promise<ItemIconSheet | null> {
  itemIconRequest ??= fetch('/itemicons.json')
    .then((response) => (response.ok ? (response.json() as Promise<ItemIconSheet>) : null))
    .then((data) => {
      itemIconSheet = data;
      return data;
    })
    .catch(() => null);
  return itemIconRequest;
}

export function itemIconId(item: string): string {
  return item.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function ItemIcon({ item, size = 18 }: { item: string; size?: number }) {
  const [sheet, setSheet] = useState(itemIconSheet);
  useEffect(() => {
    if (!sheet) loadItemIcons().then((data) => data && setSheet(data));
  }, [sheet]);
  if (!item) return null;
  const num = sheet?.icons[itemIconId(item)];
  if (sheet === null || num === undefined) return null;
  const scale = size / SHEET_CELL;
  return (
    <span
      class="item-icon"
      role="img"
      aria-label={item}
      title={item}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundImage: `url(${sheet.sheet})`,
        backgroundSize: `${SHEET_COLUMNS * SHEET_CELL * scale}px auto`,
        backgroundPosition: `-${(num % SHEET_COLUMNS) * size}px -${Math.floor(num / SHEET_COLUMNS) * size}px`,
      }}
    />
  );
}
