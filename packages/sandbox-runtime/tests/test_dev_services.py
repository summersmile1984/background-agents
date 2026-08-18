import asyncio
import os
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest

from sandbox_runtime.dev_services import DEV_SERVICE_METADATA_PATH, DevServiceManager
from sandbox_runtime.snapshot_coordinator import SnapshotCoordinator


class Log:
    def info(self, *_args, **_kwargs):
        pass

    def warn(self, *_args, **_kwargs):
        pass


def manager(tmp_path: Path) -> DevServiceManager:
    return DevServiceManager(workspace_path=tmp_path, log=Log(), warn=lambda *_args: None)


def test_postgres_command_runs_as_current_user_when_unprivileged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(os, "geteuid", lambda: 1000)

    assert manager(tmp_path)._postgres_command("/usr/bin/postgres", "-D", "/data") == (
        "/usr/bin/postgres",
        "-D",
        "/data",
    )


def test_postgres_command_drops_to_postgres_when_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(os, "geteuid", lambda: 0)

    assert manager(tmp_path)._postgres_command("/usr/bin/postgres", "-D", "/data") == (
        "runuser",
        "-u",
        "postgres",
        "--",
        "/usr/bin/postgres",
        "-D",
        "/data",
    )


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_process_service_starts_and_snapshot_quiesces_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    workspace = tmp_path / "workspace"
    repo = workspace / "repo"
    manifest_dir = repo / ".openinspect"
    manifest_dir.mkdir(parents=True)
    port = free_port()
    marker = repo / "snapshot-ready"
    (manifest_dir / "environment.yaml").write_text(
        f"""
version: 1
services:
  processes:
    - name: web
      command: python3 -m http.server {port} --bind 127.0.0.1
      ports: [{port}]
      snapshot_command: python3 -c "from pathlib import Path; Path('snapshot-ready').write_text('ok')"
"""
    )
    warnings: list[tuple[str, str]] = []
    manager = DevServiceManager(
        workspace_path=workspace,
        log=Log(),
        warn=lambda scope, message: warnings.append((scope, message)),
    )

    try:
        assert await manager.start((SimpleNamespace(path=repo),), repo) is True
        assert warnings == []
        assert os.environ["OPENINSPECT_SERVICE_WEB_PORT"] == str(port)
        assert os.environ["OPENINSPECT_SERVICE_WEB_URL"] == f"http://127.0.0.1:{port}"
        assert DEV_SERVICE_METADATA_PATH.exists()
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.close()
        await writer.wait_closed()
        del reader

        assert await SnapshotCoordinator(Log()).prepare() == []
        assert marker.read_text() == "ok"
        await asyncio.sleep(0.1)
        assert manager._processes[0].process.returncode is not None
    finally:
        await manager.stop()
        monkeypatch.delenv("OPENINSPECT_SERVICE_WEB_PORT", raising=False)
        monkeypatch.delenv("OPENINSPECT_SERVICE_WEB_URL", raising=False)


async def test_invalid_manifest_warns_without_failing_sandbox(tmp_path: Path):
    workspace = tmp_path / "workspace"
    repo = workspace / "repo"
    manifest_dir = repo / ".openinspect"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "environment.yaml").write_text("version: 99\n")
    warnings: list[tuple[str, str]] = []
    manager = DevServiceManager(
        workspace_path=workspace,
        log=Log(),
        warn=lambda scope, message: warnings.append((scope, message)),
    )

    assert await manager.start((SimpleNamespace(path=repo),), repo) is False
    assert warnings[0][0] == "services"
    assert "Invalid" in warnings[0][1]
