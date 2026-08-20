const REPOSITORY_ROOT = 'https://github.com/jrhuc/vgc-model-league';
const EVALS_ROOT = 'https://github.com/jrhuc/vgc-evals';

const DOCUMENTS = [
  {
    index: '01',
    title: 'Measurement',
    path: 'docs/measurement.md',
    href: `${REPOSITORY_ROOT}/blob/main/docs/measurement.md`,
    description:
      'What battle outcomes, counterfactual diagnostics, and cross-stage evidence may mean—and what models may see.',
  },
  {
    index: '02',
    title: 'Evaluation plan',
    path: 'vgc-evals/docs/evaluation-plan.md',
    href: `${EVALS_ROOT}/blob/main/docs/evaluation-plan.md`,
    description: 'Current artifact status, release gates, and the work still needed before a public evaluation.',
  },
  {
    index: '03',
    title: 'Architecture',
    path: 'docs/architecture.md',
    href: `${REPOSITORY_ROOT}/blob/main/docs/architecture.md`,
    description:
      'Showdown authority, state and evidence boundaries, and the division between TypeScript, verifiers, and the GUI.',
  },
  {
    index: '04',
    title: 'Usage',
    path: 'docs/usage.md',
    href: `${REPOSITORY_ROOT}/blob/main/docs/usage.md`,
    description:
      'Current operator commands and workflows for local runs, archives, position artifacts, and publication.',
  },
] as const;

export function DocsView() {
  return (
    <div class="public-ia public-page">
      <header class="public-page-hero">
        <div>
          <p class="eyebrow">Docs</p>
          <h1>Project docs</h1>
        </div>
        <p class="public-page-intro">
          These are the project’s main references for measurement rules, release status, architecture, and local
          commands.
        </p>
      </header>

      <aside class="docs-access-note" role="note">
        <span aria-hidden="true">i</span>
        <div>
          <strong>Canonical docs</strong>
          <p>The links below open the canonical source files on GitHub.</p>
        </div>
      </aside>

      <section aria-labelledby="document-index-title">
        <h2 id="document-index-title" class="visually-hidden">
          Repository document index
        </h2>
        <ol class="document-index">
          {DOCUMENTS.map((document) => (
            <li key={document.path}>
              <span class="document-index-number">{document.index}</span>
              <div class="document-index-copy">
                <h3>{document.title}</h3>
                <p>{document.description}</p>
                <code>{document.path}</code>
              </div>
              <a
                class="document-link"
                href={document.href}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${document.title} in the repository`}
              >
                <span>Open document</span>
                <b aria-hidden="true">↗</b>
              </a>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
