from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


REASONING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

USAGE = (
    "Usage: anthropic:<model>, openai:<model>, google:<model>, "
    "xai:<model>, deepseek:<model>, meta:<model>, kimi:<model>, "
    "zai:<model>, openrouter:<model>, cerebras:<model>, "
    "compat:<base_url>:<model>, or random"
)

COMPAT_BASE_URLS = {
    "xai": "https://api.x.ai/v1",
    "deepseek": "https://api.deepseek.com",
    "meta": "https://api.meta.ai/v1",
    "kimi": "https://api.moonshot.ai/v1",
    "zai": "https://api.z.ai/api/paas/v4",
    "openrouter": "https://openrouter.ai/api/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}

_COMPAT_ENV_KEYS = {
    provider: f"{provider.upper()}_API_KEY" for provider in COMPAT_BASE_URLS
}
_COMPAT_ENV_KEYS["meta"] = "META_MODEL_API_KEY"
_COMPAT_ENV_KEYS["kimi"] = "MOONSHOT_API_KEY"


@dataclass(frozen=True)
class ProviderSpec:
    provider: str
    model: str
    base_url: str | None = None


def parse_spec(value: str) -> ProviderSpec:
    if value == "random":
        return ProviderSpec(provider="random", model="random")

    for provider in ("anthropic", "openai", "google"):
        prefix = f"{provider}:"
        if value.startswith(prefix) and value[len(prefix) :]:
            return ProviderSpec(provider=provider, model=value[len(prefix) :])

    for provider, base_url in COMPAT_BASE_URLS.items():
        prefix = f"{provider}:"
        if value.startswith(prefix) and value[len(prefix) :]:
            return ProviderSpec(provider=provider, model=value[len(prefix) :], base_url=base_url)

    if value.startswith("compat:"):
        rest = value.removeprefix("compat:")
        base_url, separator, model = rest.rpartition(":")
        if separator and base_url and model and "://" in base_url:
            return ProviderSpec(provider="compat", model=model, base_url=base_url)

    raise ValueError(USAGE)


def reasoning_levels(spec: ProviderSpec) -> tuple[str, ...]:
    provider = spec.provider
    model = spec.model.lower()

    if provider == "meta" and "muse-spark" in model:
        return ("off", "minimal", "low", "medium", "high", "xhigh")
    if provider == "anthropic":
        opus = re.search(r"opus-(\d+)[.-](\d+)", model)
        sonnet = re.search(r"sonnet-(\d+)", model)
        if (opus and (int(opus.group(1)), int(opus.group(2))) >= (4, 7)) or (
            sonnet and int(sonnet.group(1)) >= 5
        ) or "fable-5" in model:
            return ("low", "medium", "high", "xhigh", "max")
        if any(name in model for name in ("opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6")):
            return ("low", "medium", "high", "max")
        return ()
    if provider == "openai":
        return _openai_reasoning_levels(model)
    if provider == "google":
        if "gemini-3" in model:
            if "flash-image" in model:
                return ("minimal", "high")
            if "pro-image" in model:
                return ("high",)
            if "flash" in model:
                return ("minimal", "low", "medium", "high")
            minor = re.search(r"gemini-3\.(\d+)", model)
            return ("low", "medium", "high") if minor and int(minor.group(1)) >= 1 else ("low", "high")
        if "gemini-2.5" in model:
            return ("high", "max")
        return ()
    if provider == "xai":
        if "grok-4.3" in model:
            return ("off", "low", "medium", "high")
        if "grok-4" in model:
            return ("low", "medium", "high")
        if "grok-3-mini" in model:
            return ("low", "high")
        return ()
    if provider == "deepseek" and "deepseek" in model:
        return ("off", "high", "max")
    if provider == "cerebras":
        if "gpt-oss" in model:
            return ("low", "medium", "high")
        if "glm" in model:
            return ("off",)
    if provider == "compat":
        return REASONING_LEVELS
    return ()


def _openai_reasoning_levels(model: str) -> tuple[str, ...]:
    if "deep-research" in model:
        return ("medium",)
    if not re.search(r"(?:^|/)gpt-5(?:[.-]|$)", model):
        return ("low", "medium", "high") if re.search(r"(?:^|/)(?:o1|o3|o4)(?:[.-]|$)", model) else ()
    version_match = re.search(r"(?:^|/)gpt-5[.-](\d+)(?:[.-]|$)", model)
    version = int(version_match.group(1)) if version_match else None
    if "-chat" in model:
        return ("medium",) if version is not None else ()
    if re.search(r"(?:^|/)gpt-5[.-]?pro(?:[.-]|$)", model):
        return ("high",)
    if re.search(r"(?:^|/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)", model):
        return ("medium", "high", "xhigh")
    if "codex" in model:
        if version is not None and version >= 3:
            return ("off", "low", "medium", "high", "xhigh")
        if "codex-max" in model or (version is not None and version >= 2):
            return ("low", "medium", "high", "xhigh")
        return ("low", "medium", "high")
    if version == 1:
        return ("off", "low", "medium", "high")
    if version is not None and version >= 6:
        return ("low", "medium", "high", "xhigh", "max")
    if version is not None and version >= 2:
        return ("off", "low", "medium", "high", "xhigh")
    return ("minimal", "low", "medium", "high")


def validate_reasoning(spec: ProviderSpec, level: str | None) -> None:
    if level is None or spec.provider == "random":
        return
    supported = reasoning_levels(spec)
    if level not in supported:
        detail = ", ".join(supported) if supported else "no configurable levels"
        raise ValueError(f"{spec.provider}:{spec.model} does not support reasoning={level}; supported: {detail}")


class Provider(ABC):
    @abstractmethod
    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int = 1200,
        temperature: float = 0.6,
        timeout: float | None = None,
    ) -> tuple[str, dict[str, int]]:
        raise NotImplementedError


