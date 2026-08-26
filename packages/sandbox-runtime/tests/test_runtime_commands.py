"""Tests for provider-neutral standalone runtime command installation."""

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from sandbox_runtime.entrypoint import build_supervisor
from sandbox_runtime.runtime_commands import install_runtime_commands


def test_installs_supported_scripts_as_executable_commands(tmp_path: Path) -> None:
    source = tmp_path / "bin"
    source.mkdir()
    (source / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")
    (source / "oi-git-sign").write_text("#!/bin/sh\n# signer launcher")
    destination = tmp_path / "installed"

    installed = install_runtime_commands(source, destination)

    assert installed == {"oi-git-sign", "upload-media"}
    assert (destination / "upload-media").read_text() == ("#!/usr/bin/env node\n// upload cli")
    assert (destination / "upload-media").stat().st_mode & 0o755
    assert (destination / "oi-git-sign").stat().st_mode & 0o755


def test_uses_configured_install_directory(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "bin"
    source.mkdir()
    (source / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")
    destination = tmp_path / "configured-bin"
    monkeypatch.setenv("OPENINSPECT_BIN_INSTALL_DIR", str(destination))

    install_runtime_commands(source)

    assert (destination / "upload-media").exists()


def test_skips_unsupported_files(tmp_path: Path) -> None:
    source = tmp_path / "bin"
    source.mkdir()
    (source / "upload-media.js").write_text("// cli")
    (source / "README.md").write_text("# docs")
    destination = tmp_path / "installed"

    installed = install_runtime_commands(source, destination)

    assert installed == {"upload-media"}
    assert not (destination / "README").exists()


def test_missing_source_is_a_noop(tmp_path: Path) -> None:
    destination = tmp_path / "installed"

    installed = install_runtime_commands(tmp_path / "missing", destination)

    assert installed == set()
    assert not destination.exists()


def test_native_harness_composition_installs_runtime_commands(tmp_path: Path) -> None:
    environment = {
        "CONTROL_PLANE_URL": "https://control.example",
        "HOME": str(tmp_path / "home"),
        "SESSION_CONFIG": json.dumps({"session_id": "session-1", "agent_harness": "codex"}),
    }

    with (
        patch.dict("os.environ", environment, clear=True),
        patch(
            "sandbox_runtime.entrypoint.install_runtime_commands",
            return_value={"upload-media"},
        ) as install,
    ):
        supervisor = build_supervisor(asyncio.Event())

    install.assert_called_once_with()
    assert supervisor.config.agent_harness.value == "codex"
