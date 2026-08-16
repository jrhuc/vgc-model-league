from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frozen-matchday-adapter.ts",
    """export const FROZEN_MATCHDAY_ADAPTER_PROTOCOL = {
  version: 1,
  checkpoint: 'verified-completed-source-between-games-v1',
  replay: 'accepted-actions-and-private-notebook-intervals-v1',
""",
    """export const FROZEN_MATCHDAY_ADAPTER_PROTOCOL = {
  version: 2,
  checkpoint: 'verified-completed-source-between-games-with-authorized-pov-v2',
  replay: 'accepted-actions-private-notebook-intervals-and-authorized-pov-v2',
  sourceObservation: 'bind-then-drain-authorized-prefix-pov-v1',
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  options: FrozenMatchdayRefereeOptions;
  completedGames: MatchdayGameEvidence[];
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>;
""",
    """  options: FrozenMatchdayRefereeOptions;
  completedGames: MatchdayGameEvidence[];
  sourcePovLines: Record<Pid, string[]>;
  privateEvidence: Record<Pid, FrozenMatchdayPrivateEvidence>;
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  if (checkpoint.afterGame !== checkpoint.completedGames.length || checkpoint.afterGame < 1) {
    throw new Error('frozen matchday checkpoint game count is inconsistent');
  }
  if (canonicalJsonDigest(checkpointBase(checkpoint)) !== checkpoint.checkpointDigest) {
""",
    """  if (checkpoint.afterGame !== checkpoint.completedGames.length || checkpoint.afterGame < 1) {
    throw new Error('frozen matchday checkpoint game count is inconsistent');
  }
  if (
    !checkpoint.sourcePovLines ||
    (['p1', 'p2'] as const).some(
      (pid) =>
        !Array.isArray(checkpoint.sourcePovLines[pid]) ||
        checkpoint.sourcePovLines[pid].some((line) => typeof line !== 'string'),
    )
  ) {
    throw new Error('frozen matchday checkpoint has invalid authorized source POV lines');
  }
  if (canonicalJsonDigest(checkpointBase(checkpoint)) !== checkpoint.checkpointDigest) {
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  for (const pid of ['p1', 'p2'] as const) priorPrivateEvidence[pid] = replayed.seatPrivateEvidence(pid);
  const state = replayed.currentState();
  const base = {
""",
    """  for (const pid of ['p1', 'p2'] as const) priorPrivateEvidence[pid] = replayed.seatPrivateEvidence(pid);
  const sourcePovLines = exactPidRecord({
    p1: replayed.observe('p1').povLines,
    p2: replayed.observe('p2').povLines,
  });
  const state = replayed.currentState();
  const base = {
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """    options: structuredClone(source.options),
    completedGames,
    privateEvidence: exactPidRecord(priorPrivateEvidence),
""",
    """    options: structuredClone(source.options),
    completedGames,
    sourcePovLines,
    privateEvidence: exactPidRecord(priorPrivateEvidence),
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  if (checkpoint.afterGame >= 3) {
    throw new Error('v1 matchday draw overrides support regulation between-game checkpoints only');
  }
""",
    """  if (checkpoint.afterGame >= 3) {
    throw new Error('matchday draw overrides support regulation between-game checkpoints only');
  }
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  const privateEvidence = exactPidRecord({
    p1: referee.seatPrivateEvidence('p1'),
    p2: referee.seatPrivateEvidence('p2'),
  });
""",
    """  const sourcePovLines = exactPidRecord({
    p1: referee.observe('p1').povLines,
    p2: referee.observe('p2').povLines,
  });
  if (canonicalJsonDigest(sourcePovLines) !== canonicalJsonDigest(checkpoint.sourcePovLines)) {
    throw new Error('restored matchday authorized source POV does not match the checkpoint prefix');
  }
  const privateEvidence = exactPidRecord({
    p1: referee.seatPrivateEvidence('p1'),
    p2: referee.seatPrivateEvidence('p2'),
  });
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """    controllerSetDigest: input.controllers.controllerSetDigest,
    nonFocalNotebook: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.nonFocalNotebook,
""",
    """    controllerSetDigest: input.controllers.controllerSetDigest,
    sourceObservation: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.sourceObservation,
    nonFocalNotebook: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.nonFocalNotebook,
""",
)

