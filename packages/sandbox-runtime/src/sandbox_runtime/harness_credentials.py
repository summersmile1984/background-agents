"""Ephemeral materialization of host-encrypted native harness credentials."""

from __future__ import annotations

import base64
import contextlib
import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .deepseek_relay import uses_deepseek_model

if TYPE_CHECKING:
    from collections.abc import MutableMapping

CREDENTIAL_MEMORY_DIR = Path("/dev/shm/open-inspect-credentials")
CLAUDE_TOKEN_FILE = CREDENTIAL_MEMORY_DIR / "claude-setup-token"
SHELL_SANITIZER_FILE = CREDENTIAL_MEMORY_DIR / "sanitize-agent-shell-env.sh"
CODEX_AUTH_PATH = CREDENTIAL_MEMORY_DIR / "codex-home" / "auth.json"
CODEX_AUTH_MARKER = CREDENTIAL_MEMORY_DIR / "codex-auth-materialized"
CLAUDE_TOKEN_FILE_ENV = "OPENINSPECT_CLAUDE_TOKEN_FILE"
CODEX_HOME_ENV = "CODEX_HOME"
EXPIRY_WARNING_SECONDS = 30 * 24 * 60 * 60

SENSITIVE_HARNESS_ENV_KEYS = {
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT",
    "CODEX_AUTH_JSON",
    "CODEX_ACCESS_TOKEN",
    "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    "DEEPSEEK_API_KEY",
}
IMAGE_BUILD_SENSITIVE_KEYS = SENSITIVE_HARNESS_ENV_KEYS


def materialize_harness_credentials(
    environment: MutableMapping[str, str],
    log: Any,
    warn: Any,
    agent_harness: object | None = None,
) -> None:
    """Move secret values out of the supervisor environment before services start."""
    if environment.get("IMAGE_BUILD_MODE") == "true":
        for key in IMAGE_BUILD_SENSITIVE_KEYS:
            environment.pop(key, None)
        return

    selected_harness = getattr(agent_harness, "value", agent_harness)
    if uses_deepseek_model(environment):
        for key in SENSITIVE_HARNESS_ENV_KEYS:
            environment.pop(key, None)
        return
    if selected_harness:
        allowed_prefix = {
            "claude": "CLAUDE_",
            "codex": "CODEX_",
        }.get(str(selected_harness))
        for key in SENSITIVE_HARNESS_ENV_KEYS:
            if allowed_prefix is None or not key.startswith(allowed_prefix):
                environment.pop(key, None)
        if allowed_prefix is None:
            return

    CREDENTIAL_MEMORY_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    claude_token = environment.pop("CLAUDE_CODE_OAUTH_TOKEN", "").strip()
    claude_expires_at = environment.pop("CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT", None)
    if claude_token:
        _write_secret(CLAUDE_TOKEN_FILE, claude_token)
        environment[CLAUDE_TOKEN_FILE_ENV] = str(CLAUDE_TOKEN_FILE)
        _write_shell_sanitizer()
        environment["BASH_ENV"] = str(SHELL_SANITIZER_FILE)
        _warn_for_expiry(claude_expires_at, "Claude Code setup-token", warn)

    raw_codex_auth = environment.pop("CODEX_AUTH_JSON", "").strip()
    codex_access_token = environment.pop("CODEX_ACCESS_TOKEN", "").strip()
    codex_expires_at = environment.pop("CODEX_ACCESS_TOKEN_EXPIRES_AT", None)
    if raw_codex_auth:
        try:
            auth = _decode_codex_auth(raw_codex_auth)
            _prepare_codex_auth_directory()
            environment[CODEX_HOME_ENV] = str(CODEX_AUTH_PATH.parent)
            _write_secret(CODEX_AUTH_PATH, json.dumps(auth, separators=(",", ":")))
            _write_secret(CODEX_AUTH_MARKER, "managed")
            log.info("harness.credentials_materialized", harness="codex", source="auth_json")
        except (OSError, ValueError) as error:
            warn("harness", f"Codex auth.json could not be loaded: {error}")
    elif codex_access_token:
        try:
            _prepare_codex_auth_directory()
            environment[CODEX_HOME_ENV] = str(CODEX_AUTH_PATH.parent)
            subprocess.run(
                ["codex", "login", "--with-access-token"],
                input=codex_access_token,
                text=True,
                env=environment,
                capture_output=True,
                check=True,
                timeout=60,
            )
            _write_secret(CODEX_AUTH_MARKER, "managed")
            log.info("harness.credentials_materialized", harness="codex", source="access_token")
        except (OSError, subprocess.SubprocessError) as error:
            warn("harness", f"Codex access token could not be loaded: {error}")
    if raw_codex_auth or codex_access_token:
        _warn_for_expiry(codex_expires_at, "Codex credential", warn)


