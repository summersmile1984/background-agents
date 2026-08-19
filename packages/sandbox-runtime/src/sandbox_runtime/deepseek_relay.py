"""Resolve the session-scoped Host relay endpoints for DeepSeek traffic."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING
from urllib.parse import quote, urlsplit, urlunsplit

if TYPE_CHECKING:
    from collections.abc import Mapping

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_RELAY_URL_ENVS = ("DEEPSEEK_RELAY_BASE_URL", "CODEX_OPENAI_BASE_URL")


def session_model(environment: Mapping[str, str]) -> str:
    try:
        config = json.loads(environment.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return ""
    if not isinstance(config, dict):
        return ""
    return str(config.get("model") or "")


def uses_deepseek_model(environment: Mapping[str, str]) -> bool:
    model = session_model(environment)
    return model.startswith("deepseek/") or model.startswith("deepseek-")


def deepseek_relay_url(environment: Mapping[str, str], protocol: str) -> str | None:
    """Return an OpenAI- or Anthropic-shaped URL scoped to this sandbox session."""
    if protocol not in {"openai", "anthropic"}:
        raise ValueError("DeepSeek relay protocol must be openai or anthropic")
    raw_url = ""
    for name in _RELAY_URL_ENVS:
        candidate = environment.get(name, "").strip()
        if candidate:
            raw_url = candidate
            break
    if not raw_url:
        return None
    parsed = urlsplit(raw_url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "DeepSeek relay base URL must be HTTPS without userinfo, query, or fragment"
        )

    try:
        config = json.loads(environment.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError as error:
        raise ValueError("SESSION_CONFIG is invalid") from error
    session_id = str(config.get("session_id") or "") if isinstance(config, dict) else ""
    if not _SESSION_ID_RE.fullmatch(session_id):
        raise ValueError("SESSION_CONFIG contains an invalid session_id")

    base_path = parsed.path.rstrip("/")
    path = f"{base_path}/sessions/{quote(session_id, safe='')}/deepseek/{protocol}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
