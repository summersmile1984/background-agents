"""Integration coverage for the deterministic repository visual fixture."""

from __future__ import annotations

import json
import shutil
import socket
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from sandbox_runtime import dev_services
from sandbox_runtime.dev_services import DevServiceManager
from sandbox_runtime.environment_manifest import load_environment_manifest
from sandbox_runtime.verification_manifest import load_verification_manifest

FIXTURE = Path(__file__).parent / "fixtures" / "visual-app"


class Log:
    def info(self, *_args: object, **_kwargs: object) -> None:
        return

    def warn(self, *_args: object, **_kwargs: object) -> None:
        return


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_fixture_manifests_are_strict_and_cover_responsive_loading_states() -> None:
    environment = load_environment_manifest(FIXTURE / ".openinspect" / "environment.yaml")
    verification = load_verification_manifest(FIXTURE / ".openinspect" / "verification.yaml")

    assert environment.services.processes[0].name == "web"
    assert [scenario.id for scenario in verification.scenarios] == [
        "home-desktop",
        "home-mobile",
        "loaded-state",
    ]
    assert verification.scenarios[0].viewport.width == 1440
    assert verification.scenarios[1].viewport.width == 390
    assert verification.scenarios[1].capture == "full_page"


@pytest.mark.asyncio
async def test_supervisor_starts_fixture_and_writes_trusted_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = tmp_path / "visual-app"
    shutil.copytree(FIXTURE, repository)
    port = free_port()
    manifest_path = repository / ".openinspect" / "environment.yaml"
    manifest_path.write_text(manifest_path.read_text().replace("4173", str(port)))
    metadata_path = tmp_path / "services.json"
    monkeypatch.setattr(dev_services, "DEV_SERVICE_METADATA_PATH", metadata_path)
    monkeypatch.setenv("OPENINSPECT_SERVICE_WEB_PORT", "")
    monkeypatch.setenv("OPENINSPECT_SERVICE_WEB_URL", "")
    warnings: list[tuple[str, str]] = []
    manager = DevServiceManager(
        sandbox_id="sandbox-fixture",
        workspace_path=tmp_path,
        log=Log(),
        warn=lambda scope, message: warnings.append((scope, message)),
    )

    try:
        assert await manager.start((SimpleNamespace(path=repository),), repository) is True
        assert warnings == []
        metadata = json.loads(metadata_path.read_text())
        assert metadata["version"] == 1
        assert metadata["sandboxId"] == "sandbox-fixture"
        assert metadata["services"][0]["primaryUrl"] == f"http://127.0.0.1:{port}"
        async with httpx.AsyncClient(trust_env=False) as client:
            home = await client.get(f"http://127.0.0.1:{port}/")
            loading = await client.get(f"http://127.0.0.1:{port}/loading")
            responsive = await client.get(f"http://127.0.0.1:{port}/responsive")
            failure = await client.get(f"http://127.0.0.1:{port}/failure")
        assert home.status_code == 200 and 'data-testid="app-ready"' in home.text
        assert loading.status_code == 200 and "setTimeout" in loading.text
        assert responsive.status_code == 200 and "responsive-grid" in responsive.text
        assert failure.status_code == 500 and "Intentional failure state" in failure.text
    finally:
        await manager.stop()

    assert not metadata_path.exists()
