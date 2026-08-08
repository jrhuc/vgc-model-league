from __future__ import annotations

import copy
import inspect
import json
import pickle
from importlib.metadata import version
from pathlib import Path

import msgpack
import pytest
from pydantic import ValidationError
from verifiers import v1 as vf
from verifiers.v1.serve.pool import env_config_data
from verifiers.v1.serve.server import EnvServer
from verifiers.v1.serve.types import RunRequest

from vgc_frozen_matchday_v0.env import FrozenMatchdayEnv, FrozenMatchdayEnvConfig
from vgc_frozen_matchday_v0.protocol import (
    BATTLE_PROTOCOL_VERSION,
    FROZEN_MATCHDAY_FORMAT,
    JSONL_PROTOCOL_VERSION,
    MATCHDAY_PROTOCOL_VERSION,
    SHOWDOWN_REVISION,
)
from vgc_frozen_matchday_v0.taskset import (
    FrozenMatchdayData,
    FrozenMatchdayTask,
    FrozenMatchdayTaskConfig,
    FrozenMatchdayTaskset,
    FrozenMatchdayTasksetConfig,
)


def row(case_id: str = "case-1") -> dict:
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
            "format": FROZEN_MATCHDAY_FORMAT,
            "gameSeeds": [[1, 2, 3, 4]],
            "seats": [
                {
                    "pid": "p1",
                    "construction": {"private": "alpha-construction"},
                },
                {
                    "pid": "p2",
                    "construction": {"private": "beta-construction"},
                },
            ],
        },
    }


def config_for(source) -> FrozenMatchdayTasksetConfig:
    return FrozenMatchdayTasksetConfig(
        id="vgc-frozen-matchday-v0", source=source
    )


def test_loader_seals_options_outside_taskdata_trace_and_request(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()) + "\n", encoding="utf-8")
    config = config_for(source)
    task = next(iter(FrozenMatchdayTaskset(config)))
    assert isinstance(task, FrozenMatchdayTask)
    assert isinstance(task.config, FrozenMatchdayTaskConfig)
    assert list(inspect.signature(FrozenMatchdayTask.__init__).parameters) == [
        "self",
        "data",
        "config",
    ]
    with pytest.raises(ValueError, match="source is not configured"):
        FrozenMatchdayTask(task.data)
    assert task.options == row()["options"]
    assert task.data.prompt is None
    assert task.data.system_prompt is None

    data_record = task.data.model_dump(mode="json")
    trace_task = vf.TraceTask(type=type(task).__name__, data=task.data)
    trace_record = trace_task.model_dump(mode="json")
    request = RunRequest(
        task_data=data_record,
        client=vf.EvalClientConfig(base_url="http://localhost"),
        model="test-model",
        sampling=vf.SamplingConfig(),
    )
    request_payload = msgpack.packb(
        request.model_dump(mode="json"), use_bin_type=True
    )
    serialized = json.dumps(
        {
            "data": data_record,
            "trace_task": trace_record,
            "data_repr": repr(task.data),
            "task_repr": repr(task),
        }
    ).encode()
    for secret in (
        b"options",
        b"gameSeeds",
        b"construction",
        b"alpha-construction",
        b"beta-construction",
        b"seats",
    ):
        assert secret not in serialized
        assert secret not in request_payload
    assert task.options["seats"][0]["construction"]["private"] == "alpha-construction"


def test_real_v030_envserver_rebuild_recovers_only_behavior_options(tmp_path) -> None:
    assert version("verifiers") == "0.3.0"
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()) + "\n", encoding="utf-8")
    taskset_config = config_for(source)
    client_task = next(iter(FrozenMatchdayTaskset(taskset_config)))

    original_env_config = FrozenMatchdayEnvConfig(taskset=taskset_config)
    config_payload = env_config_data(original_env_config)
    encoded_config = json.dumps(config_payload)
    assert "gameSeeds" not in encoded_config
    assert "construction" not in encoded_config

    rebuilt_env_config = vf.resolve_env_config(
        json.loads(json.dumps(config_payload))
    )
    assert isinstance(rebuilt_env_config.taskset, FrozenMatchdayTasksetConfig)
    assert isinstance(rebuilt_env_config.taskset.task, FrozenMatchdayTaskConfig)
    server = EnvServer(rebuilt_env_config, address="tcp://127.0.0.1:0")
    try:
        run_request = RunRequest(
            task_data=client_task.data.model_dump(mode="json"),
            client=vf.EvalClientConfig(base_url="http://localhost"),
            model="test-model",
            sampling=vf.SamplingConfig(),
        )
        server_payload = msgpack.packb(
            run_request.model_dump(mode="json"), use_bin_type=True
        )
        rebuilt_request = RunRequest.model_validate(
            msgpack.unpackb(server_payload, raw=False)
        )
        wire_data = rebuilt_request.task_data
        assert wire_data is not None
        server_task = server._build_task(wire_data)
        assert isinstance(server_task, FrozenMatchdayTask)
        assert server_task.options == row()["options"]
        assert "options" not in server_task.data.model_dump(mode="json")

        substituted = dict(wire_data)
        substituted["case_id"] = "substituted"
        with pytest.raises(ValueError, match="public metadata"):
            server._build_task(substituted)

        out_of_range = dict(wire_data)
        out_of_range["idx"] = 1
        with pytest.raises(ValueError, match="out of range"):
            server._build_task(out_of_range)

        without_idx = dict(wire_data)
        without_idx.pop("idx")
        with pytest.raises(ValidationError):
            server._build_task(without_idx)
    finally:
        server.frontend.close()
        server.ctx.term()


