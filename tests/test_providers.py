import pytest

from vgcbench.providers import make_provider, parse_spec, reasoning_levels, validate_reasoning


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
