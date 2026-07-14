from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


TEAMS_DIR = Path(__file__).resolve().parents[1] / "teams"


@dataclass(frozen=True)
class Team:
    id: str
    packed: str


@dataclass(frozen=True)
class TeamPool:
    id: str
    format: str
    teams: tuple[Team, ...]


def load_pool(name: str = "test", *, teams_dir: str | Path = TEAMS_DIR) -> TeamPool:
    pool_dir = Path(teams_dir) / name
    manifest_path = pool_dir / "pool.json"
    data = json.loads(manifest_path.read_text(encoding="utf-8"))

    pool_id = data.get("id")
    format_id = data.get("format")
    entries = data.get("teams")
    if not isinstance(pool_id, str) or not pool_id:
        raise ValueError(f"{manifest_path} needs a pool id")
    if not isinstance(format_id, str) or not format_id.endswith("bo3"):
        raise ValueError(f"{manifest_path} needs a Pokémon Showdown BO3 format")
    if not isinstance(entries, list) or len(entries) < 2:
        raise ValueError(f"{manifest_path} must contain at least two teams")

    teams: list[Team] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(f"invalid team entry in {manifest_path}")
        team_id = entry.get("id")
        filename = entry.get("file")
        if not isinstance(team_id, str) or not team_id:
            raise ValueError(f"every team in {manifest_path} needs an id")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"every team in {manifest_path} needs a file")
        if team_id in seen:
            raise ValueError(f"duplicate team id {team_id!r} in {manifest_path}")
        seen.add(team_id)
        packed = (pool_dir / filename).read_text(encoding="utf-8").strip()
        if not packed:
            raise ValueError(f"team {team_id!r} is empty")
        teams.append(Team(team_id, packed))

    return TeamPool(pool_id, format_id, tuple(teams))


def validate_team(packed: str, format_id: str, *, ps_dir: Path, node: str) -> None:
    result = subprocess.run(
        [node, "./pokemon-showdown", "--skip-build", "validate-team", format_id],
        input=packed + "\n",
        text=True,
        capture_output=True,
        cwd=ps_dir,
        timeout=30,
    )
    if result.returncode:
        raise ValueError((result.stderr or result.stdout).strip())


def validate_pool(pool: TeamPool, *, ps_dir: Path, node: str) -> None:
    for team in pool.teams:
        try:
            validate_team(team.packed, pool.format, ps_dir=ps_dir, node=node)
        except ValueError as exc:
            raise ValueError(f"invalid team {team.id!r}: {exc}") from exc
