from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Literal

from pydantic import ConfigDict, Field, SerializeAsAny
from verifiers import v1 as vf

from .protocol import SUBSTRATE_PIN

ScenarioId = Literal["victory-road-top8-v1", "draft-league-v1"]


class VgcCircuitData(vf.TaskData):

    model_config = ConfigDict(frozen=True, extra="forbid")

    idx: int = Field(ge=0)
    scenario_id: ScenarioId
    seed: int = Field(ge=0)
    case_id: str = Field(min_length=1)
    condition_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt: None = None
    system_prompt: None = None


class VgcCircuitTaskConfig(vf.TaskConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    judges: tuple[()] = ()


class VgcCircuitTask(
    vf.Task[VgcCircuitData, vf.State, VgcCircuitTaskConfig]
):
    pass


class VgcCircuitTasksetConfig(vf.TasksetConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task: SerializeAsAny[VgcCircuitTaskConfig] = VgcCircuitTaskConfig()
    scenario: ScenarioId = "draft-league-v1"
    seed_start: int = Field(0, ge=0)
    num_blocks: int = Field(1, ge=1, le=10_000)
    system_prompt: None = None


class VgcCircuitTaskset(
    vf.Taskset[VgcCircuitTask, VgcCircuitTasksetConfig]
):

    def load(self) -> Iterable[VgcCircuitTask]:
        scenario_id = self.config.scenario
        for idx, seed in enumerate(
            range(
                self.config.seed_start,
                self.config.seed_start + self.config.num_blocks,
            )
        ):
            case_id = f"{scenario_id}:{seed}"
            identity = {
                "caseId": case_id,
                "scenarioId": scenario_id,
                "seed": seed,
                **SUBSTRATE_PIN,
            }
            condition_digest = hashlib.sha256(
                json.dumps(
                    identity,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            yield VgcCircuitTask(
                VgcCircuitData(
                    idx=idx,
                    scenario_id=scenario_id,
                    seed=seed,
                    case_id=case_id,
                    condition_digest=condition_digest,
                ),
                self.config.task,
            )