class AnthropicProvider(Provider):
    def __init__(self, model: str, api_key: str | None = None, reasoning: str | None = None) -> None:
        self.model = model
        self._api_key = api_key
        self.reasoning = reasoning
        self._client: Any | None = None
        self._supports_temperature = True

    def _get_client(self) -> Any:
        if self._client is None:
            api_key = self._api_key or os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise RuntimeError("Missing ANTHROPIC_API_KEY")
            import anthropic

            self._client = anthropic.Anthropic(api_key=api_key, max_retries=0, timeout=120.0)
        return self._client

    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int = 1200,
        temperature: float = 0.6,
        timeout: float | None = None,
    ) -> tuple[str, dict[str, int]]:
        import anthropic

        params: dict[str, Any] = {
            "model": self.model,
            "system": system,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": user}],
        }
        if self.reasoning is None:
            if self._supports_temperature:
                params["temperature"] = temperature
        elif self.reasoning == "off":
            if self._supports_temperature:
                params["temperature"] = temperature
            params["thinking"] = {"type": "disabled"}
        else:
            params["thinking"] = {"type": "adaptive"}
            params["output_config"] = {"effort": self.reasoning}
        while True:
            try:
                response = self._get_client().messages.create(timeout=timeout, **params)
                break
            except anthropic.BadRequestError as exc:
                if "temperature" in str(exc).lower() and "temperature" in params:
                    params.pop("temperature")
                    self._supports_temperature = False
                    continue
                raise

        text = "".join(
            getattr(block, "text", "")
            for block in getattr(response, "content", [])
            if getattr(block, "type", None) == "text" or hasattr(block, "text")
        )
        usage = getattr(response, "usage", None)
        return text, {
            "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
            "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        }


class OpenAIProvider(Provider):
    def __init__(
        self,
        model: str,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        env_key: str | None = None,
        reasoning: str | None = None,
        reasoning_style: str = "openai",
    ) -> None:
        self.model = model
        self.base_url = base_url
        self._api_key = api_key
        self._env_key = env_key
        self.reasoning = reasoning
        self.reasoning_style = reasoning_style
        self._client: Any | None = None
        self._supports_temperature = True
        self._uses_max_completion_tokens = True

    def _get_client(self) -> Any:
        if self._client is None:
            import openai

            env_key = self._env_key or ("OPENAI_API_KEY" if self.base_url is None else "OPENAI_COMPAT_API_KEY")
            api_key = self._api_key or os.environ.get(env_key)
            if not api_key and env_key == "OPENAI_COMPAT_API_KEY":
                api_key = "none"
            if not api_key:
                raise RuntimeError(f"Missing {env_key}")
            self._client = openai.OpenAI(
                base_url=self.base_url,
                api_key=api_key,
                max_retries=0,
                timeout=120.0,
            )
        return self._client

    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int = 1200,
        temperature: float = 0.6,
        timeout: float | None = None,
    ) -> tuple[str, dict[str, int]]:
        import openai

        params: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        params["max_completion_tokens" if self._uses_max_completion_tokens else "max_tokens"] = max_tokens
        if self._supports_temperature:
            params["temperature"] = temperature
        if self.reasoning is not None:
            if self.reasoning_style == "deepseek" and self.reasoning == "off":
                params["extra_body"] = {"thinking": {"type": "disabled"}}
            else:
                params["reasoning_effort"] = "none" if self.reasoning == "off" else self.reasoning
        while True:
            try:
                response = self._get_client().chat.completions.create(timeout=timeout, **params)
                break
            except openai.BadRequestError as exc:
                message = str(exc).lower()
                changed = False
                if "temperature" in message and "temperature" in params:
                    params.pop("temperature")
                    self._supports_temperature = False
                    changed = True
                if "max_completion_tokens" in message and "max_completion_tokens" in params:
                    params["max_tokens"] = params.pop("max_completion_tokens")
                    self._uses_max_completion_tokens = False
                    changed = True
                if not changed:
                    raise

        message = response.choices[0].message if response.choices else None
        content = getattr(message, "content", "") if message is not None else ""
        usage = getattr(response, "usage", None)
        return content or "", {
            "input_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "output_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
        }


