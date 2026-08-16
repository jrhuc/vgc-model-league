from pathlib import Path

source = Path("tools/add-bounded-frontier-shard.py")
exec(compile(source.read_text(), str(source), "exec"))

pilot = Path("src/eval/frontier-pilot.ts")
text = pilot.read_text()
old = """  focalPid?: Pid;
  reasoning?: ReasoningLevel;
  drawCount?: number;
"""
new = """  focalPid?: Pid;
  reasoning?: ReasoningLevel;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  drawCount?: number;
"""
if text.count(old) != 1:
    raise RuntimeError(f"frontier pilot run input shape changed: {text.count(old)}")
pilot.write_text(text.replace(old, new, 1))
