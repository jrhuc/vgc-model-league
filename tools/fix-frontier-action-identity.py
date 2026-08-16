from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frontier-pilot.ts",
    """  taskIdentity: 'opportunity-and-authorized-state-digest-v1',
  report: 'content-addressed-private-run-report-v1',
""",
    """  taskIdentity: 'opportunity-and-authorized-state-digest-v1',
  outcomeActionIdentity: 'canonical-command-digest-v1',
  report: 'content-addressed-private-run-report-v1',
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """    this.callTraces.push(traced(base));
    this.modelDecisions += 1;
    return { command: selected.canonicalAction, actionId: parsed.actionId };
""",
    """    this.callTraces.push(traced(base));
    this.modelDecisions += 1;
    return {
      command: selected.canonicalAction,
      actionId: canonicalJsonDigest([
        FRONTIER_STRATEGIC_PILOT_PROTOCOL.outcomeActionIdentity,
        selected.canonicalAction,
      ]),
    };
""",
)
replace(
    "tests/eval-frontier-pilot.test.ts",
    """  completeFrontierPilotSource,
  FrontierPilotActionController,
""",
    """  completeFrontierPilotSource,
  FRONTIER_STRATEGIC_PILOT_PROTOCOL,
  FrontierPilotActionController,
""",
)
replace(
    "tests/eval-frontier-pilot.test.ts",
    """  assert.equal(traces[0]!.canonicalAction, decision.command);
  assert.match(traces[0]!.callDigest, /^[0-9a-f]{64}$/u);
""",
    """  assert.equal(traces[0]!.canonicalAction, decision.command);
  assert.notEqual(traces[0]!.selectedActionId, decision.actionId);
  assert.equal(
    decision.actionId,
    canonicalJsonDigest([FRONTIER_STRATEGIC_PILOT_PROTOCOL.outcomeActionIdentity, decision.command]),
  );
  assert.match(traces[0]!.callDigest, /^[0-9a-f]{64}$/u);
""",
)