def remove_snapshot_credentials() -> None:
    """Delete disk-backed credentials before Modal captures the filesystem."""
    if CODEX_AUTH_MARKER.exists():
        CODEX_AUTH_PATH.unlink(missing_ok=True)
        CODEX_AUTH_MARKER.unlink(missing_ok=True)


def remove_runtime_codex_auth() -> None:
    """Remove the login file after app-server has loaded it, before any prompt can run."""
    if CODEX_AUTH_MARKER.exists():
        CODEX_AUTH_PATH.unlink(missing_ok=True)


def read_claude_token(environment: dict[str, str]) -> str | None:
    path_value = environment.get(CLAUDE_TOKEN_FILE_ENV)
    if not path_value:
        return None
    path = Path(path_value)
    try:
        token = path.read_text().strip()
    except OSError:
        return None
    return token or None


def _decode_codex_auth(value: str) -> dict[str, object]:
    candidates = [value]
    with contextlib.suppress(ValueError, UnicodeDecodeError):
        candidates.append(base64.b64decode(value, validate=True).decode("utf-8"))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed:
            return parsed
    raise ValueError("CODEX_AUTH_JSON must be a JSON object or its base64 encoding")


def _write_secret(path: Path, value: str) -> None:
    path.write_text(value)
    path.chmod(0o600)


def _prepare_codex_auth_directory() -> None:
    CODEX_AUTH_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    CODEX_AUTH_PATH.parent.chmod(0o700)


def _write_shell_sanitizer() -> None:
    _write_secret(
        SHELL_SANITIZER_FILE,
        "unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT "
        "CODEX_ACCESS_TOKEN CODEX_ACCESS_TOKEN_EXPIRES_AT CODEX_AUTH_JSON "
        "DEEPSEEK_API_KEY CODEX_HOME CODEWHALE_HOME CODEWHALE_MCP_CONFIG "
        "DEEPSEEK_MCP_CONFIG "
        "OPENINSPECT_CLAUDE_TOKEN_FILE "
        "SANDBOX_AUTH_TOKEN\n",
    )


def _warn_for_expiry(raw_value: str | None, label: str, warn: Any) -> None:
    if not raw_value:
        return
    try:
        if raw_value.isdigit():
            timestamp = int(raw_value)
            if timestamp > 10_000_000_000:
                timestamp //= 1000
            expires_at = datetime.fromtimestamp(timestamp, tz=UTC)
        else:
            expires_at = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=UTC)
    except (ValueError, OverflowError, OSError):
        warn("harness", f"{label} expiry metadata is invalid; credential was still loaded.")
        return
    remaining_seconds = (expires_at - datetime.now(UTC)).total_seconds()
    if remaining_seconds <= 0:
        warn("harness", f"{label} has expired; rotate it before starting new sessions.")
    elif remaining_seconds <= EXPIRY_WARNING_SECONDS:
        days = max(1, int(remaining_seconds // (24 * 60 * 60)))
        warn("harness", f"{label} expires in about {days} day(s); plan credential rotation.")
