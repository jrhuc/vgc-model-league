from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable
from dataclasses import dataclass
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


class FrozenMatchdayData(vf.TaskData):
    """Public, trace-facing matchday metadata. Referee options never live here."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    idx: int = Field(ge=0)
    name: None = None
    description: None = None
    case_id: str
    condition_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_config_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    showdown_revision: Literal[SHOWDOWN_REVISION]
    format: Literal[FROZEN_MATCHDAY_FORMAT]
    jsonl_protocol_version: Literal[JSONL_PROTOCOL_VERSION]
    matchday_protocol_version: Literal[MATCHDAY_PROTOCOL_VERSION]
    battle_protocol_version: Literal[BATTLE_PROTOCOL_VERSION]
    prompt: None = None
    system_prompt: None = None
    image: None = None
    workdir: None = None
    network_allow: tuple[Literal["*"]] = ("*",)
    network_block: tuple[()] = ()
    artifacts: tuple[()] = ()
    timeout: vf.TaskTimeout = vf.TaskTimeout()
    resources: vf.TaskResources = vf.TaskResources()

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_"):
            raise AttributeError("frozen matchday data do not allow private state")
        super().__setattr__(name, value)

    @field_validator("case_id")
    @classmethod
    def _nonempty_case_id(cls, value: str) -> str:
        if not value:
            raise ValueError("case_id must be nonempty")
        return value

    @field_validator(
        "idx",
        "jsonl_protocol_version",
        "matchday_protocol_version",
        "battle_protocol_version",
        mode="before",
    )
    @classmethod
    def _exact_integer(cls, value: Any) -> Any:
        if type(value) is not int:
            raise ValueError("indices and protocol versions must be exact integers")
        return value

    @model_validator(mode="after")
    def _fixed_framework_fields(self) -> FrozenMatchdayData:
        if self.timeout != vf.TaskTimeout() or self.resources != vf.TaskResources():
            raise ValueError("frozen matchday task limits cannot be overridden")
        return self


_REQUIRED_ROW_KEYS = {
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
_PUBLIC_ROW_KEYS = _REQUIRED_ROW_KEYS - {"options"}


def _reject_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def _parse_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("JSON number must be finite")
    return parsed


def _pairs_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key {key!r}")
        value[key] = item
    return value


def _parse_json(text: str) -> Any:
    return json.loads(
        text,
        object_pairs_hook=_pairs_object,
        parse_constant=_reject_constant,
        parse_float=_parse_float,
    )


def _source_rows(text: str) -> list[dict[str, Any]]:
    stripped = text.lstrip()
    if stripped.startswith("["):
        value = _parse_json(text)
        if not isinstance(value, list):
            raise ValueError("matchday source must be a JSON array or JSON Lines")
        rows = value
    else:
        rows = [_parse_json(line) for line in text.splitlines() if line.strip()]
    if not rows:
        raise ValueError("matchday source must contain at least one row")
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"matchday source row {index} must be a JSON object")
    return rows


def _normalize_source(value: Any) -> Path:
    try:
        return Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, TypeError) as exc:
        raise ValueError(f"sealed matchday source is unavailable: {value}") from exc


def _read_source(source: Path) -> tuple[bytes, str]:
    try:
        encoded = source.read_bytes()
    except OSError as exc:
        raise ValueError(f"sealed matchday source is unavailable: {source}") from exc
    try:
        text = encoded.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError("sealed matchday source must be UTF-8") from exc
    return encoded, text


def _exact_value_equal(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return set(left) == set(right) and all(
            _exact_value_equal(left[key], right[key]) for key in left
        )
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(
            _exact_value_equal(a, b) for a, b in zip(left, right)
        )
    return left == right


def _require_exact_model_state(model: Any, expected_fields: set[str]) -> None:
    if type(model.__dict__) is not dict or set(model.__dict__) != expected_fields:
        raise ValueError("sealed matchday model contains unexpected copied state")
    if getattr(model, "__pydantic_extra__", None):
        raise ValueError("sealed matchday model contains unexpected extra state")
    if getattr(model, "__pydantic_private__", None):
        raise ValueError("sealed matchday model contains unexpected private state")


@dataclass(frozen=True)
class _SourceRow:
    data: FrozenMatchdayData
    options: dict[str, Any]


def _load_source_rows(
    source: Path, expected_sha256: str | None = None
) -> tuple[str, tuple[_SourceRow, ...]]:
    encoded, text = _read_source(source)
    source_sha256 = hashlib.sha256(encoded).hexdigest()
    if expected_sha256 is not None and source_sha256 != expected_sha256:
        raise ValueError("sealed matchday source changed from its configured identity")

    rows: list[_SourceRow] = []
    seen_case_ids: set[str] = set()
    for idx, source_row in enumerate(_source_rows(text)):
        if set(source_row) != _REQUIRED_ROW_KEYS:
            missing = sorted(_REQUIRED_ROW_KEYS - set(source_row))
            extra = sorted(set(source_row) - _REQUIRED_ROW_KEYS)
            raise ValueError(
                f"matchday source row {idx} keys mismatch; missing={missing}, extra={extra}"
            )
        options = source_row["options"]
        if not isinstance(options, dict):
            raise ValueError(f"matchday source row {idx} options must be a JSON object")
        public = {key: source_row[key] for key in _PUBLIC_ROW_KEYS}
        data = FrozenMatchdayData(idx=idx, **public)
        if data.case_id in seen_case_ids:
            raise ValueError(f"duplicate matchday case_id {data.case_id!r}")
        seen_case_ids.add(data.case_id)
        rows.append(_SourceRow(data, options))
    return source_sha256, tuple(rows)


class FrozenMatchdayTaskConfig(vf.TaskConfig):
    """Serializable source identity used to reconstruct sealed controller input."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    judges: tuple[()] = ()
    source: Path | None = Field(default=None, repr=False)
    source_sha256: str | None = Field(
        default=None, pattern=r"^[0-9a-f]{64}$", repr=False
    )

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_"):
            raise AttributeError("frozen matchday config does not allow private state")
        super().__setattr__(name, value)

    @model_validator(mode="before")
    @classmethod
    def _reject_reward_plugins(cls, data: Any) -> Any:
        if isinstance(data, dict) and data.get("judges"):
            raise ValueError("frozen matchday tasks do not allow judge/reward plugins")
        return data

    @field_validator("source", mode="before")
    @classmethod
    def _absolute_source(cls, value: Any) -> Path | None:
        return None if value is None else _normalize_source(value)

    @model_validator(mode="after")
    def _validate_sealed_source(self) -> FrozenMatchdayTaskConfig:
        if (self.source is None) != (self.source_sha256 is None):
            raise ValueError("sealed source and source identity must be configured together")
        if self.source is not None:
            _load_source_rows(self.source, self.source_sha256)
        return self

    def model_copy(
        self, *, update: dict[str, Any] | None = None, deep: bool = False
    ) -> FrozenMatchdayTaskConfig:
        if update and not set(update) <= set(type(self).model_fields):
            raise ValueError("sealed matchday config copy contains unexpected fields")
        copied = super().model_copy(update=update, deep=deep)
        return FrozenMatchdayTaskConfig.model_validate(
            copied.model_dump(mode="python")
        )

    def copy(
        self,
        *,
        include: Any = None,
        exclude: Any = None,
        update: dict[str, Any] | None = None,
        deep: bool = False,
    ) -> FrozenMatchdayTaskConfig:
        if include is not None or exclude is not None:
            raise ValueError("sealed matchday config copies cannot include/exclude fields")
        return self.model_copy(update=update, deep=deep)

    def _checked_rows(self) -> tuple[_SourceRow, ...]:
        if type(self) is not FrozenMatchdayTaskConfig:
            raise TypeError("sealed matchday config must have its exact concrete type")
        _require_exact_model_state(self, set(FrozenMatchdayTaskConfig.model_fields))
        if type(self.judges) is not tuple or self.judges != ():
            raise ValueError("frozen matchday tasks do not allow judge/reward plugins")
        if self.source is None or self.source_sha256 is None:
            raise ValueError("sealed matchday source is not configured")
        if not isinstance(self.source, Path) or not self.source.is_absolute():
            raise ValueError("sealed matchday source must be an absolute resolved path")
        try:
            current_source = self.source.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError(
                f"sealed matchday source is unavailable: {self.source}"
            ) from exc
        if current_source != self.source:
            raise ValueError("sealed matchday source path changed from its resolved identity")
        if (
            type(self.source_sha256) is not str
            or len(self.source_sha256) != 64
            or any(character not in "0123456789abcdef" for character in self.source_sha256)
        ):
            raise ValueError("sealed matchday source identity is invalid")
        _source_sha256, rows = _load_source_rows(self.source, self.source_sha256)
        return rows

    def task_data(self) -> tuple[FrozenMatchdayData, ...]:
        """Reload the sealed source and return newly validated indexed public rows."""

        rows = FrozenMatchdayTaskConfig._checked_rows(self)
        return tuple(row.data for row in rows)

    def options_for(self, data: FrozenMatchdayData) -> dict[str, Any]:
        """Reload the source, bind every public field to ``idx``, and reveal options."""

        if type(self) is not FrozenMatchdayTaskConfig:
            raise TypeError("sealed matchday config must have its exact concrete type")
        _require_exact_model_state(self, set(FrozenMatchdayTaskConfig.model_fields))
        if type(data) is not FrozenMatchdayData:
            raise TypeError("FrozenMatchdayTask requires exact FrozenMatchdayData")
        _require_exact_model_state(data, set(FrozenMatchdayData.model_fields))
        idx = data.idx
        if type(idx) is not int or idx < 0:
            raise ValueError("frozen matchday task idx must be a non-negative integer")
        rows = FrozenMatchdayTaskConfig._checked_rows(self)
        if idx >= len(rows):
            raise ValueError(f"frozen matchday task idx {idx} is out of range")
        expected = rows[idx].data
        actual_record = data.__dict__
        expected_record = expected.__dict__
        if not _exact_value_equal(actual_record, expected_record):
            changed = sorted(
                key
                for key in expected_record
                if not _exact_value_equal(actual_record.get(key), expected_record[key])
            )
            raise ValueError(
                f"frozen matchday public metadata does not match source row {idx}; "
                f"fields={changed}"
            )
        return rows[idx].options


