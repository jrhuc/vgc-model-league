export function Sprite({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  if (!id) return null;
  return (
    <img
      class="sprite"
      src={`./sprites/${id}.png`}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
