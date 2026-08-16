from pathlib import Path

source = Path("tools/fix-matchday-memory-boundary.py").read_text()
marker = '\nreplace(\n    "docs/strategic-evals.md",'
if source.count(marker) != 1:
    raise RuntimeError(f"boundary script documentation marker changed: {source.count(marker)}")
exec(compile(source.split(marker, 1)[0], "tools/fix-matchday-memory-boundary.py", "exec"))

strategic = Path("docs/strategic-evals.md")
strategic_text = strategic.read_text()
old_strategic = """`frozen-matchday-adapter.ts` verifies a completed source matchday by replaying
its accepted battle actions and private notebook intervals. It creates a
content-addressed between-game checkpoint, replaces exact notebook bytes,
changes only preregistered future seeds, and continues through strict declared
controllers with no fallback. Source, checkpoint, fork configuration, and
terminal evidence digests remain joined in every outcome. The execution digest
also binds the matched plan, arm, common draw, focal seat, treatment, and
controller set. The non-focal seat retains its checkpoint notebook in v1;
changing it requires an explicitly crossed treatment rather than an unbound
runtime argument.
"""
new_strategic = """`frozen-matchday-adapter.ts` verifies a completed source matchday by replaying
its accepted battle actions and private notebook intervals. It creates a
content-addressed between-game checkpoint, binds each seat's authorized source
POV, drains that source observation before the continuation, replaces exact
notebook bytes, changes only preregistered future seeds, and continues through
strict declared controllers with no fallback. Source, checkpoint, fork
configuration, and terminal evidence digests remain joined in every outcome.
The execution digest also binds the matched plan, arm, common draw, focal seat,
treatment, and controller set. The non-focal seat retains its checkpoint
notebook in the current adapter; changing it requires an explicitly crossed
treatment rather than an unbound runtime argument.
"""
if strategic_text.count(old_strategic) != 1:
    raise RuntimeError(f"strategic evaluation memory paragraph changed: {strategic_text.count(old_strategic)}")
strategic.write_text(strategic_text.replace(old_strategic, new_strategic, 1))

usage = Path("docs/usage.md")
usage_text = usage.read_text()
old_usage = """frontier model writes private between-game notebook bytes from only its
seat-authorized Game 1 history and the open team sheets. The same model then
plays the remaining matched continuations under two arms:
"""
new_usage = """frontier model writes private between-game notebook bytes from only its
seat-authorized Game 1 history and the open team sheets. The checkpoint binds
that exact authorized source POV and drains it before Game 2, so the
continuation receives source-game information only through the declared
treatment bytes. The same model then plays the remaining matched continuations
under two arms:
"""
if usage_text.count(old_usage) != 1:
    raise RuntimeError(f"usage memory paragraph changed: {usage_text.count(old_usage)}")
usage.write_text(usage_text.replace(old_usage, new_usage, 1))
