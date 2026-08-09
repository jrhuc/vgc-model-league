from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal

from pydantic import ConfigDict, Field, SerializeAsAny, field_validator, model_validator
from verifiers import v1 as vf

from .protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
)

_ROW_KEYS = {
    "case_id",
    "condition_digest",
    "expected_config_digest",
    "showdown_revision",
    "format",
    "jsonl_protocol_version",
    "matchday_protocol_version",
    "battle_protocol_version",
    "options",
}
_PUBLIC_KEYS = _ROW_KEYS - {"options"}


class FrozenMatchdayData(vf.TaskData):
    """The public half of one freezer row."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    idx: int = Field(ge=0)
    case_id: str = Field(min_length=1)
    condition_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_config_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    showdown_revision: Literal[SHOWDOWN_REVISION]
    format: Literal[FROZEN_MATCHDAY_FORMAT]
    jsonl_protocol_version: Literal[JSONL_PROTOCOL_VERSION]
    matchday_protocol_version: Literal[MATCHDAY_PROTOCOL_VERSION]
    battle_protocol_version: Literal[BATTLE_PROTOCOL_VERSION]
    prompt: None = None
    system_prompt: None = None


class FrozenMatchdayTaskConfig(vf.TaskConfig):
    """Serializable path and byte identity for the private freezer output."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    judges: tuple[()] = ()
    source: Path | None = None
    source_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @field_validator("source", mode="before")
    @classmethod
    def _resolved_source(cls, value: Any) -> Path | None:
        return None if value is None else _source_path(value)

    @model_validator(mode="after")
    def _complete_binding(self) -> FrozenMatchdayTaskConfig:
        if (self.source is None) != (self.source_sha256 is None):
            raise ValueError("source and source_sha256 must be configured together")
        return self


class FrozenMatchdayTask(
    vf.Task[FrozenMatchdayData, vf.State, FrozenMatchdayTaskConfig]
):
    def options(self) -> dict[str, Any]:
        """Reload and reveal a fresh private options object bound to this public row."""

        source = self.config.source
        digest = self.config.source_sha256
        if source is None or digest is None:
            raise ValueError("frozen matchday task has no bound source")
        rows, _ = _load_rows(source, digest)
        if self.data.idx >= len(rows):
            raise ValueError("frozen matchday task index is outside its source")
        public, options = rows[self.data.idx]
        actual = self.data.model_dump(
            mode="json", include={"idx", *_PUBLIC_KEYS}
        )
        expected = public.model_dump(
            mode="json", include={"idx", *_PUBLIC_KEYS}
        )
        if actual != expected:
            raise ValueError("frozen matchday public row does not match its source")
        return options


class FrozenMatchdayTasksetConfig(vf.TasksetConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task: SerializeAsAny[FrozenMatchdayTaskConfig] = FrozenMatchdayTaskConfig()
    source: Path
    system_prompt: None = None

    @model_validator(mode="before")
    @classmethod
    def _bind_source(cls, value: Any) -> Any:
        if not isinstance(value, dict) or value.get("source") is None:
            return value
        source = _source_path(value["source"])
        _, digest = _load_rows(source)
        raw_task = value.get("task")
        task = (
            raw_task.model_dump(mode="python")
            if isinstance(raw_task, FrozenMatchdayTaskConfig)
            else dict(raw_task or {})
        )
        if task.get("source") is not None and _source_path(task["source"]) != source:
            raise ValueError("task and taskset sources differ")
        if task.get("source_sha256") not in {None, digest}:
            raise ValueError("task source SHA-256 differs from the freezer output")
        task.update(source=source, source_sha256=digest)
        return {**value, "source": source, "task": task}

    @model_validator(mode="after")
    def _same_source(self) -> FrozenMatchdayTasksetConfig:
        if self.task.source != self.source:
            raise ValueError("task and taskset sources differ")
        return self


class FrozenMatchdayTaskset(
    vf.Taskset[FrozenMatchdayTask, FrozenMatchdayTasksetConfig]
):
    def load(self) -> Iterable[FrozenMatchdayTask]:
        source = self.config.task.source
        digest = self.config.task.source_sha256
        if source is None or digest is None:
            raise ValueError("frozen matchday taskset has no bound source")
        rows, _ = _load_rows(source, digest)
        return (FrozenMatchdayTask(data, self.config.task) for data, _ in rows)


def _source_path(value: Any) -> Path:
    try:
        return Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, TypeError) as exc:
        raise ValueError(f"frozen matchday source is unavailable: {value}") from exc


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("JSON numbers must be finite")
    return result


def _load_rows(
    source: Path, expected_sha256: str | None = None
) -> tuple[list[tuple[FrozenMatchdayData, dict[str, Any]]], str]:
    try:
        encoded = source.read_bytes()
        text = encoded.decode("utf-8", errors="strict")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValueError(f"cannot read UTF-8 freezer output {source}") from exc
    digest = hashlib.sha256(encoded).hexdigest()
    if expected_sha256 is not None and digest != expected_sha256:
        raise ValueError("frozen matchday source bytes changed")
    if not text or not text.endswith("\n"):
        raise ValueError("freezer JSONL must be nonempty and newline terminated")
    lines = text.splitlines()
    if not lines or any(not line for line in lines):
        raise ValueError("freezer JSONL must contain one object per nonempty line")

    rows: list[tuple[FrozenMatchdayData, dict[str, Any]]] = []
    case_ids: set[str] = set()
    for idx, line in enumerate(lines):
        try:
            row = json.loads(
                line,
                object_pairs_hook=_pairs,
                parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"invalid JSON constant {value}")
                ),
                parse_float=_finite_float,
            )
        except (json.JSONDecodeError, ValueError, RecursionError) as exc:
            raise ValueError(f"invalid freezer JSONL row {idx}") from exc
        if not isinstance(row, dict) or set(row) != _ROW_KEYS:
            raise ValueError(f"freezer JSONL row {idx} has an unexpected schema")
        canonical = json.dumps(
            row,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        if line != canonical:
            raise ValueError(f"freezer JSONL row {idx} is not canonical JSON")
        if not isinstance(row["options"], dict):
            raise ValueError(f"freezer JSONL row {idx} options must be an object")
        data = FrozenMatchdayData(
            idx=idx, **{key: row[key] for key in _PUBLIC_KEYS}
        )
        if data.case_id in case_ids:
            raise ValueError(f"duplicate freezer case_id {data.case_id!r}")
        case_ids.add(data.case_id)
        rows.append((data, row["options"]))
    return rows, digest
