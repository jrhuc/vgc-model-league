from __future__ import annotations

import hashlib
import json

import pytest
from pydantic import ValidationError

import vgc_circuit_v1
from vgc_circuit_v1.protocol import SUBSTRATE_PIN
from vgc_circuit_v1.taskset import (
    VgcCircuitData,
    VgcCircuitTaskset,
    VgcCircuitTasksetConfig,
)


def test_exact_exports_and_builtin_frozen_serializable_case() -> None:
    assert vgc_circuit_v1.__all__ == [
        "VgcCircuitTaskset",
        "VgcCircuitEnv",
    ]
    tasks = list(
        VgcCircuitTaskset(
            VgcCircuitTasksetConfig(scenario="victory-road-top8-v1")
        )
    )
    assert [task.data.case_id for task in tasks] == ["victory-road-top8-v1:0"]
    assert [task.data.scenario_id for task in tasks] == ["victory-road-top8-v1"]
    assert [task.data.seed for task in tasks] == [0]
    for task in tasks:
        public = task.data.model_dump(mode="json")
        assert VgcCircuitData.model_validate_json(json.dumps(public)) == task.data
        encoded = json.dumps(public, sort_keys=True)
        assert "options" not in encoded
        assert "/runs" not in encoded
        assert "/Users/" not in encoded
        assert "api_key" not in encoded.lower()
        with pytest.raises(ValidationError, match="frozen"):
            task.data.seed = 4


def test_finite_scenario_seed_blocks() -> None:
    config = VgcCircuitTasksetConfig(
        scenario="draft-league-v1",
        seed_start=11,
        num_blocks=3,
    )
    taskset = VgcCircuitTaskset(config)
    assert taskset.INFINITE is False
    tasks = list(taskset)
    assert [(task.data.idx, task.data.scenario_id, task.data.seed) for task in tasks] == [
        (0, "draft-league-v1", 11),
        (1, "draft-league-v1", 12),
        (2, "draft-league-v1", 13),
    ]
    assert [task.data.case_id for task in tasks] == [
        "draft-league-v1:11",
        "draft-league-v1:12",
        "draft-league-v1:13",
    ]
    assert len({task.data.case_id for task in tasks}) == 3
    assert len({task.data.condition_digest for task in tasks}) == 3
    assert all(
        len(task.data.condition_digest) == 64 for task in tasks
    )
    default_tasks = list(VgcCircuitTaskset(VgcCircuitTasksetConfig()))
    assert [task.data.scenario_id for task in default_tasks] == ["draft-league-v1"]
    assert [task.data.case_id for task in default_tasks] == ["draft-league-v1:0"]
    with pytest.raises(ValidationError):
        VgcCircuitTasksetConfig(scenario="all")
    with pytest.raises(ValidationError):
        VgcCircuitTasksetConfig(scenario="draft-league-v1", num_blocks=0)


def test_condition_digest_binds_the_substrate_pin() -> None:
    task = next(iter(VgcCircuitTaskset(VgcCircuitTasksetConfig(seed_start=7))))
    identity = {
        "caseId": "draft-league-v1:7",
        "scenarioId": "draft-league-v1",
        "seed": 7,
        **SUBSTRATE_PIN,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    assert task.data.condition_digest == hashlib.sha256(encoded.encode()).hexdigest()
    for key in SUBSTRATE_PIN:
        drifted = {**identity, key: "drifted"}
        assert task.data.condition_digest != hashlib.sha256(
            json.dumps(drifted, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