class FrozenMatchdayTask(
    vf.Task[FrozenMatchdayData, vf.State, FrozenMatchdayTaskConfig]
):
    """Behavior half which recovers sealed referee input only when requested."""

    def __init__(
        self,
        data: FrozenMatchdayData,
        config: FrozenMatchdayTaskConfig | None = None,
    ) -> None:
        if type(data) is not FrozenMatchdayData:
            raise TypeError("FrozenMatchdayTask requires exact FrozenMatchdayData")
        if config is not None and type(config) is not FrozenMatchdayTaskConfig:
            raise TypeError("FrozenMatchdayTask requires exact FrozenMatchdayTaskConfig")
        super().__init__(data, config)
        FrozenMatchdayTaskConfig.options_for(self.config, self.data)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in {"_options", "_source_registry"}:
            raise AttributeError("frozen matchday controller data are never stored on the task")
        if name in {"data", "config"} and name in self.__dict__:
            raise AttributeError(f"frozen matchday task {name} cannot be reassigned")
        super().__setattr__(name, value)

    def with_system_prompt(self, system_prompt: str) -> FrozenMatchdayTask:
        raise ValueError("frozen matchday tasks do not allow a system prompt")

    @property
    def options(self) -> dict[str, Any]:
        """Return a fresh JSON object after revalidating source identity and binding."""

        return FrozenMatchdayTaskConfig.options_for(self.config, self.data)


