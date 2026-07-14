from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from vgcbench.sim import default_node, default_ps_dir
from vgcbench.teams import validate_team

USAGE = "Usage: python tools/build_pool.py teams/<pool>/sources.json"


def fetch_paste(url: str) -> str:
    raw_url = url.replace("http://", "https://").rstrip("/") + "/raw"
    request = urllib.request.Request(raw_url, headers={"User-Agent": "vgcbench-pool-builder"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def pack_team(export_text: str, ps_dir: Path, node: str) -> str:
    result = subprocess.run(
        [node, "./pokemon-showdown", "--skip-build", "pack-team"],
        input=export_text,
        text=True,
        capture_output=True,
        cwd=ps_dir,
        check=True,
        timeout=30,
    )
    packed = result.stdout.strip()
    if not packed:
        raise ValueError("pack-team produced no output")
    return packed


def species_key(packed: str) -> tuple[str, ...]:
    species = []
    for entry in packed.split("]"):
        if not entry:
            continue
        fields = entry.split("|")
        name = fields[1] if len(fields) > 1 and fields[1] else fields[0]
        species.append("".join(ch for ch in name.lower() if ch.isalnum()))
    return tuple(sorted(species))


def _existing_output(paths: list[Path]) -> Path | None:
    return next((path for path in paths if path.exists() or path.is_symlink()), None)


def _publish(staging_dir: Path, pool_dir: Path, names: list[str]) -> None:
    published: list[Path] = []
    try:
        for name in names:
            target = pool_dir / name
            os.link(staging_dir / name, target)
            published.append(target)
    except BaseException:
        for target in reversed(published):
            target.unlink(missing_ok=True)
        raise


def main(manifest_path: str) -> int:
    manifest_file = Path(manifest_path)
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    pool_dir = manifest_file.parent
    pool_id = manifest["id"]
    format_id = manifest["format"]
    ps_dir = default_ps_dir()
    node = default_node()
    team_names = [f"{team['id']}.team" for team in manifest["teams"]]
    output_names = [*team_names, "pool.json"]
    existing = _existing_output([pool_dir / name for name in output_names])
    if existing is not None:
        raise FileExistsError(f"refusing to overwrite existing output: {existing}")

    seen: dict[tuple[str, ...], str] = {}
    entries = []
    packed_teams: list[str] = []
    for team in manifest["teams"]:
        team_id = team["id"]
        packed = pack_team(fetch_paste(team["paste"]), ps_dir, node)
        validate_team(packed, format_id, ps_dir=ps_dir, node=node)
        key = species_key(packed)
        if key in seen:
            raise SystemExit(f"{team_id} duplicates the species set of {seen[key]}: {', '.join(key)}")
        seen[key] = team_id
        packed_teams.append(packed)
        entries.append(
            {
                "id": team_id,
                "file": f"{team_id}.team",
                "source": {k: v for k, v in team.items() if k not in ("id",)},
            }
        )
        print(f"{team_id}: ok ({len(key)} mons)")

    staging_dir = Path(tempfile.mkdtemp(prefix=f".{pool_dir.name}.", dir=pool_dir.parent))
    try:
        for name, packed in zip(team_names, packed_teams, strict=True):
            (staging_dir / name).write_text(packed + "\n", encoding="utf-8")
        (staging_dir / "pool.json").write_text(
            json.dumps({"id": pool_id, "format": format_id, "teams": entries}, indent=2) + "\n",
            encoding="utf-8",
        )
        existing = _existing_output([pool_dir / name for name in output_names])
        if existing is not None:
            raise FileExistsError(f"refusing to overwrite existing output: {existing}")
        _publish(staging_dir, pool_dir, output_names)
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    print(f"wrote {pool_dir / 'pool.json'} with {len(entries)} teams")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(USAGE)
    raise SystemExit(main(sys.argv[1]))