def test_json_array_source_and_options_validate_only_as_object(tmp_path) -> None:
    source = tmp_path / "rows.json"
    arbitrary = row()
    arbitrary["options"] = {"opaque": [None, True, 3.25, {"anything": "goes"}]}
    source.write_text(json.dumps([arbitrary]), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))
    assert task.options == arbitrary["options"]

    invalid = row()
    invalid["options"] = []
    source.write_text(json.dumps([invalid]), encoding="utf-8")
    with pytest.raises(ValueError, match="options must be a JSON object"):
        config_for(source)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("showdown_revision", "wrong"),
        ("format", "gen9vgc2026regf"),
        ("jsonl_protocol_version", JSONL_PROTOCOL_VERSION + 1),
        ("matchday_protocol_version", MATCHDAY_PROTOCOL_VERSION + 1),
        ("battle_protocol_version", BATTLE_PROTOCOL_VERSION + 1),
        ("jsonl_protocol_version", True),
        ("idx", True),
        ("idx", -1),
        ("network_allow", []),
        ("name", "model-visible-substitution"),
        ("prompt", "model-visible-substitution"),
    ],
)
def test_data_requires_exact_pins_and_framework_defaults(
    field: str, value: object
) -> None:
    values = row()
    values.pop("options")
    values["idx"] = 0
    values[field] = value
    with pytest.raises(ValidationError):
        FrozenMatchdayData(**values)


def test_source_rejects_shape_duplicate_keys_and_duplicate_case_ids(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    extra = row()
    extra["seed"] = "must not migrate into TaskData"
    source.write_text(json.dumps(extra), encoding="utf-8")
    with pytest.raises(ValueError, match="keys mismatch"):
        config_for(source)

    source.write_text(
        json.dumps(row()).replace(
            '"case_id": "case-1"',
            '"case_id": "case-1", "case_id": "case-2"',
            1,
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="duplicate JSON object key"):
        config_for(source)

    nonfinite = json.dumps(row()).replace(
        '"gameSeeds": [[1, 2, 3, 4]]', '"gameSeeds": [[1e400]]'
    )
    source.write_text(nonfinite, encoding="utf-8")
    with pytest.raises(ValueError, match="finite"):
        config_for(source)

    source.write_text(
        "\n".join((json.dumps(row()), json.dumps(row()))) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="duplicate matchday case_id"):
        config_for(source)


def test_source_identity_is_serialized_in_config_and_mutation_fails(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    config = config_for(source)
    task = next(iter(FrozenMatchdayTaskset(config)))
    config_payload = env_config_data(FrozenMatchdayEnvConfig(taskset=config))
    task_config_record = config.task.model_dump(mode="json")
    assert task_config_record["source"] == str(source)
    assert len(task_config_record["source_sha256"]) == 64
    assert "options" not in task_config_record

    changed = row()
    changed["options"]["gameSeeds"] = [[4, 3, 2, 1]]
    source.write_text(json.dumps(changed), encoding="utf-8")
    with pytest.raises(ValueError, match="source changed"):
        task.options
    with pytest.raises(ValueError, match="source changed"):
        list(FrozenMatchdayTaskset(config))

    with pytest.raises(ValidationError, match="source changed"):
        vf.resolve_env_config(config_payload)


def test_config_forbids_judges_retries_and_system_prompt_before_reads(tmp_path) -> None:
    missing_source = tmp_path / "missing-source.jsonl"
    missing_prompt = tmp_path / "missing-system-prompt.txt"
    with pytest.raises(ValidationError, match="system_prompt=None"):
        FrozenMatchdayTasksetConfig(
            id="vgc-frozen-matchday-v0",
            source=missing_source,
            system_prompt=missing_prompt,
        )

    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    with pytest.raises(ValidationError, match="judge/reward plugins"):
        FrozenMatchdayTasksetConfig(
            id="vgc-frozen-matchday-v0",
            source=source,
            task={"judges": [{"id": "reference"}]},
        )
    with pytest.raises(ValidationError):
        FrozenMatchdayTasksetConfig(
            id="vgc-frozen-matchday-v0",
            source=source,
            task={"reward_plugins": [{"id": "anything"}]},
        )

    taskset_config = config_for(source)
    with pytest.raises(ValidationError):
        taskset_config.task.judges = ()
    with pytest.raises(ValidationError):
        taskset_config.system_prompt = None
    with pytest.raises(ValueError, match="retry counts must all be zero"):
        FrozenMatchdayEnv(
            FrozenMatchdayEnvConfig(
                taskset=taskset_config,
                retries=vf.RetryConfig(max_retries=1),
            )
        )



def test_options_are_fresh_and_no_registry_or_cache_can_be_assigned(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))

    first = task.options
    second = task.options
    assert first == second == row()["options"]
    assert first is not second
    assert first["seats"] is not second["seats"]
    first["gameSeeds"][0][0] = 999
    first["seats"][0]["construction"]["private"] = "mutated"
    assert task.options == row()["options"]

    assert "_options" not in task.__dict__
    assert "_source_registry" not in task.config.__dict__
    assert not task.config.__pydantic_private__
    with pytest.raises(AttributeError, match="never stored"):
        task._options = row()["options"]
    with pytest.raises(AttributeError, match="private state"):
        task.config._source_registry = {"options": row()["options"]}
    with pytest.raises(ValueError, match="unexpected fields"):
        task.config.model_copy(
            update={"_source_registry": {"options": row()["options"]}}
        )


@pytest.mark.parametrize("shadow", ["options_for", "_checked_rows"])
def test_options_dispatch_rejects_exact_config_instance_method_shadows(
    tmp_path, shadow: str
) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))
    markers: list[str] = []

    def injected(*_args, **_kwargs) -> dict[str, str]:
        markers.append("INJECTED_OPTIONS_MARKER")
        return {"injected": "INJECTED_OPTIONS_MARKER"}

    object.__setattr__(task.config, shadow, injected)
    with pytest.raises(ValueError, match="unexpected copied state"):
        _ = task.options
    assert markers == []


