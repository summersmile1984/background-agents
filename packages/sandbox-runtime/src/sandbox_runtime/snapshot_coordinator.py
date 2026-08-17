"""Quiesce persistent development services before a filesystem snapshot."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
from pathlib import Path
from typing import Any

from .dev_services import DEV_SERVICE_METADATA_PATH
from .environment_manifest import load_environment_manifest
from .harness_credentials import remove_snapshot_credentials


class SnapshotCoordinator:
    def __init__(self, log: Any) -> None:
        self.log = log

    async def prepare(self) -> list[str]:
        """Return warnings; an empty list means every managed service quiesced."""
        remove_snapshot_credentials()
        if not DEV_SERVICE_METADATA_PATH.exists():
            return []
        try:
            payload = json.loads(DEV_SERVICE_METADATA_PATH.read_text())
            services = payload.get("services", [])
            manifest_path = payload.get("manifestPath")
            if not isinstance(services, list):
                raise ValueError("services metadata must be a list")
        except Exception as error:
            return [f"Could not read development service metadata: {error}"]

        snapshot_commands: dict[str, tuple[str, Path]] = {}
        if isinstance(manifest_path, str) and manifest_path:
            try:
                manifest = load_environment_manifest(Path(manifest_path))
                manifest_root = Path(manifest_path).parent.parent
                snapshot_commands = {
                    service.name: (
                        service.snapshot_command,
                        (manifest_root / service.cwd).resolve(),
                    )
                    for service in manifest.services.processes
                    if service.snapshot_command
                }
            except Exception as error:
                self.log.warn("snapshot.manifest_reload_failed", exc=error)

        warnings: list[str] = []
        for service in reversed(services):
            if not isinstance(service, dict):
                continue
            name = str(service.get("name") or "unknown")
            kind = service.get("kind")
            try:
                if kind == "postgres":
                    await self._stop_postgres(service)
                elif kind == "redis":
                    await self._stop_redis(service)
                elif kind == "process":
                    command = snapshot_commands.get(name)
                    if command:
                        await self._run_snapshot_command(*command)
                    self._terminate_process_group(service)
            except Exception as error:
                warnings.append(f"Could not quiesce {name}: {error}")
        return warnings

    async def _stop_postgres(self, service: dict[str, object]) -> None:
        data_dir = service.get("dataDir")
        pg_config = shutil.which("pg_config")
        if not isinstance(data_dir, str) or not pg_config:
            raise RuntimeError("PostgreSQL data directory or pg_config is unavailable")
        lookup = await asyncio.create_subprocess_exec(
            pg_config,
            "--bindir",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await lookup.communicate()
        if lookup.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip())
        pg_ctl = str(Path(stdout.decode().strip()) / "pg_ctl")
        await self._run(
            "runuser",
            "-u",
            "postgres",
            "--",
            pg_ctl,
            "-D",
            data_dir,
            "-m",
            "fast",
            "stop",
        )

    async def _stop_redis(self, service: dict[str, object]) -> None:
        port = service.get("port")
        redis_cli = shutil.which("redis-cli")
        if not isinstance(port, int) or not redis_cli:
            raise RuntimeError("Redis port or redis-cli is unavailable")
        await self._run(redis_cli, "-p", str(port), "shutdown", "save")

    async def _run_snapshot_command(self, command: str, cwd: Path) -> None:
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=cwd,
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60.0)
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip())

    @staticmethod
    def _terminate_process_group(service: dict[str, object]) -> None:
        pid = service.get("pid")
        if not isinstance(pid, int) or pid <= 1:
            raise RuntimeError("invalid process ID")
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            return

    @staticmethod
    async def _run(*command: str) -> None:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60.0)
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip())
