from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from verifiers import v1 as vf
from verifiers.v1.serve.pool import env_config_data

from vgc_frozen_matchday_v0.env import FrozenMatchdayEnv, FrozenMatchdayEnvConfig
from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
)
from vgc_frozen_matchday_v0.taskset import (
    FrozenMatchdayTask,
    FrozenMatchdayTaskset,
    FrozenMatchdayTasksetConfig,
)


def _row(case_id: str, marker: str = "private-team") -> dict:
    return {
        "case_id": case_id,
        "condition_digest": "a" * 64,
        "expected_config_digest": "b" * 64,
        "showdown_revision": SHOWDOWN_REVISION,
        "format": FROZEN_MATCHDAY_FORMAT,
        "jsonl_protocol_version": JSONL_PROTOCOL_VERSION,
        "matchday_protocol_version": MATCHDAY_PROTOCOL_VERSION,
        "battle_protocol_version": BATTLE_PROTOCOL_VERSION,
        "options": {
            "construction": marker,
            "gameSeeds": [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
        },
    }


def _write(path: Path, rows: list[dict]) -> bytes:
    encoded = "".join(
        json.dumps(
            row,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
        for row in rows
    ).encode()
    path.write_bytes(encoded)
    return encoded


def test_canonical_jsonl_path_sha_public_row_and_fresh_private_reload(
    tmp_path: Path,
) -> None:
    source = tmp_path / "task-source.jsonl"
    encoded = _write(source, [_row("case-1"), _row("case-2", "other-private")])
    config = FrozenMatchdayTasksetConfig(id="vgc-frozen-matchday-v0", source=source)

    assert config.source == source.resolve()
    assert config.task.source == source.resolve()
    assert config.task.source_sha256 == hashlib.sha256(encoded).hexdigest()
    tasks = list(FrozenMatchdayTaskset(config))
    assert [task.data.idx for task in tasks] == [0, 1]
    assert [task.data.case_id for task in tasks] == ["case-1", "case-2"]
    assert all(isinstance(task, FrozenMatchdayTask) for task in tasks)
    public = [task.data.model_dump(mode="json") for task in tasks]
    assert all("options" not in row for row in public)
    assert "private-team" not in json.dumps(public)
    assert "task-source.jsonl" not in json.dumps(public)

    first = tasks[0].options()
    second = tasks[0].options()
    assert first == second == _row("case-1")["options"]
    assert first is not second
    first["construction"] = "mutated caller copy"
    assert tasks[0].options()["construction"] == "private-team"

    changed = _row("case-1", "changed-on-disk")
    _write(source, [changed, _row("case-2", "other-private")])
    with pytest.raises(ValueError, match="source bytes changed"):
        tasks[0].options()

    array = tmp_path / "array.json"
    array.write_text(json.dumps([_row("array")]) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="row 0"):
        FrozenMatchdayTasksetConfig(source=array)

    noncanonical = tmp_path / "pretty.jsonl"
    noncanonical.write_text(json.dumps(_row("pretty")) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="canonical"):
        FrozenMatchdayTasksetConfig(source=noncanonical)

    no_newline = tmp_path / "no-newline.jsonl"
    no_newline.write_text(
        json.dumps(_row("no-newline"), sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="newline terminated"):
        FrozenMatchdayTasksetConfig(source=no_newline)


def test_serialized_v030_config_reconstructs_task_behavior_without_private_taskdata(
    tmp_path: Path,
) -> None:
    source = tmp_path / "task-source.jsonl"
    _write(source, [_row("wire-case", "wire-private")])
    taskset = FrozenMatchdayTasksetConfig(
        id="vgc-frozen-matchday-v0", source=source
    )
    agent = vf.AgentConfig(
        harness=vf.HarnessConfig(id="null"),
        retries=vf.RetryConfig(max_retries=0),
    )
    config = FrozenMatchdayEnvConfig(
        taskset=taskset,
        entrant=agent,
        opponent=agent,
        referee=agent,
    )
    wire = json.loads(json.dumps(env_config_data(config)))
    assert "wire-private" not in json.dumps(wire)
    assert wire["taskset"]["task"]["source"] == str(source.resolve())
    assert wire["taskset"]["task"]["source_sha256"] == hashlib.sha256(
        source.read_bytes()
    ).hexdigest()

    rebuilt = vf.resolve_env_config(wire)
    env = FrozenMatchdayEnv(rebuilt)
    task = next(iter(env.taskset))
    public_wire = json.loads(json.dumps(task.data.model_dump(mode="json")))
    rebuilt_task = FrozenMatchdayTask(
        type(task.data).model_validate(public_wire), env.taskset.config.task
    )
    assert rebuilt_task.options()["construction"] == "wire-private"
    assert "wire-private" not in json.dumps(public_wire)

    with pytest.raises(Exception):
        task.data.case_id = "changed"
    with pytest.raises(Exception):
        env.taskset.config.task.source_sha256 = "0" * 64
