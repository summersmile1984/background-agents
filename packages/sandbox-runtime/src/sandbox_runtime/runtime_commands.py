"""Install standalone sandbox runtime commands for every agent harness."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .constants import BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR

RUNTIME_COMMANDS_SOURCE_DIR = Path("/app/sandbox_runtime/bin")


def install_runtime_commands(
    source_dir: Path = RUNTIME_COMMANDS_SOURCE_DIR,
    install_dir: Path | None = None,
) -> set[str]:
    """Copy checked-in standalone CLIs to the configured executable directory.

    Installation belongs to sandbox startup rather than any particular agent
    harness.  Native Codex, Claude, and DeepSeek sessions need the same media
    upload and signing commands that OpenCode sessions receive.
    """
    if not source_dir.is_dir():
        return set()

    destination = install_dir or Path(
        os.environ.get(BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR)
    )
    destination.mkdir(parents=True, exist_ok=True)

    installed: set[str] = set()
    for script in source_dir.iterdir():
        if not script.is_file() or script.suffix not in {"", ".js"}:
            continue
        command_name = script.stem if script.suffix == ".js" else script.name
        target = destination / command_name
        # Some providers (notably E2B) run the supervisor as a non-root user,
        # so their image builder installs these commands into /usr/local/bin.
        # Treat an identical executable as already installed instead of trying
        # to overwrite the root-owned file at session startup.
        if (
            target.is_file()
            and os.access(target, os.X_OK)
            and target.read_bytes() == script.read_bytes()
        ):
            installed.add(command_name)
            continue
        shutil.copy(script, target)
        target.chmod(0o755)
        installed.add(command_name)
    return installed