class FrozenMatchdayTasksetConfig(vf.TasksetConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task: SerializeAsAny[FrozenMatchdayTaskConfig] = FrozenMatchdayTaskConfig()
    source: Path
    system_prompt: None = None

    @model_validator(mode="before")
    @classmethod
    def _bind_task_to_source(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if data.get("system_prompt") is not None:
            raise ValueError("frozen matchday tasks require system_prompt=None")
        source_value = data.get("source")
        if source_value is None:
            return data
        source = _normalize_source(source_value)
        source_sha256, _rows = _load_source_rows(source)
        raw_task = data.get("task")
        if isinstance(raw_task, vf.TaskConfig):
            if type(raw_task) is not FrozenMatchdayTaskConfig:
                raise TypeError("task config must have its exact concrete type")
            task = raw_task.model_dump(mode="python")
        else:
            task = dict(raw_task or {})
        configured_source = task.get("source")
        if configured_source is not None and _normalize_source(configured_source) != source:
            raise ValueError("task source does not match taskset source")
        configured_identity = task.get("source_sha256")
        if configured_identity is not None and configured_identity != source_sha256:
            raise ValueError("sealed matchday source changed from its configured identity")
        task["source"] = source
        task["source_sha256"] = source_sha256
        return {**data, "source": source, "task": task}

    @model_validator(mode="after")
    def _verify_task_binding(self) -> FrozenMatchdayTasksetConfig:
        if type(self.task) is not FrozenMatchdayTaskConfig:
            raise TypeError("task config must have its exact concrete type")
        if self.task.source != self.source:
            raise ValueError("task source does not match taskset source")
        FrozenMatchdayTaskConfig._checked_rows(self.task)
        return self


class FrozenMatchdayTaskset(
    vf.Taskset[FrozenMatchdayTask, FrozenMatchdayTasksetConfig]
):
    def __init__(self, config: FrozenMatchdayTasksetConfig) -> None:
        if type(config) is not FrozenMatchdayTasksetConfig:
            raise TypeError("taskset config must have its exact concrete type")
        if config.system_prompt is not None:
            raise ValueError("frozen matchday tasks require system_prompt=None")
        if type(config.task) is not FrozenMatchdayTaskConfig:
            raise TypeError("task config must have its exact concrete type")
        if config.source != config.task.source:
            raise ValueError("task source does not match taskset source")
        FrozenMatchdayTaskConfig._checked_rows(config.task)
        super().__init__(config)

    def load(self) -> Iterable[FrozenMatchdayTask]:
        config = self.config.task
        for data in FrozenMatchdayTaskConfig.task_data(config):
            yield FrozenMatchdayTask(data, config)
