from __future__ import annotations

import json

import sandbox_runtime.native_mcp as native_mcp
from sandbox_runtime.harness.mcp_config import (
    claude_mcp_config,
    codewhale_mcp_config,
    codex_mcp_config,
    load_session_mcp_servers,
)


def test_load_session_mcp_servers_and_translate_local_server():
    servers = load_session_mcp_servers(
        {
            "SESSION_CONFIG": json.dumps(
                {
                    "mcp_servers": [
                        {
                            "name": "browser tools",
                            "type": "local",
                            "command": ["npx", "-y", "@playwright/mcp"],
                            "env": {"MODE": "headless"},
                        }
                    ]
                }
            )
        }
    )

    config = claude_mcp_config(servers)

    assert config["open_inspect"]["args"] == ["-m", "sandbox_runtime.native_mcp"]
    assert config["browser_tools"] == {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@playwright/mcp"],
        "env": {"MODE": "headless"},
    }


def test_repository_resolution_preserves_nested_owner(monkeypatch, tmp_path):
    manifest = tmp_path / "repositories.json"
    manifest.write_text(
        json.dumps(
            {
                "repositories": [
                    {
                        "owner": "group/subgroup",
                        "name": "project",
                        "path": "/workspace/project",
                    }
                ]
            }
        )
    )
    monkeypatch.setattr(native_mcp, "REPO_MANIFEST_FILE_PATH", str(manifest))

    assert native_mcp._resolve_repository("GROUP/SUBGROUP/PROJECT") == {
        "owner": "group/subgroup",
        "name": "project",
        "path": "/workspace/project",
    }


def test_codewhale_mcp_config_supports_builtin_local_and_remote_servers():
    config = codewhale_mcp_config(
        (
            {
                "name": "docs search",
                "type": "remote",
                "url": "https://mcp.example.test/mcp",
                "headers": {"X-Key": "secret"},
            },
        )
    )

    assert config["servers"]["open_inspect"] == {
        "command": "env",
        "args": [
            "-u",
            "DEEPSEEK_API_KEY",
            "-u",
            "CODEWHALE_HOME",
            "-u",
            "CODEWHALE_MCP_CONFIG",
            "python",
            "-m",
            "sandbox_runtime.native_mcp",
        ],
    }
    assert config["servers"]["docs_search"] == {
        "url": "https://mcp.example.test/mcp",
        "headers": {"X-Key": "secret"},
    }


def test_codex_builtin_mcp_receives_only_explicit_platform_environment():
    config = codex_mcp_config(
        (
            {
                "name": "user server",
                "type": "local",
                "command": ["user-mcp"],
            },
        ),
        {
            "CONTROL_PLANE_URL": "https://control.example.test",
            "OPEN_INSPECT_SESSION_ID": "session-1",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
        },
    )

    assert config["open_inspect"]["env"] == {
        "CONTROL_PLANE_URL": "https://control.example.test",
        "OPEN_INSPECT_SESSION_ID": "session-1",
        "SANDBOX_AUTH_TOKEN": "sandbox-token",
    }
    assert "env" not in config["user_server"]


def test_session_id_accepts_wire_and_legacy_casing():
    assert native_mcp._session_id('{"session_id":"session-1"}') == "session-1"
    assert native_mcp._session_id('{"sessionId":"session-2"}') == "session-2"


def test_control_plane_client_prefers_minimal_explicit_session_id():
    client = native_mcp.ControlPlaneToolClient(
        {
            "CONTROL_PLANE_URL": "https://control.example.test",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "OPEN_INSPECT_SESSION_ID": "session-explicit",
            "SESSION_CONFIG": '{"session_id":"session-config"}',
        }
    )

    assert client.session_id == "session-explicit"
