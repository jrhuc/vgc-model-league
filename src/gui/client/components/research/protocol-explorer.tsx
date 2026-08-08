import type { ResearchArtifactView } from '../../../api';

function ProtocolObject({ label, value }: { label: string; value: Record<string, unknown> }) {
  return (
    <details class="research-protocol-object">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function ProtocolExplorer({ artifact }: { artifact: ResearchArtifactView }) {
  const protocols = artifact.protocols;
  const provenance = artifact.provenance;
  if (!protocols || !provenance) {
    return (
      <section class="panel research-provenance" aria-labelledby="provenance-title">
        <div class="section-head">
          <div>
            <p class="eyebrow">Reproduction boundary</p>
            <h2 id="provenance-title">Protocol and provenance digests</h2>
            <p>Unavailable because the public artifact failed validation.</p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section class="panel research-provenance" aria-labelledby="provenance-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Reproduction boundary</p>
          <h2 id="provenance-title">Protocol and provenance digests</h2>
          <p>
            Selected public digests and protocol declarations are shown without private artifact bindings or evaluation
            payloads. Digest labels remain distinct because they bind different parts of the protocol.
          </p>
        </div>
      </div>
      <dl class="research-provenance-list">
        <div>
          <dt>Manifest SHA-256</dt>
          <dd>
            <code>{provenance.manifestSha256}</code>
          </dd>
        </div>
        <div>
          <dt>Source-set identity</dt>
          <dd>
            <code>{provenance.sourceSetId}</code>
          </dd>
        </div>
        {provenance.calibrationSourceSetId ? (
          <div>
            <dt>Calibration set identity</dt>
            <dd>
              <code>{provenance.calibrationSourceSetId}</code>
            </dd>
          </div>
        ) : null}
        {provenance.upstreamPilotManifestSha256 ? (
          <div>
            <dt>Upstream pilot manifest</dt>
            <dd>
              <code>{provenance.upstreamPilotManifestSha256}</code>
            </dd>
          </div>
        ) : null}
        {provenance.upstreamCalibrationManifestSha256 ? (
          <div>
            <dt>Upstream calibration manifest</dt>
            <dd>
              <code>{provenance.upstreamCalibrationManifestSha256}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Evaluator digest</dt>
          <dd>
            <code>{provenance.evaluatorDigest}</code>
          </dd>
        </div>
        {provenance.splitterDigest ? (
          <div>
            <dt>Splitter digest</dt>
            <dd>
              <code>{provenance.splitterDigest}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Showdown commit</dt>
          <dd>
            <code>{provenance.showdownCommit}</code>
          </dd>
        </div>
        <div>
          <dt>Seed namespace</dt>
          <dd>
            <code>{provenance.seedNamespace}</code>
          </dd>
        </div>
        {provenance.policyId ? (
          <div>
            <dt>Frozen policy</dt>
            <dd>
              <code>{provenance.policyId}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Runtime</dt>
          <dd>
            <code>
              {provenance.runtime.node} · {provenance.runtime.platform} · {provenance.runtime.arch}
            </code>
          </dd>
        </div>
      </dl>
      <div class="research-protocol-list">
        <ProtocolObject label="Action protocol" value={protocols.action} />
        <ProtocolObject label="Task protocol" value={protocols.task} />
        <ProtocolObject label="Counterfactual protocol" value={protocols.counterfactual} />
        <ProtocolObject label="Exhaustive-panel protocol" value={protocols.exhaustivePanels} />
        <ProtocolObject label="Canonical JSON protocol" value={protocols.canonicalJson} />
        {protocols.nearDuplicates ? (
          <ProtocolObject label="Near-duplicate protocol" value={protocols.nearDuplicates} />
        ) : null}
        <dl class="research-protocol-versions">
          <div>
            <dt>Artifact schema</dt>
            <dd>v{protocols.schemaVersion}</dd>
          </div>
          <div>
            <dt>Eligibility metrics</dt>
            <dd>v{protocols.eligibilityMetricsVersion}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
