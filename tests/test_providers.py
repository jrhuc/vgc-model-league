import pytest

from vgcbench.providers import (
    Completion,
    ToolCall,
    _anthropic_tools,
    _openai_tools,
    assistant_tool_message,
    make_provider,
    parse_spec,
    reasoning_levels,
    tool_result_message,
    validate_reasoning,
)
from vgcbench.reference import DEX_TOOLS


def test_meta_muse_uses_the_meta_model_api():
    spec = parse_spec("meta:muse-spark-1.1")
    assert spec.base_url == "https://api.meta.ai/v1"
    assert reasoning_levels(spec) == ("off", "minimal", "low", "medium", "high", "xhigh")
    provider = make_provider(spec, api_key="test", reasoning="medium")
    assert provider.reasoning == "medium"
    assert provider._env_key == "META_MODEL_API_KEY"


def test_human_is_not_advertised_without_an_engine():
    with pytest.raises(ValueError, match="Usage"):
        parse_spec("human")


def test_reasoning_level_is_validated_per_model_family():
    spec = parse_spec("meta:muse-spark-1.1")
    validate_reasoning(spec, "xhigh")
    with pytest.raises(ValueError, match="reasoning=max"):
        validate_reasoning(spec, "max")


def test_openai_and_anthropic_tool_adapters_preserve_schema():
    openai_tools = _openai_tools(DEX_TOOLS)
    assert openai_tools[0]["type"] == "function"
    assert openai_tools[0]["function"]["name"] == "lookup_species"
    assert openai_tools[0]["function"]["strict"] is True
    assert openai_tools[0]["function"]["parameters"]["additionalProperties"] is False

    anthropic_tools = _anthropic_tools(DEX_TOOLS)
    assert anthropic_tools[0]["name"] == "lookup_species"
    assert anthropic_tools[0]["input_schema"]["required"] == ["name", "item", "nature", "level"]


def test_shared_tool_message_helpers_use_openai_wire_format():
    completion = Completion(
        text="checking",
        usage={},
        tool_calls=[ToolCall(id="call_1", name="lookup_move", arguments={"name": "Protect"})],
    )
    assert assistant_tool_message(completion) == {
        "role": "assistant",
        "content": "checking",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "lookup_move", "arguments": '{"name": "Protect"}'},
            }
        ],
    }
    assert tool_result_message("call_1", "Protect is a status move") == {
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "Protect is a status move",
    }
