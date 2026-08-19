import json

import pytest

from sandbox_runtime.deepseek_relay import (
    deepseek_relay_url,
    session_model,
    uses_deepseek_model,
)


def _environment(model: str = "deepseek/deepseek-v4-flash") -> dict[str, str]:
    return {
        "CODEX_OPENAI_BASE_URL": "https://relay.example.test/root/",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1", "model": model}),
    }


def test_resolves_session_scoped_protocol_urls():
    environment = _environment()

    assert deepseek_relay_url(environment, "openai") == (
        "https://relay.example.test/root/sessions/session-1/deepseek/openai"
    )
    assert deepseek_relay_url(environment, "anthropic") == (
        "https://relay.example.test/root/sessions/session-1/deepseek/anthropic"
    )


def test_dedicated_relay_url_takes_precedence():
    environment = _environment()
    environment["DEEPSEEK_RELAY_BASE_URL"] = "https://models.example.test"

    assert deepseek_relay_url(environment, "openai") == (
        "https://models.example.test/sessions/session-1/deepseek/openai"
    )


def test_rejects_unsafe_session_and_relay_values():
    environment = _environment()
    environment["SESSION_CONFIG"] = '{"session_id":"../other","model":"deepseek-v4-flash"}'
    with pytest.raises(ValueError, match="session_id"):
        deepseek_relay_url(environment, "openai")

    environment = _environment()
    environment["CODEX_OPENAI_BASE_URL"] = "http://relay.example.test"
    with pytest.raises(ValueError, match="HTTPS"):
        deepseek_relay_url(environment, "openai")


def test_reads_the_selected_session_model():
    environment = _environment("deepseek/deepseek-v4-flash")
    assert session_model(environment) == "deepseek/deepseek-v4-flash"
    assert uses_deepseek_model(environment) is True
    assert uses_deepseek_model(_environment("openai/gpt-5.4")) is False
