import type { ResearchArtifactView } from '../../../api';
import { releaseDeclaration, titleCase } from './format';

export function ReleaseGates({ artifact }: { artifact: ResearchArtifactView }) {
  const release = releaseDeclaration(artifact.releaseReady);
  const hasContradiction = artifact.releaseReady === true && artifact.releaseGates.length > 0;
  return (
    <section class="panel research-release-gates" aria-labelledby="release-gates-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Publication control</p>
          <h2 id="release-gates-title">Release-gate checklist</h2>
          <p>
            This is the manifest declaration, not a client-side scientific review. Open items are not inferred to have
            passed when the manifest omits them.
          </p>
        </div>
      </div>
      <ul class="research-gate-list">
        <li class={`research-gate ${artifact.validation.status === 'valid' ? 'valid' : 'blocked'}`}>
          <span class="research-gate-marker" aria-hidden="true">
            {artifact.validation.status === 'valid' ? '✓' : '×'}
          </span>
          <div>
            <b>Public artifact boundary</b>
            <small>
              {artifact.validation.status === 'valid'
                ? 'Canonical public manifest and task bindings validated.'
                : 'Rejected; no artifact metadata or task preview is trusted.'}
            </small>
          </div>
        </li>
        <li
          class={`research-gate ${artifact.releaseReady === true ? 'valid' : artifact.releaseReady === false ? 'open' : 'unknown'}`}
        >
          <span class="research-gate-marker" aria-hidden="true">
            {artifact.releaseReady === true ? '✓' : artifact.releaseReady === false ? '○' : '?'}
          </span>
          <div>
            <b>Manifest release declaration</b>
            <small>{release.sentence}</small>
          </div>
        </li>
        {artifact.releaseGates.map((gate) => (
          <li class="research-gate open" key={gate}>
            <span class="research-gate-marker" aria-hidden="true">
              ○
            </span>
            <div>
              <b>{titleCase(gate)}</b>
              <small>Declared remaining release gate.</small>
            </div>
          </li>
        ))}
      </ul>
      {artifact.releaseReady === false && artifact.releaseGates.length === 0 ? (
        <p class="research-gate-caveat">
          No itemized gate inventory is available. The artifact remains not release-ready; this is not evidence that all
          gates passed.
        </p>
      ) : null}
      {artifact.releaseReady === null ? (
        <p class="research-gate-caveat">
          The release declaration is unknown and no release conclusion can be drawn from this rejected artifact.
        </p>
      ) : null}
      {hasContradiction ? (
        <div class="message error" role="alert">
          The manifest reports release readiness while also listing remaining gates.
        </div>
      ) : null}
    </section>
  );
}