def test_task_binding_is_immutable_and_prompt_copy_routes_fail(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))

    with pytest.raises(AttributeError, match="data cannot be reassigned"):
        task.data = task.data
    with pytest.raises(AttributeError, match="config cannot be reassigned"):
        task.config = task.config
    with pytest.raises(ValueError, match="do not allow a system prompt"):
        task.with_system_prompt("injected")

    copied_task = copy.copy(task)
    with pytest.raises(AttributeError, match="data cannot be reassigned"):
        copied_task.data = task.data.model_copy(update={"prompt": "injected"})
    injected = task.data.model_copy(update={"system_prompt": "injected"})
    with pytest.raises(ValueError, match="public metadata"):
        FrozenMatchdayTask(injected, task.config)
    copied_extra = task.data.model_copy(
        update={"_options": {"construction": "injected"}}
    )
    with pytest.raises(ValueError, match="unexpected copied state"):
        FrozenMatchdayTask(copied_extra, task.config)


def test_task_rejects_data_and_config_subclasses(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))

    class DataSubclass(FrozenMatchdayData):
        pass

    class ConfigSubclass(FrozenMatchdayTaskConfig):
        pass

    subclass_data = DataSubclass.model_validate(task.data.model_dump(mode="python"))
    subclass_config = ConfigSubclass.model_validate(
        task.config.model_dump(mode="python")
    )
    with pytest.raises(TypeError, match="exact FrozenMatchdayData"):
        FrozenMatchdayTask(subclass_data, task.config)
    with pytest.raises(TypeError, match="exact FrozenMatchdayTaskConfig"):
        FrozenMatchdayTask(task.data, subclass_config)
    with pytest.raises(TypeError, match="exact concrete type"):
        FrozenMatchdayTasksetConfig(
            id="vgc-frozen-matchday-v0",
            source=source,
            task=subclass_config,
        )


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("name", "changed"),
        ("description", "changed"),
        ("case_id", "changed"),
        ("condition_digest", "c" * 64),
        ("expected_config_digest", "d" * 64),
        ("showdown_revision", "changed"),
        ("format", "changed"),
        ("jsonl_protocol_version", 99),
        ("matchday_protocol_version", 99),
        ("battle_protocol_version", 99),
        ("prompt", "changed"),
        ("system_prompt", "changed"),
        ("image", "changed"),
        ("workdir", "changed"),
        ("network_allow", ("changed",)),
        ("network_block", ("changed",)),
        ("artifacts", ("changed",)),
        ("timeout", vf.TaskTimeout(agent=1)),
        ("resources", vf.TaskResources(cpu=1)),
    ],
)
def test_reconstruction_binds_every_public_field(
    tmp_path, field: str, replacement: object
) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    task = next(iter(FrozenMatchdayTaskset(config_for(source))))
    substituted = task.data.model_copy(update={field: replacement})
    with pytest.raises(ValueError, match="public metadata"):
        FrozenMatchdayTask(substituted, task.config)


