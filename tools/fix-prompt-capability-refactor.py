from pathlib import Path


def update(path: str, transform) -> None:
    file = Path(path)
    before = file.read_text()
    after = transform(before)
    if after == before:
        raise RuntimeError(f"{path}: fix transform made no change")
    file.write_text(after)


def default_mechanics_tools(text: str) -> str:
    old = "mechanicsTools: MechanicsToolAvailability,\n): string {"
    new = "mechanicsTools: MechanicsToolAvailability = 'available',\n): string {"
    if old not in text:
        raise RuntimeError("generated prompt renderer has no non-default capability parameter")
    return text.replace(old, new)


for generated in ("src/draft.ts", "src/teambuild.ts", "src/trade-window.ts"):
    update(generated, default_mechanics_tools)


def restore_roster_line(text: str) -> str:
    if "function rosterLine(" in text:
        raise RuntimeError("trade refactor unexpectedly retained rosterLine")
    marker = "\n\nfunction userPrompt(state: TradeWindowState, entrant: number, psDir: string): string {"
    if marker not in text:
        raise RuntimeError("trade refactor has no userPrompt insertion point")
    helper = """

function rosterLine(roster: readonly DraftBoardMon[]): string {
  return roster.map((mon) => `${mon.id} (${mon.cost})`).join(', ');
}
"""
    return text.replace(marker, helper + marker, 1)


update("src/trade-window.ts", restore_roster_line)


def remove_unused_fork_base(text: str) -> str:
    block = """
function forkBase(artifact: FrozenCircuitForkArtifact) {
  const { forkDigest: _forkDigest, ...base } = artifact;
  return base;
}

"""
    if text.count(block) != 1:
        raise RuntimeError("frozen circuit adapter forkBase shape changed")
    return text.replace(block, "", 1)


update("src/eval/frozen-circuit-adapter.ts", remove_unused_fork_base)


def bind_transaction_state_digest(text: str) -> str:
    marker = """  summary(): TransactionSummary {
"""
    if text.count(marker) != 1:
        raise RuntimeError("frozen transaction coordinator summary insertion point changed")
    method = """  stateDigest(): string {
    return canonicalJsonDigest({
      state: this.state,
      order: this.order,
      phase: this.phase,
      cursor: this.cursor,
      offer: this.offer,
      offers: this.offers,
      decisions: this.decisions,
    });
  }

"""
    return text.replace(marker, method + marker, 1)


update("src/frozen-circuit-transactions.ts", bind_transaction_state_digest)


def bind_circuit_behavioral_state(text: str) -> str:
    old = """      draftPicks: this.draftState?.taken.size ?? null,
      constructions: [...this.constructions.keys()].sort(),
      bracket: this.bracket,
      table: this.table,
      transaction: this.transactions
        ? {
            phase: this.transactions.phase,
            cursor: this.transactions.cursor,
            rosterDigests: this.transactions.state.rosters.map((roster) => canonicalJsonDigest(roster)),
          }
        : null,
"""
    new = """      draft: this.draftState
        ? {
            taken: [...this.draftState.taken.entries()].sort(([left], [right]) => left.localeCompare(right)),
            rosters: this.draftState.rosters.map((roster) => roster.map((mon) => mon.id)),
            budgets: [...this.draftState.budgets],
          }
        : null,
      notebooks: FROZEN_CIRCUIT_SEAT_IDS.map((seatId) => ({
        seatId,
        notebookSha256: sha256(this.notebooks.get(seatId)!),
      })),
      constructions: [...this.constructions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, construction]) => ({ key, constructionDigest: canonicalJsonDigest(construction) })),
      bracket: this.bracket,
      table: this.table,
      leagueResults: this.leagueResults,
      coachingContext: [...this.coachingContext.entries()]
        .sort(([left], [right]) => left - right)
        .map(([entrant, entries]) => ({
          entrant,
          entries: [...entries.entries()].sort(([left], [right]) => left - right),
        })),
      leagueReflections: [...this.leagueReflections.entries()]
        .sort(([left], [right]) => left - right)
        .map(([entrant, entries]) => ({
          entrant,
          entries: [...entries.entries()].sort(([left], [right]) => left - right),
        })),
      transactionStateDigest: this.transactions?.stateDigest() ?? null,
"""
    if text.count(old) != 1:
        raise RuntimeError("frozen circuit behavioral state hash shape changed")
    text = text.replace(old, new, 1)
    pending = """        kind: turn.kind,
        attempt: turn.attempt,
"""
    bound_pending = """        kind: turn.kind,
        attempt: turn.attempt,
        promptSha256: sha256(turn.prompt),
"""
    if text.count(pending) != 1:
        raise RuntimeError("frozen circuit pending state hash shape changed")
    return text.replace(pending, bound_pending, 1)


update("src/frozen-circuit-referee.ts", bind_circuit_behavioral_state)


def fix_controller_cast(text: str) -> str:
    old = ") as FrozenCircuitContinuationControllers['seats'],"
    new = ") as unknown as FrozenCircuitContinuationControllers['seats'],"
    if text.count(old) != 1:
        raise RuntimeError("frozen circuit adapter test cast shape changed")
    return text.replace(old, new, 1)


update("tests/eval-frozen-circuit-adapter.test.ts", fix_controller_cast)


def guard_fixture_seat(text: str) -> str:
    old = """  const construction = frozenMatchdayOptions().seats[0].construction;
  assert.equal(construction.status, 'accepted');
"""
    new = """  const seat = frozenMatchdayOptions().seats[0];
  assert.ok(seat);
  const construction = seat.construction;
  assert.equal(construction.status, 'accepted');
"""
    if text.count(old) != 1:
        raise RuntimeError("prompt capability fixture access shape changed")
    return text.replace(old, new, 1)


update("tests/frozen-circuit-prompt-capabilities.test.ts", guard_fixture_seat)
