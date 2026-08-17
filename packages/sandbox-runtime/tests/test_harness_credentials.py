from __future__ import annotations

import json
from types import SimpleNamespace
from typing import TYPE_CHECKING

import sandbox_runtime.harness_credentials as credentials

if TYPE_CHECKING:
    from pathlib import Path


class _Log:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def info(self, event: str, **fields: object) -> None:
        self.events.append((event, fields))


def _redirect_paths(monkeypatch, tmp_path: Path) -> None:
    memory_dir = tmp_path / "memory"
    monkeypatch.setattr(credentials, "CREDENTIAL_MEMORY_DIR", memory_dir)
    monkeypatch.setattr(credentials, "CLAUDE_TOKEN_FILE", memory_dir / "claude-token")
    monkeypatch.setattr(credentials, "SHELL_SANITIZER_FILE", memory_dir / "sanitize.sh")
    monkeypatch.setattr(credentials, "CODEX_AUTH_PATH", tmp_path / "home/.codex/auth.json")
    monkeypatch.setattr(credentials, "CODEX_AUTH_MARKER", memory_dir / "codex-marker")


def test_build_mode_drops_harness_credentials_without_materializing(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    environment = {
        "IMAGE_BUILD_MODE": "true",
        "CLAUDE_CODE_OAUTH_TOKEN": "claude-secret",
        "CODEX_AUTH_JSON": '{"tokens":{}}',
        "DATABASE_URL": "postgres://build",
    }

    credentials.materialize_harness_credentials(environment, _Log(), lambda *_: None)

    assert environment == {"IMAGE_BUILD_MODE": "true", "DATABASE_URL": "postgres://build"}
    assert not credentials.CREDENTIAL_MEMORY_DIR.exists()
    assert not credentials.CODEX_AUTH_PATH.exists()


def test_unselected_harness_credentials_are_dropped(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    environment = {
        "CLAUDE_CODE_OAUTH_TOKEN": "claude-secret",
        "CODEX_AUTH_JSON": '{"tokens":{}}',
    }

    credentials.materialize_harness_credentials(environment, _Log(), lambda *_: None, "opencode")

    assert environment == {}
    assert not credentials.CREDENTIAL_MEMORY_DIR.exists()


def test_claude_setup_token_moves_to_memory_and_is_removed_from_parent_env(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    warnings: list[tuple[str, str]] = []
    environment = {
        "CLAUDE_CODE_OAUTH_TOKEN": "setup-token",
        "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT": "2000-01-01T00:00:00Z",
    }

    credentials.materialize_harness_credentials(
        environment, _Log(), lambda scope, message: warnings.append((scope, message))
    )

    assert "CLAUDE_CODE_OAUTH_TOKEN" not in environment
    assert "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT" not in environment
    assert credentials.read_claude_token(environment) == "setup-token"
    assert credentials.CLAUDE_TOKEN_FILE.stat().st_mode & 0o777 == 0o600
    assert environment["BASH_ENV"] == str(credentials.SHELL_SANITIZER_FILE)
    assert warnings == [
        ("harness", "Claude Code setup-token has expired; rotate it before starting new sessions.")
    ]


def test_codex_auth_json_is_materialized_and_removed_before_snapshot(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    environment = {"CODEX_AUTH_JSON": json.dumps({"tokens": {"access_token": "secret"}})}

    credentials.materialize_harness_credentials(environment, _Log(), lambda *_: None)

    assert "CODEX_AUTH_JSON" not in environment
    assert json.loads(credentials.CODEX_AUTH_PATH.read_text()) == {
        "tokens": {"access_token": "secret"}
    }
    assert credentials.CODEX_AUTH_PATH.stat().st_mode & 0o777 == 0o600
    assert credentials.CODEX_AUTH_MARKER.exists()

    credentials.remove_runtime_codex_auth()

    assert not credentials.CODEX_AUTH_PATH.exists()
    assert credentials.CODEX_AUTH_MARKER.exists()

    credentials.remove_snapshot_credentials()

    assert not credentials.CODEX_AUTH_PATH.exists()
    assert not credentials.CODEX_AUTH_MARKER.exists()


def test_invalid_codex_auth_warns_without_failing_boot(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    warnings: list[tuple[str, str]] = []

    credentials.materialize_harness_credentials(
        {"CODEX_AUTH_JSON": "not-json"},
        _Log(),
        lambda scope, message: warnings.append((scope, message)),
    )

    assert warnings[0][0] == "harness"
    assert "could not be loaded" in warnings[0][1]
    assert not credentials.CODEX_AUTH_PATH.exists()


def test_codex_access_token_is_piped_to_login_and_never_left_in_env(monkeypatch, tmp_path):
    _redirect_paths(monkeypatch, tmp_path)
    calls: list[dict[str, object]] = []

    def fake_run(command, **kwargs):
        calls.append({"command": command, **kwargs})
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(credentials.subprocess, "run", fake_run)
    environment = {"PATH": "/usr/bin", "CODEX_ACCESS_TOKEN": "enterprise-token"}

    credentials.materialize_harness_credentials(environment, _Log(), lambda *_: None)

    assert "CODEX_ACCESS_TOKEN" not in environment
    assert calls[0]["command"] == ["codex", "login", "--with-access-token"]
    assert calls[0]["input"] == "enterprise-token"
    assert "CODEX_ACCESS_TOKEN" not in calls[0]["env"]
    assert credentials.CODEX_AUTH_MARKER.exists()
