"""Capture representative Showdown requests used by the protocol tests."""

from __future__ import annotations

import json
from pathlib import Path

from vgcbench.engines import RandomEngine
from vgcbench.sim import REPO_ROOT, SimBattle, _default_node, _default_ps_dir
from vgcbench.teams import load_pool


class CaptureEngine(RandomEngine):
    def __init__(self, pid: str, seed: int, captured: dict[str, dict]):
        super().__init__(pid, seed)
        self.captured = captured

    def act(self, request: dict, ctx: dict) -> str:
        kind = (
            "teampreview"
            if request.get("teamPreview")
            else "forceswitch"
            if "forceSwitch" in request
            else "move"
        )
        self.captured.setdefault(kind, request)
        return super().act(request, ctx)


def main() -> None:
    ps_dir = _default_ps_dir()
    node = _default_node()
    pool = load_pool()
    captured: dict[str, dict] = {}
    for seed in range(1, 9):
        battle = SimBattle(
            pool.format,
            {"name": "capture-a", "team": pool.teams[0].packed},
            {"name": "capture-b", "team": pool.teams[1].packed},
            seed,
            ps_dir,
            node,
        )
        battle.run(
            {
                "p1": CaptureEngine("p1", seed * 2, captured),
                "p2": CaptureEngine("p2", seed * 2 + 1, captured),
            }
        )
        if {"teampreview", "move", "forceswitch"} <= captured.keys():
            break
    missing = {"teampreview", "move", "forceswitch"} - captured.keys()
    if missing:
        raise RuntimeError(f"could not capture request kinds: {', '.join(sorted(missing))}")
    output_dir = REPO_ROOT / "tests" / "data" / "showdown_requests"
    output_dir.mkdir(parents=True, exist_ok=True)
    names = {
        "teampreview": "team_preview.json",
        "move": "turn.json",
        "forceswitch": "forced_switch.json",
    }
    for kind, request in captured.items():
        path = output_dir / names[kind]
        path.write_text(json.dumps(request, indent=1, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
