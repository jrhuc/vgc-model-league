from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Literal

from pydantic import ConfigDict, Field, SerializeAsAny
from verifiers import v1 as vf

ScenarioId = Literal["victory-road-top8-v1", "draft-league-v1"]
ScenarioSelection = Literal["all", "victory-road-top8-v1", "draft-league-v1"]
_SCENARIOS: tuple[ScenarioId, ...] = (
    "victory-road-top8-v1",
    "draft-league-v1",
)


class VgcDraftCircuitData(vf.TaskData):

    model_config = ConfigDict(frozen=True, extra="forbid")

    idx: int = Field(ge=0)
    scenario_id: ScenarioId
    seed: int = Field(ge=0)
    case_id: str = Field(min_length=1)
    condition_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt: None = None
    system_prompt: None = None


class VgcDraftCircuitTaskConfig(vf.TaskConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    judges: tuple[()] = ()


class VgcDraftCircuitTask(
    vf.Task[VgcDraftCircuitData, vf.State, VgcDraftCircuitTaskConfig]
):
    pass


class VgcDraftCircuitTasksetConfig(vf.TasksetConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    task: SerializeAsAny[VgcDraftCircuitTaskConfig] = VgcDraftCircuitTaskConfig()
    scenario: ScenarioSelection = "all"
    seed_start: int = Field(0, ge=0)
    num_blocks: int = Field(1, ge=1, le=10_000)
    system_prompt: None = None


class VgcDraftCircuitTaskset(
    vf.Taskset[VgcDraftCircuitTask, VgcDraftCircuitTasksetConfig]
):

    def load(self) -> Iterable[VgcDraftCircuitTask]:
        scenarios: tuple[ScenarioId, ...] = (
            _SCENARIOS
            if self.config.scenario == "all"
            else (self.config.scenario,)
        )
        idx = 0
        for seed in range(
            self.config.seed_start,
            self.config.seed_start + self.config.num_blocks,
        ):
            for scenario_id in scenarios:
                identity = {
                    "caseId": scenario_id,
                    "scenarioId": scenario_id,
                    "seed": seed,
                }
                condition_digest = hashlib.sha256(
                    json.dumps(
                        identity,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                ).hexdigest()
                yield VgcDraftCircuitTask(
                    VgcDraftCircuitData(
                        idx=idx,
                        scenario_id=scenario_id,
                        seed=seed,
                        case_id=scenario_id,
                        condition_digest=condition_digest,
                    ),
                    self.config.task,
                )
                idx += 1
