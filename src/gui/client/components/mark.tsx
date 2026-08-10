const FAMILIES: Array<[RegExp, string]> = [
  [/muse/, 'muse'],
  [/claude|anthropic/, 'claude'],
  [/gpt|openai|\bo[134]\b/, 'gpt'],
  [/gemini|gemma|google/, 'gemini'],
  [/grok|xai/, 'grok'],
  [/kimi|moonshot/, 'kimi'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq|alibaba/, 'qwen'],
  [/glm|z-ai|zhipu/, 'glm'],
  [/llama|meta/, 'llama'],
  [/mistral|magistral|ministral|codestral/, 'mistral'],
];

export function markFor(spec: string): string | null {
  const haystack = spec.toLowerCase();
  for (const [pattern, slug] of FAMILIES) {
    if (pattern.test(haystack)) return slug;
  }
  return null;
}

export function Mark({ spec, size = 14 }: { spec: string; size?: number }) {
  const slug = markFor(spec);
  if (!slug) {
    const letter = (spec.replace(/^[^:]*:/, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
    return (
      <span
        class="mark mark-monogram"
        style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(8, Math.round(size * 0.58))}px` }}
        aria-hidden="true"
      >
        {letter}
      </span>
    );
  }
  return <img class="mark" src={`logos/${slug}.svg`} alt="" width={size} height={size} loading="lazy" />;
}
