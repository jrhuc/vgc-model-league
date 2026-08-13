from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

import vgc_draft_circuit_v1
from vgc_draft_circuit_v1.taskset import (
    VgcDraftCircuitData,
    VgcDraftCircuitTaskset,
    VgcDraftCircuitTasksetConfig,
)


def test_exact_exports_and_builtin_frozen_serializable_cases() -> None:
    assert vgc_draft_circuit_v1.__all__ == [
        "VgcDraftCircuitTaskset",
        "VgcDraftCircuitEnv",
    ]
    tasks = list(VgcDraftCircuitTaskset(VgcDraftCircuitTasksetConfig()))
    assert [task.data.case_id for task in tasks] == [
        "victory-road-top8-v1",
        "draft-league-v1",
    ]
    assert [task.data.scenario_id for task in tasks] == [
        "victory-road-top8-v1",
        "draft-league-v1",
    ]
    assert [task.data.seed for task in tasks] == [0, 0]
    for task in tasks:
        public = task.data.model_dump(mode="json")
        assert VgcDraftCircuitData.model_validate_json(
            json.dumps(public)
        ) == task.data
        encoded = json.dumps(public, sort_keys=True)
        assert "options" not in encoded
        assert "/runs" not in encoded
        assert "/Users/" not in encoded
        assert "api_key" not in encoded.lower()
        with pytest.raises(ValidationError, match="frozen"):
            task.data.seed = 4


def test_finite_scenario_seed_blocks() -> None:
    config = VgcDraftCircuitTasksetConfig(
        scenario="draft-league-v1",
        seed_start=11,
        num_blocks=3,
    )
    taskset = VgcDraftCircuitTaskset(config)
    assert taskset.INFINITE is False
    tasks = list(taskset)
    assert [(task.data.idx, task.data.scenario_id, task.data.seed) for task in tasks] == [
        (0, "draft-league-v1", 11),
        (1, "draft-league-v1", 12),
        (2, "draft-league-v1", 13),
    ]
    assert len({task.data.condition_digest for task in tasks}) == 3
    assert all(
        len(task.data.condition_digest) == 64 for task in tasks
    )
    all_tasks = list(
        VgcDraftCircuitTaskset(
            VgcDraftCircuitTasksetConfig(seed_start=7, num_blocks=2)
        )
    )
    assert [(task.data.scenario_id, task.data.seed) for task in all_tasks] == [
        ("victory-road-top8-v1", 7),
        ("draft-league-v1", 7),
        ("victory-road-top8-v1", 8),
        ("draft-league-v1", 8),
    ]
    with pytest.raises(ValidationError):
        VgcDraftCircuitTasksetConfig(num_blocks=0)
