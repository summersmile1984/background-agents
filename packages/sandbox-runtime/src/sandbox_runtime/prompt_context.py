"""Atomic prompt identity shared with runtime-owned sandbox commands."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .constants import PROMPT_CONTEXT_FILE_PATH

PROMPT_CONTEXT_PATH = Path(PROMPT_CONTEXT_FILE_PATH)


@dataclass(frozen=True)
class PromptContext:
    session_id: str
    message_id: str
    sandbox_id: str


def write_prompt_context(context: PromptContext, path: Path = PROMPT_CONTEXT_PATH) -> None:
    """Replace the current prompt file atomically with owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "sessionId": context.session_id,
        "messageId": context.message_id,
        "sandboxId": context.sandbox_id,
        "generatedAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        temporary_path.chmod(0o600)
        json.dump(payload, temporary, separators=(",", ":"))
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def clear_prompt_context(
    path: Path = PROMPT_CONTEXT_PATH,
    *,
    expected_message_id: str | None = None,
) -> None:
    """Remove the active context without erasing a newer overlapping prompt."""
    if expected_message_id is not None:
        try:
            current = read_prompt_context(path)
        except FileNotFoundError:
            return
        if current.message_id != expected_message_id:
            return
    path.unlink(missing_ok=True)


def read_prompt_context(path: Path = PROMPT_CONTEXT_PATH) -> PromptContext:
    """Read prompt identity while rejecting stale or unsafe filesystem entries."""
    metadata = path.lstat()
    if path.is_symlink() or not path.is_file():
        raise ValueError("prompt context must be a regular file")
    if metadata.st_uid != os.geteuid():
        raise ValueError("prompt context owner does not match the runtime user")
    if metadata.st_mode & 0o022:
        raise ValueError("prompt context must not be group/world writable")
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("unsupported prompt context version")
    session_id = payload.get("sessionId")
    message_id = payload.get("messageId")
    sandbox_id = payload.get("sandboxId")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("prompt context identity is incomplete")
    if not isinstance(message_id, str) or not message_id:
        raise ValueError("prompt context identity is incomplete")
    if not isinstance(sandbox_id, str) or not sandbox_id:
        raise ValueError("prompt context identity is incomplete")
    return PromptContext(
        session_id=session_id,
        message_id=message_id,
        sandbox_id=sandbox_id,
    )
