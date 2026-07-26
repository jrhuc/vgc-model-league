export function Sprite({ id, size = 40 }: { id: string; size?: number }) {
  if (!id) return null;
  return (
    <img class="sprite" src={`/sprites/${id}.png`} alt="" width={size} height={size} loading="lazy" decoding="async" />
  );
}
