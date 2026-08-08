export function ErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul class="research-error-list">
      {errors.map((error, index) => (
        <li key={`${index}:${error}`}>{error}</li>
      ))}
    </ul>
  );
}
