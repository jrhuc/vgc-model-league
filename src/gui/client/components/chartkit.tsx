export function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div class="stat-tile">
      <span class="stat-label">{label}</span>
      <span class="stat-value">{value}</span>
      <span class="stat-note">{note}</span>
    </div>
  );
}