def test_source_is_canonical_and_independent_of_worker_cwd(
    tmp_path, monkeypatch
) -> None:
    real_source = tmp_path / "real-rows.jsonl"
    real_source.write_text(json.dumps(row()), encoding="utf-8")
    alias = tmp_path / "rows-link.jsonl"
    alias.symlink_to(real_source)
    other_dir = tmp_path / "worker"
    other_dir.mkdir()

    monkeypatch.chdir(tmp_path)
    config = config_for(Path("rows-link.jsonl"))
    task = next(iter(FrozenMatchdayTaskset(config)))
    assert config.source == real_source.resolve()
    assert config.task.source == real_source.resolve()
    assert config.source.is_absolute()

    monkeypatch.chdir(other_dir)
    assert task.options == row()["options"]
    alternate = tmp_path / "alternate.jsonl"
    alternate_row = row("alternate")
    alternate.write_text(json.dumps(alternate_row), encoding="utf-8")
    alias.unlink()
    alias.symlink_to(alternate)
    assert task.options == row()["options"]

    real_source.unlink()
    real_source.symlink_to(alternate)
    with pytest.raises(ValueError, match="path changed"):
        task.options
    real_source.unlink()
    with pytest.raises(ValueError, match="unavailable"):
        task.options


def test_model_copy_deepcopy_and_pickle_never_carry_options(tmp_path) -> None:
    source = tmp_path / "rows.jsonl"
    source.write_text(json.dumps(row()), encoding="utf-8")
    taskset_config = config_for(source)
    task = next(iter(FrozenMatchdayTaskset(taskset_config)))

    config_copy = task.config.model_copy(deep=True)
    task_copy = copy.copy(task)
    task_deepcopy = copy.deepcopy(task)
    task_unpickled = pickle.loads(pickle.dumps(task))
    objects = [task.config, config_copy, task, task_copy, task_deepcopy, task_unpickled]
    serialized = b"\n".join(
        [pickle.dumps(item) for item in objects]
        + [repr(item).encode() for item in objects]
        + [json.dumps(task.config.model_dump(mode="json")).encode()]
    )
    for secret in (
        b"options",
        b"gameSeeds",
        b"construction",
        b"alpha-construction",
        b"beta-construction",
        b"seats",
    ):
        assert secret not in serialized
    assert config_copy.model_dump(mode="json") == task.config.model_dump(mode="json")
    for copied_task in (task_copy, task_deepcopy, task_unpickled):
        assert copied_task.options == row()["options"]
        assert "_options" not in copied_task.__dict__


def test_multi_row_direct_plugin_and_server_reconstruction_repeat(tmp_path) -> None:
    first = row("case-1")
    second = row("case-2")
    second["condition_digest"] = "c" * 64
    second["options"]["gameSeeds"] = [[4, 3, 2, 1]]
    second["options"]["seats"][0]["construction"]["private"] = "second"
    source = tmp_path / "rows.jsonl"
    source.write_text(
        "\n".join((json.dumps(first), json.dumps(second))) + "\n",
        encoding="utf-8",
    )
    taskset_config = config_for(source)

    public_rows = taskset_config.task.task_data()
    direct = [FrozenMatchdayTask(data, taskset_config.task) for data in public_rows]
    plugin_first = list(vf.load_taskset(taskset_config))
    plugin_second = list(vf.load_taskset(taskset_config))
    expected_options = [first["options"], second["options"]]
    for tasks in (direct, plugin_first, plugin_second):
        assert [task.options for task in tasks] == expected_options
        assert [task.data.idx for task in tasks] == [0, 1]

    crossed = public_rows[0].model_copy(update={"idx": 1})
    with pytest.raises(ValueError, match="public metadata"):
        FrozenMatchdayTask(crossed, taskset_config.task)

    env_config = FrozenMatchdayEnvConfig(taskset=taskset_config)
    rebuilt = vf.resolve_env_config(
        json.loads(json.dumps(env_config_data(env_config)))
    )
    server = EnvServer(rebuilt, address="tcp://127.0.0.1:0")
    try:
        for plugin_task, expected in zip(plugin_first, expected_options):
            wire = plugin_task.data.model_dump(mode="json")
            server_task = server._build_task(
                msgpack.unpackb(msgpack.packb(wire, use_bin_type=True), raw=False)
            )
            assert server_task.options == expected
            assert server_task.options == expected
    finally:
        server.frontend.close()
        server.ctx.term()
