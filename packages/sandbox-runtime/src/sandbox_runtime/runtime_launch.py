"""Strict launch-contract validation at the control-plane/sandbox boundary."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, MutableMapping
from typing import Any

from .types import AgentHarness

SUPPORTED_LAUNCH_SPEC_VERSION = 1
SUPPORTED_RESOLVER_VERSIONS = {"1"}
SUPPORTED_CAPABILITY_CATALOG_VERSIONS = {
    "2026-08-21.1",
    "2026-08-21.2",
    "2026-08-21.3",
}
SUPPORTED_ROUTES: dict[str, tuple[AgentHarness, tuple[str, ...] | None]] = {
    "opencode:any:configured-provider": (AgentHarness.OPENCODE, None),
    "opencode:deepseek:host-relay": (AgentHarness.OPENCODE, ("deepseek/",)),
    "codex:openai:subscription": (AgentHarness.CODEX, ("openai/",)),
    "codex:deepseek:host-relay": (AgentHarness.CODEX, ("deepseek/",)),
    "claude:anthropic:setup-token": (AgentHarness.CLAUDE, ("anthropic/",)),
    "claude:deepseek:host-relay": (AgentHarness.CLAUDE, ("deepseek/",)),
    "deepseek:deepseek:host-relay": (AgentHarness.DEEPSEEK, ("deepseek/",)),
}
SUPPORTED_SETTINGS: dict[AgentHarness, dict[str, object]] = {
    AgentHarness.OPENCODE: {"sandboxMode": "isolated-sandbox"},
    AgentHarness.CODEX: {
        "approvalPolicy": "never",
        "sandboxMode": "danger-full-access",
    },
    AgentHarness.CLAUDE: {
        "systemPromptAppend": str,
        "permissionMode": "acceptEdits",
    },
    AgentHarness.DEEPSEEK: {
        "approvalPolicy": "never",
        "shellAccess": True,
        "telemetry": False,
    },
}
_DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def _resolved_value(runtime: Mapping[str, Any], key: str) -> Any:
    wrapped = runtime.get(key)
    if not isinstance(wrapped, Mapping) or "value" not in wrapped:
        raise ValueError(f"launch_spec.runtime.{key}.value is required")
    return wrapped["value"]


def validate_runtime_launch(
    session_config: Mapping[str, Any],
    environment: MutableMapping[str, str],
    *,
    expected_harness: AgentHarness,
) -> None:
    """Fail closed on an unsupported or internally inconsistent LaunchSpec.

    Legacy sessions without a spec remain bootable during migration. Any
    present spec is authoritative and must be supported exactly; the runtime
    never silently drops a route, effort, or setting.
    """

    raw = session_config.get("launch_spec")
    if raw is None:
        return
    if not isinstance(raw, Mapping):
        raise ValueError("launch_spec must be an object")
    if raw.get("version") != SUPPORTED_LAUNCH_SPEC_VERSION:
        raise ValueError(f"unsupported launch_spec version: {raw.get('version')!r}")
    resolver_version = raw.get("resolverVersion")
    if resolver_version not in SUPPORTED_RESOLVER_VERSIONS:
        raise ValueError(f"unsupported runtime resolver version: {resolver_version!r}")
    catalog_version = raw.get("capabilityCatalogVersion")
    if catalog_version not in SUPPORTED_CAPABILITY_CATALOG_VERSIONS:
        raise ValueError(f"unsupported runtime capability catalog: {catalog_version!r}")
    digest = raw.get("draftDigest")
    if not isinstance(digest, str) or not _DIGEST_PATTERN.fullmatch(digest):
        raise ValueError("launch_spec draftDigest must be a SHA-256 digest")

    runtime = raw.get("runtime")
    if not isinstance(runtime, Mapping):
        raise ValueError("launch_spec.runtime must be an object")
    harness = _resolved_value(runtime, "harness")
    route_id = _resolved_value(runtime, "routeId")
    model = _resolved_value(runtime, "model")
    effort = _resolved_value(runtime, "effort")
    if harness != expected_harness.value:
        raise ValueError(
            f"launch_spec harness {harness!r} does not match session harness {expected_harness.value!r}"
        )
    route = SUPPORTED_ROUTES.get(route_id) if isinstance(route_id, str) else None
    if route is None:
        raise ValueError(f"unsupported runtime route: {route_id!r}")
    route_harness, model_prefixes = route
    if route_harness != expected_harness:
        raise ValueError(f"runtime route {route_id!r} is not valid for {expected_harness.value}")
    if not isinstance(model, str) or not model:
        raise ValueError("launch_spec runtime model must be non-empty")
    if model_prefixes and not model.startswith(model_prefixes):
        raise ValueError(f"model {model!r} is not valid for runtime route {route_id!r}")
    configured_model = session_config.get("model")
    if configured_model != model:
        raise ValueError(
            f"launch_spec model {model!r} does not match session model {configured_model!r}"
        )
    if effort is not None and not isinstance(effort, str):
        raise ValueError("launch_spec runtime effort must be a string or null")
    raw_settings = runtime.get("settings")
    if not isinstance(raw_settings, Mapping):
        raise ValueError("launch_spec runtime settings must be an object")

    supported_settings = SUPPORTED_SETTINGS[expected_harness]
    if set(raw_settings) != set(supported_settings):
        raise ValueError(
            f"runtime settings do not match the {expected_harness.value} settings schema"
        )
    settings: dict[str, object] = {}
    for key, constraint in supported_settings.items():
        wrapped = raw_settings[key]
        if not isinstance(wrapped, Mapping) or "value" not in wrapped:
            raise ValueError(f"launch_spec.runtime.settings.{key}.value is required")
        value = wrapped["value"]
        if constraint is str:
            if not isinstance(value, str) or len(value) > 8000:
                raise ValueError(
                    f"runtime setting {key} must be a string of at most 8000 characters"
                )
        elif value != constraint:
            raise ValueError(f"runtime setting {key} violates the packaged platform policy")
        settings[key] = value

    environment["OI_RUNTIME_ROUTE_ID"] = route_id
    environment["OI_RUNTIME_LAUNCH_DIGEST"] = digest
    environment["OI_RUNTIME_MODEL"] = model
    if effort:
        environment["OI_RUNTIME_EFFORT"] = effort
    else:
        environment.pop("OI_RUNTIME_EFFORT", None)
    native_effort = runtime.get("nativeEffort")
    if native_effort is not None:
        if not isinstance(native_effort, str) or not native_effort:
            raise ValueError("launch_spec nativeEffort must be a non-empty string or null")
        environment["OI_RUNTIME_NATIVE_EFFORT"] = native_effort
    else:
        environment.pop("OI_RUNTIME_NATIVE_EFFORT", None)
    environment["OI_RUNTIME_SETTINGS_JSON"] = json.dumps(settings, separators=(",", ":"))
    if expected_harness == AgentHarness.CLAUDE:
        appended = settings["systemPromptAppend"]
        if isinstance(appended, str) and appended:
            environment["OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND"] = appended
        else:
            environment.pop("OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND", None)
