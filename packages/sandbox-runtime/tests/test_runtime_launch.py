from __future__ import annotations

import copy

import pytest

from sandbox_runtime.runtime_launch import validate_runtime_launch
from sandbox_runtime.types import AgentHarness


def launch_spec() -> dict:
    source = {"scope": "session", "id": None}
    return {
        "version": 1,
        "resolverVersion": "1",
        "capabilityCatalogVersion": "2026-08-21.3",
        "resolvedAt": 1,
        "draftDigest": "a" * 64,
        "target": {
            "kind": "repository",
            "connectionId": "scm-1",
            "provider": "gitea",
            "environmentId": None,
            "repositories": [],
        },
        "runtime": {
            "harness": {"value": "codex", "source": source, "inherited": False},
            "routeId": {
                "value": "codex:openai:subscription",
                "source": source,
                "inherited": False,
            },
            "model": {
                "value": "openai/gpt-5.6-luna",
                "source": source,
                "inherited": False,
            },
            "effort": {"value": "high", "source": source, "inherited": False},
            "nativeEffort": "high",
            "settings": {
                "approvalPolicy": {
                    "value": "never",
                    "source": {"scope": "installation", "id": None},
                    "inherited": True,
                },
                "sandboxMode": {
                    "value": "danger-full-access",
                    "source": {"scope": "installation", "id": None},
                    "inherited": True,
                },
            },
        },
        "skillsManifestId": None,
        "caller": {"channel": "web", "canonicalUserId": "user-1", "integrationId": None},
    }


def test_validates_and_materializes_authoritative_runtime_environment():
    spec = launch_spec()
    environment: dict[str, str] = {}

    validate_runtime_launch(
        {"model": "openai/gpt-5.6-luna", "launch_spec": spec},
        environment,
        expected_harness=AgentHarness.CODEX,
    )

    assert environment["OI_RUNTIME_ROUTE_ID"] == "codex:openai:subscription"
    assert environment["OI_RUNTIME_EFFORT"] == "high"
    assert environment["OI_RUNTIME_LAUNCH_DIGEST"] == "a" * 64


def test_materializes_validated_claude_setting_for_the_native_driver():
    spec = launch_spec()
    spec["runtime"].update(
        {
            "harness": {
                "value": "claude",
                "source": {"scope": "session", "id": None},
                "inherited": False,
            },
            "routeId": {
                "value": "claude:anthropic:setup-token",
                "source": {"scope": "session", "id": None},
                "inherited": False,
            },
            "model": {
                "value": "anthropic/claude-sonnet-5",
                "source": {"scope": "session", "id": None},
                "inherited": False,
            },
            "settings": {
                "systemPromptAppend": {
                    "value": "Follow repository conventions.",
                    "source": {"scope": "repository", "id": "repo-1"},
                    "inherited": True,
                },
                "permissionMode": {
                    "value": "acceptEdits",
                    "source": {"scope": "installation", "id": None},
                    "inherited": True,
                },
            },
        }
    )
    environment: dict[str, str] = {}

    validate_runtime_launch(
        {"model": "anthropic/claude-sonnet-5", "launch_spec": spec},
        environment,
        expected_harness=AgentHarness.CLAUDE,
    )

    assert environment["OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND"] == (
        "Follow repository conventions."
    )


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda spec: spec.update({"capabilityCatalogVersion": "future"}), "catalog"),
        (
            lambda spec: spec["runtime"]["routeId"].update(
                {"value": "claude:anthropic:setup-token"}
            ),
            "not valid for codex",
        ),
        (
            lambda spec: spec["runtime"]["model"].update({"value": "anthropic/claude-sonnet-4-6"}),
            "not valid for runtime route",
        ),
    ],
)
def test_rejects_capability_drift_and_inconsistent_routes(mutation, message):
    spec = copy.deepcopy(launch_spec())
    mutation(spec)

    with pytest.raises(ValueError, match=message):
        validate_runtime_launch(
            {"model": spec["runtime"]["model"]["value"], "launch_spec": spec},
            {},
            expected_harness=AgentHarness.CODEX,
        )


def test_legacy_session_without_launch_spec_remains_bootable_during_migration():
    validate_runtime_launch(
        {"model": "anthropic/claude-haiku-4-5"},
        {},
        expected_harness=AgentHarness.OPENCODE,
    )
