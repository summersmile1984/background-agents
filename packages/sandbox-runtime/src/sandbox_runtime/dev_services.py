"""Per-sandbox PostgreSQL, Redis, and repository process supervision."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .environment_manifest import (
    EnvironmentManifest,
    ProcessService,
    find_environment_manifest,
    load_environment_manifest,
)

if TYPE_CHECKING:
    from collections.abc import Callable

DEV_SERVICE_METADATA_PATH = Path("/tmp/open-inspect-dev-services.json")


@dataclass
class ManagedProcess:
    name: str
    kind: str
    process: asyncio.subprocess.Process
    port: int | None = None
    data_dir: Path | None = None
    snapshot_command: str | None = None
    cwd: Path | None = None


class DevServiceManager:
    """Starts optional services without making secondary failures fatal."""

    def __init__(self, *, workspace_path: Path, log: Any, warn: Callable[[str, str], None]) -> None:
        self.workspace_path = workspace_path
        self.state_root = workspace_path / ".openinspect" / "state"
        self.log = log
        self.warn = warn
        self._processes: list[ManagedProcess] = []
        self.manifest_path: Path | None = None

    async def start(self, repositories: tuple[object, ...], workdir: Path) -> bool:
        self.manifest_path = find_environment_manifest(repositories, workdir)
        if self.manifest_path is None:
            return True
        try:
            manifest = load_environment_manifest(self.manifest_path)
        except Exception as error:
            self._record_warning(f"Invalid .openinspect/environment.yaml: {error}")
            return False

        self.state_root.mkdir(parents=True, exist_ok=True)
        success = True
        if manifest.services.postgres.enabled:
            success = await self._start_postgres(manifest, workdir) and success
        if manifest.services.redis.enabled:
            success = await self._start_redis(manifest) and success
        for process in manifest.services.processes:
            success = await self._start_process(process, workdir) and success
        self._write_metadata()
        return success

    async def stop(self) -> None:
        for managed in reversed(self._processes):
            await self._stop_process(managed)
        self._processes.clear()
        DEV_SERVICE_METADATA_PATH.unlink(missing_ok=True)

    async def _start_postgres(self, manifest: EnvironmentManifest, workdir: Path) -> bool:
        config = manifest.services.postgres
        bindir = await self._postgres_bindir()
        if bindir is None:
            self._record_warning("PostgreSQL is enabled but its binaries are not installed.")
            return False
        data_dir = self.state_root / "postgres"
        data_dir.mkdir(parents=True, exist_ok=True)
        managed: ManagedProcess | None = None
        try:
            # Managed E2B/Cube sandboxes run the supervisor as an unprivileged
            # user. Only root can hand the data directory to the distro's
            # postgres account; otherwise initialise and run PostgreSQL as the
            # current sandbox user, which already owns the workspace.
            if os.geteuid() == 0:
                await self._run("chown", "-R", "postgres:postgres", str(data_dir))
            if not (data_dir / "PG_VERSION").exists():
                await self._run(
                    *self._postgres_command(
                        str(bindir / "initdb"),
                        "-D",
                        str(data_dir),
                        "-U",
                        config.user,
                        "--auth=trust",
                        "--no-locale",
                    )
                )
            process = await asyncio.create_subprocess_exec(
                *self._postgres_command(
                    str(bindir / "postgres"),
                    "-D",
                    str(data_dir),
                    "-p",
                    str(config.port),
                    "-k",
                    "/tmp",
                ),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            managed = ManagedProcess(
                name="postgres",
                kind="postgres",
                process=process,
                port=config.port,
                data_dir=data_dir,
            )
            self._processes.append(managed)
            await self._wait_for_port(config.port, 60.0, process)
            createdb = await asyncio.create_subprocess_exec(
                str(bindir / "createdb"),
                "-h",
                "127.0.0.1",
                "-p",
                str(config.port),
                "-U",
                config.user,
                config.database,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await createdb.communicate()
            if createdb.returncode and b"already exists" not in stderr:
                raise RuntimeError(stderr.decode(errors="replace").strip())
            os.environ.update(
                {
                    "PGHOST": "127.0.0.1",
                    "PGPORT": str(config.port),
                    "PGUSER": config.user,
                    "PGDATABASE": config.database,
                    "DATABASE_URL": (
                        f"postgresql://{config.user}@127.0.0.1:{config.port}/{config.database}"
                    ),
                }
            )
            self.log.info(
                "dev_service.ready", service="postgres", port=config.port, workdir=str(workdir)
            )
            return True
        except Exception as error:
            await self._discard_failed_process(managed)
            self._record_warning(f"PostgreSQL failed to start: {error}")
            return False

    async def _start_redis(self, manifest: EnvironmentManifest) -> bool:
        config = manifest.services.redis
        executable = shutil.which("redis-server")
        if not executable:
            self._record_warning("Redis is enabled but redis-server is not installed.")
            return False
        data_dir = self.state_root / "redis"
        data_dir.mkdir(parents=True, exist_ok=True)
        managed: ManagedProcess | None = None
        try:
            process = await asyncio.create_subprocess_exec(
                executable,
                "--bind",
                "127.0.0.1",
                "--port",
                str(config.port),
                "--dir",
                str(data_dir),
                "--appendonly",
                "yes",
                "--appendfsync",
                "everysec",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            managed = ManagedProcess(
                name="redis",
                kind="redis",
                process=process,
                port=config.port,
                data_dir=data_dir,
            )
            self._processes.append(managed)
            await self._wait_for_port(config.port, 30.0, process)
            os.environ.update(
                {
                    "REDIS_URL": f"redis://127.0.0.1:{config.port}/0",
                    "REDIS_HOST": "127.0.0.1",
                    "REDIS_PORT": str(config.port),
                }
            )
            self.log.info("dev_service.ready", service="redis", port=config.port)
            return True
        except Exception as error:
            await self._discard_failed_process(managed)
            self._record_warning(f"Redis failed to start: {error}")
            return False

    async def _start_process(self, config: ProcessService, workdir: Path) -> bool:
        managed: ManagedProcess | None = None
        try:
            cwd = (workdir / config.cwd).resolve()
            workspace = self.workspace_path.resolve()
            if not cwd.is_relative_to(workspace):
                raise ValueError("cwd must remain inside /workspace")
            environment = dict(os.environ)
            environment.update(
                {key: os.path.expandvars(value) for key, value in config.env.items()}
            )
            process = await asyncio.create_subprocess_shell(
                config.command,
                cwd=cwd,
                env=environment,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            managed = ManagedProcess(
                name=config.name,
                kind="process",
                process=process,
                port=config.ports[0] if config.ports else None,
                snapshot_command=config.snapshot_command,
                cwd=cwd,
            )
            self._processes.append(managed)
            for port in config.ports:
                await self._wait_for_port(port, config.ready_timeout_seconds, process)
            if not config.ports:
                await asyncio.sleep(0)
                if process.returncode is not None:
                    raise RuntimeError(f"exited with status {process.returncode}")
            if config.ports:
                prefix = "OPENINSPECT_SERVICE_" + config.name.upper().replace("-", "_")
                os.environ[f"{prefix}_PORT"] = str(config.ports[0])
                os.environ[f"{prefix}_URL"] = f"http://127.0.0.1:{config.ports[0]}"
            self.log.info("dev_service.ready", service=config.name, ports=config.ports)
            return True
        except Exception as error:
            await self._discard_failed_process(managed)
            self._record_warning(f"Process service {config.name} failed to start: {error}")
            return False

    async def _wait_for_port(
        self, port: int, timeout_seconds: float, process: asyncio.subprocess.Process
    ) -> None:
        async with asyncio.timeout(timeout_seconds):
            while True:
                if process.returncode is not None:
                    raise RuntimeError(f"service exited with status {process.returncode}")
                try:
                    reader, writer = await asyncio.open_connection("127.0.0.1", port)
                    writer.close()
                    await writer.wait_closed()
                    del reader
                    return
                except OSError:
                    await asyncio.sleep(0.25)

    async def _stop_process(self, managed: ManagedProcess) -> None:
        if managed.process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            if managed.kind == "process":
                os.killpg(managed.process.pid, 15)
            else:
                managed.process.terminate()
        try:
            await asyncio.wait_for(managed.process.wait(), timeout=10.0)
        except TimeoutError:
            managed.process.kill()
            await managed.process.wait()

    async def _discard_failed_process(self, managed: ManagedProcess | None) -> None:
        if managed is None:
            return
        await self._stop_process(managed)
        with contextlib.suppress(ValueError):
            self._processes.remove(managed)

    async def _postgres_bindir(self) -> Path | None:
        pg_config = shutil.which("pg_config")
        if not pg_config:
            return None
        process = await asyncio.create_subprocess_exec(
            pg_config,
            "--bindir",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await process.communicate()
        if process.returncode:
            return None
        return Path(stdout.decode().strip())

    @staticmethod
    def _postgres_command(*command: str) -> tuple[str, ...]:
        if os.geteuid() == 0:
            return ("runuser", "-u", "postgres", "--", *command)
        return command

    async def _run(self, *command: str) -> None:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _stdout, stderr = await process.communicate()
        if process.returncode:
            raise RuntimeError(stderr.decode(errors="replace").strip())

    def _write_metadata(self) -> None:
        metadata = [
            {
                "name": managed.name,
                "kind": managed.kind,
                "pid": managed.process.pid,
                "port": managed.port,
                "dataDir": str(managed.data_dir) if managed.data_dir else None,
                "cwd": str(managed.cwd) if managed.cwd else None,
                "hasSnapshotCommand": managed.snapshot_command is not None,
            }
            for managed in self._processes
        ]
        DEV_SERVICE_METADATA_PATH.write_text(
            json.dumps(
                {
                    "manifestPath": str(self.manifest_path) if self.manifest_path else None,
                    "services": metadata,
                }
            )
        )

    def _record_warning(self, message: str) -> None:
        self.log.warn("dev_service.degraded", warning_message=message)
        self.warn("services", message)
