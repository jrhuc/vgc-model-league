from pathlib import Path

script = Path("tools/fix-matchday-memory-boundary.py")
text = script.read_text()
old = """    \"\"\"It creates a
content-addressed between-game checkpoint, replaces exact notebook bytes,
changes only preregistered future seeds, and continues through strict declared
controllers with no fallback. Source, checkpoint, fork configuration, and
terminal evidence digests remain joined in every outcome.
\"\"\",
"""
new = """    \"\"\"It creates a
content-addressed between-game checkpoint, replaces exact notebook bytes,
changes only preregistered future seeds, and continues through strict declared
controllers with no fallback. Source, checkpoint, fork configuration, and
terminal evidence digests remain joined in every outcome. The execution digest
also binds the matched plan, arm, common draw, focal seat, treatment, and
controller set.
\"\"\",
"""
if text.count(old) != 1:
    raise RuntimeError(f"boundary script documentation pattern changed: {text.count(old)}")
script.write_text(text.replace(old, new, 1))
exec(compile(script.read_text(), str(script), "exec"))
