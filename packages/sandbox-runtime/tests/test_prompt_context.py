from pathlib import Path

import pytest

from sandbox_runtime.prompt_context import (
    PromptContext,
    clear_prompt_context,
    read_prompt_context,
    write_prompt_context,
)


def test_prompt_context_round_trip_is_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "prompt.json"
    context = PromptContext(
        session_id="session-1",
        message_id="message-1",
        sandbox_id="sandbox-1",
    )

    write_prompt_context(context, path)

    assert read_prompt_context(path) == context
    assert path.stat().st_mode & 0o777 == 0o600
    clear_prompt_context(path)
    assert not path.exists()


def test_clear_prompt_context_does_not_remove_a_newer_prompt(tmp_path: Path) -> None:
    path = tmp_path / "prompt.json"
    write_prompt_context(PromptContext("session-1", "message-new", "sandbox-1"), path)

    clear_prompt_context(path, expected_message_id="message-old")

    assert read_prompt_context(path).message_id == "message-new"


def test_prompt_context_rejects_writable_file(tmp_path: Path) -> None:
    path = tmp_path / "prompt.json"
    write_prompt_context(
        PromptContext("session-1", "message-1", "sandbox-1"),
        path,
    )
    path.chmod(0o622)

    with pytest.raises(ValueError, match="group/world writable"):
        read_prompt_context(path)


def test_prompt_context_rejects_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    write_prompt_context(
        PromptContext("session-1", "message-1", "sandbox-1"),
        target,
    )
    link = tmp_path / "link.json"
    link.symlink_to(target)

    with pytest.raises(ValueError, match="regular file"):
        read_prompt_context(link)
