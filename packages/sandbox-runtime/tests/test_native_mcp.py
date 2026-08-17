from __future__ import annotations

import json

import sandbox_runtime.native_mcp as native_mcp
from sandbox_runtime.harness.mcp_config import claude_mcp_config, load_session_mcp_servers


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


def test_session_id_accepts_wire_and_legacy_casing():
    assert native_mcp._session_id('{"session_id":"session-1"}') == "session-1"
    assert native_mcp._session_id('{"sessionId":"session-2"}') == "session-2"
