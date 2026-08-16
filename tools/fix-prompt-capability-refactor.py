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
