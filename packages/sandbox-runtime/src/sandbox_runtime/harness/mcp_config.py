"""Translate the control plane's provider-neutral MCP entries for native harnesses."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

BUILTIN_MCP_NAME = "open_inspect"
BUILTIN_MCP_COMMAND = ["python", "-m", "sandbox_runtime.native_mcp"]
AIO_BROWSER_MCP_NAME = "aio_browser"
AIO_BROWSER_MCP_URL_ENV_VAR = "AIO_BROWSER_MCP_URL"
CODEWHALE_MCP_ENV_PREFIX = [
    "env",
    "-u",
    "DEEPSEEK_API_KEY",
    "-u",
    "CODEWHALE_HOME",
    "-u",
    "CODEWHALE_MCP_CONFIG",
]


def load_session_mcp_servers(environment: Mapping[str, str]) -> tuple[Mapping[str, Any], ...]:
    try:
        session_config = json.loads(environment.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return ()
    if not isinstance(session_config, dict):
        return ()
    servers = session_config.get("mcp_servers")
    if not isinstance(servers, list):
        return ()
    return tuple(server for server in servers if isinstance(server, dict))


def codex_mcp_config(
    servers: Sequence[Mapping[str, Any]],
    builtin_environment: Mapping[str, str] | None = None,
    runtime_environment: Mapping[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    config = {
        BUILTIN_MCP_NAME: _codex_local(
            BUILTIN_MCP_COMMAND,
            _string_map(builtin_environment),
        )
    }
    if url := aio_browser_mcp_url(runtime_environment):
        config[AIO_BROWSER_MCP_NAME] = {"url": url}
    for index, server in enumerate(servers):
        if server.get("enabled") is False:
            continue
        name = _unique_name(server, index, config)
        if server.get("type") == "remote":
            url = server.get("url")
            if not isinstance(url, str) or not url:
                continue
            entry: dict[str, Any] = {"url": url}
            headers = _string_map(server.get("headers") or server.get("env"))
            if headers:
                entry["http_headers"] = headers
            config[name] = entry
            continue
        command = _command(server.get("command"))
        if command:
            config[name] = _codex_local(command, _string_map(server.get("env")))
    return config


def claude_mcp_config(
    servers: Sequence[Mapping[str, Any]],
    runtime_environment: Mapping[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    config = {
        BUILTIN_MCP_NAME: {
            "type": "stdio",
            "command": BUILTIN_MCP_COMMAND[0],
            "args": BUILTIN_MCP_COMMAND[1:],
        }
    }
    if url := aio_browser_mcp_url(runtime_environment):
        config[AIO_BROWSER_MCP_NAME] = {"type": "http", "url": url}
    for index, server in enumerate(servers):
        if server.get("enabled") is False:
            continue
        name = _unique_name(server, index, config)
        if server.get("type") == "remote":
            url = server.get("url")
            if not isinstance(url, str) or not url:
                continue
            entry: dict[str, Any] = {"type": "http", "url": url}
            headers = _string_map(server.get("headers") or server.get("env"))
            if headers:
                entry["headers"] = headers
            config[name] = entry
            continue
        command = _command(server.get("command"))
        if not command:
            continue
        entry = {"type": "stdio", "command": command[0], "args": command[1:]}
        env = _string_map(server.get("env"))
        if env:
            entry["env"] = env
        config[name] = entry
    return config


def codewhale_mcp_config(
    servers: Sequence[Mapping[str, Any]],
    runtime_environment: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Build CodeWhale's ~/.codewhale/mcp.json document."""
    config: dict[str, dict[str, Any]] = {
        BUILTIN_MCP_NAME: _codewhale_local(BUILTIN_MCP_COMMAND, {})
    }
    if url := aio_browser_mcp_url(runtime_environment):
        config[AIO_BROWSER_MCP_NAME] = {"url": url}
    for index, server in enumerate(servers):
        if server.get("enabled") is False:
            continue
        name = _unique_name(server, index, config)
        if server.get("type") == "remote":
            url = server.get("url")
            if not isinstance(url, str) or not url:
                continue
            entry: dict[str, Any] = {"url": url}
            headers = _string_map(server.get("headers") or server.get("env"))
            if headers:
                entry["headers"] = headers
            config[name] = entry
            continue
        command = _command(server.get("command"))
        if not command:
            continue
        env = _string_map(server.get("env"))
        config[name] = _codewhale_local(command, env)
    return {"servers": config}


def aio_browser_mcp_url(environment: Mapping[str, str] | None) -> str | None:
    """Return only the runtime-owned loopback AIO MCP endpoint."""
    if not environment:
        return None
    value = environment.get(AIO_BROWSER_MCP_URL_ENV_VAR, "").strip()
    if not value:
        return None
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/mcp"
        or parsed.query
        or parsed.fragment
    ):
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    return value if port is not None else None


def _codewhale_local(command: list[str], environment: dict[str, str]) -> dict[str, Any]:
    sanitized = [*CODEWHALE_MCP_ENV_PREFIX, *command]
    entry: dict[str, Any] = {"command": sanitized[0], "args": sanitized[1:]}
    if environment:
        entry["env"] = environment
    return entry


def _codex_local(command: list[str], env: dict[str, str]) -> dict[str, Any]:
    entry: dict[str, Any] = {"command": command[0], "args": command[1:]}
    if env:
        entry["env"] = env
    return entry


def _command(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _string_map(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): item
        for key, item in value.items()
        if isinstance(key, str) and isinstance(item, str)
    }


def _unique_name(server: Mapping[str, Any], index: int, config: Mapping[str, object]) -> str:
    raw_name = str(server.get("name") or server.get("id") or f"server_{index + 1}")
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", raw_name).strip("_") or f"server_{index + 1}"
    name = base
    suffix = 2
    while name in config:
        name = f"{base}_{suffix}"
        suffix += 1
    return name
