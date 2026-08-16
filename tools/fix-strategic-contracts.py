from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} exact matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frozen-circuit-adapter.ts",
    "if (!receipt.response || sha256(receipt.response) !== receipt.responseSha256) {",
    "if (typeof receipt.response !== 'string' || sha256(receipt.response) !== receipt.responseSha256) {",
)
replace(
    "src/eval/frozen-circuit-adapter.ts",
    "sourceEpisodeDigest: input.transcript.sourceConfigDigest,",
    "sourceEpisodeDigest: input.transcript.transcriptDigest,",
)
replace(
    "src/eval/frozen-circuit-adapter.ts",
    """      if (typeof response !== 'string' || !response) {
        return {
          protocolValid: false,
          accepted: false,
          diagnostic: `${turn.seatId} controller returned no response`,
""",
    """      if (typeof response !== 'string') {
        return {
          protocolValid: false,
          accepted: false,
          diagnostic: `${turn.seatId} controller returned a non-string response`,
""",
)
replace(
    "tests/eval-frozen-circuit-adapter.test.ts",
    """  assert.equal(checkpoint.decisionNode.id, receipts[1]!.turnId);
  assert.equal(checkpoint.decisionNode.parentNodeId, receipts[0]!.turnId);
""",
    """  assert.equal(checkpoint.decisionNode.id, receipts[1]!.turnId);
  assert.equal(checkpoint.decisionNode.parentNodeId, receipts[0]!.turnId);
  assert.equal(checkpoint.decisionNode.sourceEpisodeDigest, transcript.transcriptDigest);
""",
)
adapter_test = Path("tests/eval-frozen-circuit-adapter.test.ts")
adapter_text = adapter_test.read_text()
addition = """

test('strict circuit continuation records empty model output as domain-invalid evidence', async () => {
  const receipts = sourceReceipts(2);
  const transcript = buildFrozenCircuitReceiptTranscript({
    scenarioId: 'draft-league-v1',
    seed: 11,
    receipts,
  });
  const checkpoint = buildFrozenCircuitCheckpoint(transcript, 1);
  const referee = restoreFrozenCircuitCheckpoint(checkpoint);
  const controller = { respond: () => '' };
  const controllers: FrozenCircuitContinuationControllers = {
    controllerSetDigest: canonicalJsonDigest({ policy: 'empty-response' }),
    seats: Object.fromEntries(
      FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => [seatId, controller]),
    ) as unknown as FrozenCircuitContinuationControllers['seats'],
  };
  const result = await continueFrozenCircuitStrict({ referee, controllers, maxSubmissions: 10 });
  assert.equal(result.protocolValid, true);
  assert.equal(result.accepted, false);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.response, '');
  assert.equal(result.receipts[0]!.accepted, false);
  assert.equal(result.receipts[0]!.defaulted, false);

  const replayable = buildFrozenCircuitReceiptTranscript({
    scenarioId: checkpoint.scenarioId,
    seed: checkpoint.seed,
    receipts: [...checkpoint.prefixReceipts, ...result.receipts],
  });
  assert.equal(replayable.receipts.at(-1)?.response, '');
  replayFrozenCircuitTranscript(replayable);
});
"""
if "strict circuit continuation records empty model output" in adapter_text:
    raise RuntimeError("empty-response circuit test already exists")
adapter_test.write_text(adapter_text + addition)

replace(
    "src/eval/strategic-task.ts",
    """function parsedObject(response: string): Record<string, unknown> | string {
  const match = /\\{[\\s\\S]*\\}/u.exec(response);
  if (!match) return 'the reply contained no JSON object';
  try {
    const parsed = JSON.parse(match[0]) as unknown;
""",
    """function parsedObject(response: string): Record<string, unknown> | string {
  const trimmed = response.trim();
  if (!trimmed) return 'the reply contained no JSON object';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
""",
)
replace(
    "tests/eval-strategic-task.test.ts",
    """  const invalid = parseStrategicChoice(
    JSON.stringify({ action_id: actionId, p_game_win: 0.55, p_series_win: 0.62, confidence: 0.7, rationale: 'extra' }),
    task,
  );
  assert.equal(invalid.status, 'invalid');
""",
    """  const invalid = parseStrategicChoice(
    JSON.stringify({ action_id: actionId, p_game_win: 0.55, p_series_win: 0.62, confidence: 0.7, rationale: 'extra' }),
    task,
  );
  assert.equal(invalid.status, 'invalid');
  const wrapped = parseStrategicChoice(
    `Decision: ${JSON.stringify({ action_id: actionId, p_game_win: 0.55, p_series_win: 0.62, confidence: 0.7 })}`,
    task,
  );
  assert.equal(wrapped.status, 'invalid');
""",
)