replace(
    "src/eval/frontier-pilot.ts",
    """    publicStateDigest: canonicalJsonDigest(checkpoint.completedGames),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence[focalPid]),
    promptDigest: canonicalJsonDigest(['frontier-pilot-between-game-notebook-v1', checkpoint.afterGame]),
""",
    """    publicStateDigest: canonicalJsonDigest(checkpoint.sourcePovLines[focalPid]),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence[focalPid]),
    promptDigest: canonicalJsonDigest(['frontier-pilot-between-game-notebook-v2', checkpoint.afterGame]),
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint);
  const observation = referee.observe(input.focalPid);
  const privateEvidence = referee.seatPrivateEvidence(input.focalPid);
""",
    """  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint);
  const observation = referee.observe(input.focalPid);
  const privateEvidence = referee.seatPrivateEvidence(input.focalPid);
  const sourcePovLines = input.checkpoint.sourcePovLines[input.focalPid];
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """        gameSummary: summarizeBattleEvents(observation.povLines, input.focalPid),
        rawPovLines: observation.povLines.slice(-600),
""",
    """        gameSummary: summarizeBattleEvents(sourcePovLines, input.focalPid),
        rawPovLines: sourcePovLines.slice(-600),
""",
)

replace(
    "tests/eval-frozen-matchday-adapter.test.ts",
    """    sourceEpisodeDigest: checkpoint.sourceTerminalDigest,
    publicStateDigest: canonicalJsonDigest(checkpoint.completedGames),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence.p1),
    promptDigest: canonicalJsonDigest(['between-game-notebook-v1', checkpoint.afterGame]),
""",
    """    sourceEpisodeDigest: checkpoint.sourceTerminalDigest,
    publicStateDigest: canonicalJsonDigest(checkpoint.sourcePovLines.p1),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence.p1),
    promptDigest: canonicalJsonDigest(['between-game-notebook-v2', checkpoint.afterGame]),
""",
)
replace(
    "tests/eval-frozen-matchday-adapter.test.ts",
    """  assert.deepEqual(restored.seatPrivateEvidence('p1'), checkpoint.privateEvidence.p1);

  const tampered = structuredClone(checkpoint);
""",
    """  assert.deepEqual(restored.seatPrivateEvidence('p1'), checkpoint.privateEvidence.p1);
  assert.ok(checkpoint.sourcePovLines.p1.length > 0);
  assert.ok(checkpoint.sourcePovLines.p2.length > 0);
  assert.deepEqual(restored.observe('p1').povLines, []);
  assert.deepEqual(restored.observe('p2').povLines, []);

  const tampered = structuredClone(checkpoint);
""",
)

replace(
    "tests/eval-frontier-pilot.test.ts",
    """  assert.equal(generated.treatment?.notebook, 'Use the alternate preview and preserve speed control.');
  assert.equal(generated.treatment?.sourceDigest, generated.trace.callDigest);
""",
    """  assert.equal(generated.treatment?.notebook, 'Use the alternate preview and preserve speed control.');
  assert.equal(generated.treatment?.sourceDigest, generated.trace.callDigest);
  const sourceLine = checkpoint.sourcePovLines.p1.find((line) => line.startsWith('|'));
  assert.ok(sourceLine);
  assert.ok(provider.prompts[0]?.includes(sourceLine));
""",
)

replace(
    "docs/strategic-evals.md",
    """It creates a
content-addressed between-game checkpoint, replaces exact notebook bytes,
changes only preregistered future seeds, and continues through strict declared
controllers with no fallback. Source, checkpoint, fork configuration, and
terminal evidence digests remain joined in every outcome.
""",
    """It creates a
content-addressed between-game checkpoint, binds each seat's authorized source
POV, drains that source observation before the continuation, replaces exact
notebook bytes, changes only preregistered future seeds, and continues through
strict declared controllers with no fallback. Source, checkpoint, fork
configuration, and terminal evidence digests remain joined in every outcome.
""",
)

replace(
    "docs/usage.md",
    """The same model then
plays the remaining matched continuations under two arms:
""",
    """The checkpoint binds the focal seat's exact authorized Game 1 POV and
drains it before Game 2, so the continuation receives source-game information
only through the declared treatment bytes. The same model then plays the
remaining matched continuations under two arms:
""",
)
