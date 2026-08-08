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
            <p class="eyebrow">Technical details</p>
            <h2 id="provenance-title">Identifiers and protocols</h2>
            <p>Technical details are unavailable because this task set could not be loaded.</p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section class="panel research-provenance" aria-labelledby="provenance-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">Technical details</p>
          <h2 id="provenance-title">Identifiers and protocols</h2>
          <p>
            Use these identifiers to confirm which files and simulator build produced the task set. Evaluation results
            are unavailable.
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
            <dt>Task selection rules</dt>
            <dd>v{protocols.eligibilityMetricsVersion}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