class GoogleProvider(Provider):
    def __init__(self, model: str, api_key: str | None = None, reasoning: str | None = None) -> None:
        self.model = model
        self._api_key = api_key
        self.reasoning = reasoning
        self._client: Any | None = None

    def _get_client(self) -> Any:
        if self._client is None:
            api_key = self._api_key or os.environ.get("GEMINI_API_KEY")
            if not api_key:
                raise RuntimeError("Missing GEMINI_API_KEY")
            from google import genai

            self._client = genai.Client(api_key=api_key)
        return self._client

    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int = 1200,
        temperature: float = 0.6,
        timeout: float | None = None,
    ) -> tuple[str, dict[str, int]]:
        from google.genai import types

        config: dict[str, Any] = {
            "system_instruction": system,
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        }
        if timeout is not None:
            config["http_options"] = types.HttpOptions(
                timeout=max(1, int(timeout * 1000)),
                retry_options=types.HttpRetryOptions(attempts=1),
            )
        if self.reasoning == "off":
            config["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        elif self.reasoning is not None and "2.5" in self.model.lower():
            budget = 16_000 if self.reasoning == "high" else _google_thinking_budget_max(self.model.lower())
            config["max_output_tokens"] = max(max_tokens, budget + 1200)
            config["thinking_config"] = types.ThinkingConfig(thinking_budget=budget)
        elif self.reasoning is not None:
            config["thinking_config"] = types.ThinkingConfig(thinking_level=self.reasoning)
        response = self._get_client().models.generate_content(
            model=self.model,
            contents=user,
            config=types.GenerateContentConfig(**config),
        )
        usage = getattr(response, "usage_metadata", None)
        return getattr(response, "text", None) or "", {
            "input_tokens": int(getattr(usage, "prompt_token_count", 0) or 0),
            "output_tokens": int(getattr(usage, "candidates_token_count", 0) or 0),
        }


def _google_thinking_budget_max(model: str) -> int:
    return 32_768 if "2.5" in model and "pro" in model and "flash" not in model else 24_576


def make_provider(
    spec: ProviderSpec,
    api_key: str | None = None,
    reasoning: str | None = None,
) -> Provider:
    validate_reasoning(spec, reasoning)
    if spec.provider == "anthropic":
        return AnthropicProvider(spec.model, api_key=api_key, reasoning=reasoning)
    if spec.provider == "openai":
        return OpenAIProvider(spec.model, api_key=api_key, reasoning=reasoning)
    if spec.provider == "google":
        return GoogleProvider(spec.model, api_key=api_key, reasoning=reasoning)
    if spec.provider == "compat":
        if spec.base_url is None:
            raise ValueError("compat provider requires base_url")
        return OpenAIProvider(spec.model, base_url=spec.base_url, api_key=api_key, reasoning=reasoning)
    if spec.provider in COMPAT_BASE_URLS:
        if spec.base_url is None:
            raise ValueError(f"{spec.provider} provider requires base_url")
        return OpenAIProvider(
            spec.model,
            base_url=spec.base_url,
            api_key=api_key,
            env_key=_COMPAT_ENV_KEYS[spec.provider],
            reasoning=reasoning,
            reasoning_style="deepseek" if spec.provider == "deepseek" else "openai",
        )
    if spec.provider == "random":
        raise ValueError("random provider is handled separately")
    raise ValueError(USAGE)
