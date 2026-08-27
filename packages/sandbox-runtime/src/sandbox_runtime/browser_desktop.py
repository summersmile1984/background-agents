from __future__ import annotations

import asyncio
import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
from cryptography.hazmat.primitives.ciphers import Cipher, modes

from .constants import (
    AIO_BROWSER_CDP_ENDPOINT_ENV_VAR,
    AIO_BROWSER_CDP_PORT,
    AIO_BROWSER_CDP_PORT_ENV_VAR,
    AIO_BROWSER_ENABLED_ENV_VAR,
    AIO_BROWSER_EXECUTABLE_PATH,
    AIO_BROWSER_EXECUTABLE_PATH_ENV_VAR,
    AIO_BROWSER_MCP_EXECUTABLE_PATH,
    AIO_BROWSER_MCP_EXECUTABLE_PATH_ENV_VAR,
    AIO_BROWSER_MCP_PORT,
    AIO_BROWSER_MCP_PORT_ENV_VAR,
    AIO_BROWSER_MCP_URL_ENV_VAR,
    AIO_BROWSER_RUNTIME_ROOT,
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    NOVNC_WEB_ROOT,
    VNC_DISPLAY,
    VNC_PASSWORD_FILE_PATH,
    VNC_PASSWORD_MAX_BYTES,
    VNC_PORT,
)
from .process_output import iter_process_lines
from .service_ports import port_from_env

if TYPE_CHECKING:
    from collections.abc import Mapping

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_READINESS_TIMEOUT_SECONDS = 5
_BROWSER_READINESS_TIMEOUT_SECONDS = 15
_VNC_PASSWORD_FILE_KEY = bytes((0xE8, 0x4A, 0xD6, 0x60, 0xC4, 0x72, 0x1A, 0xE0)) * 3


def _enabled(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def _configured_port(environment: Mapping[str, str], name: str, default: int) -> int:
    raw = environment.get(name)
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default


@dataclass(frozen=True)
class AioBrowserRuntimeConfig:
    """The browser-only slice extracted from the pinned AIO Sandbox image."""

    executable_path: str
    mcp_executable_path: str
    cdp_port: int
    mcp_port: int
    runtime_root: Path = Path(AIO_BROWSER_RUNTIME_ROOT)

    @classmethod
    def from_env(cls, environment: Mapping[str, str]) -> AioBrowserRuntimeConfig | None:
        if not _enabled(environment.get(AIO_BROWSER_ENABLED_ENV_VAR)):
            return None
        return cls(
            executable_path=environment.get(
                AIO_BROWSER_EXECUTABLE_PATH_ENV_VAR, AIO_BROWSER_EXECUTABLE_PATH
            ),
            mcp_executable_path=environment.get(
                AIO_BROWSER_MCP_EXECUTABLE_PATH_ENV_VAR,
                AIO_BROWSER_MCP_EXECUTABLE_PATH,
            ),
            cdp_port=_configured_port(
                environment, AIO_BROWSER_CDP_PORT_ENV_VAR, AIO_BROWSER_CDP_PORT
            ),
            mcp_port=_configured_port(
                environment, AIO_BROWSER_MCP_PORT_ENV_VAR, AIO_BROWSER_MCP_PORT
            ),
        )

    @property
    def cdp_endpoint(self) -> str:
        return f"http://127.0.0.1:{self.cdp_port}/json/version"

    @property
    def mcp_url(self) -> str:
        return f"http://127.0.0.1:{self.mcp_port}/mcp"


def _encode_vnc_password(password: bytes) -> bytes:
    encryptor = Cipher(TripleDES(_VNC_PASSWORD_FILE_KEY), modes.ECB()).encryptor()
    return encryptor.update(password.ljust(VNC_PASSWORD_MAX_BYTES, b"\0")) + encryptor.finalize()


class BrowserDesktop:
    def __init__(
        self,
        log: Any,
        *,
        password: str | None,
        aio_browser: AioBrowserRuntimeConfig | None = None,
    ) -> None:
        self.log = log
        self._password = password
        self._aio_browser = aio_browser
        self._xvfb_process: asyncio.subprocess.Process | None = None
        self._fluxbox_process: asyncio.subprocess.Process | None = None
        self._aio_chromium_process: asyncio.subprocess.Process | None = None
        self._aio_browser_mcp_process: asyncio.subprocess.Process | None = None
        self._x11vnc_process: asyncio.subprocess.Process | None = None
        self._novnc_process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        if not self._password and not self._aio_browser:
            Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
            self.log.info("browser_desktop.skip", reason="not_configured")
            return

        self._clear_display_artifacts()
        password_path = Path(VNC_PASSWORD_FILE_PATH)
        password_path.unlink(missing_ok=True)
        if self._password:
            password_bytes = self._password.encode()
            if len(password_bytes) > VNC_PASSWORD_MAX_BYTES:
                raise ValueError(f"VNC password must not exceed {VNC_PASSWORD_MAX_BYTES} bytes")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            password_fd = os.open(password_path, flags, 0o600)
            try:
                os.write(password_fd, _encode_vnc_password(password_bytes))
            finally:
                os.close(password_fd)

        child_env = os.environ.copy()
        display_env = {**child_env, "DISPLAY": VNC_DISPLAY}
        self._xvfb_process = await self._launch(
            "xvfb",
            "Xvfb",
            VNC_DISPLAY,
            "-screen",
            "0",
            "1280x720x24",
            "-nolisten",
            "tcp",
            env=child_env,
        )
        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        if not await self._wait_for_path(
            Path(f"/tmp/.X11-unix/X{display_number}"), self._xvfb_process
        ):
            await self.stop()
            raise RuntimeError("Xvfb failed to become ready")
        self._fluxbox_process = await self._launch("fluxbox", "fluxbox", env=display_env)
        if self._aio_browser:
            await self._start_aio_browser(display_env)
        if not self._password:
            self.log.info("browser_desktop.started", display=VNC_DISPLAY, vnc_enabled=False)
            return
        self._x11vnc_process = await self._launch(
            "x11vnc",
            "x11vnc",
            "-display",
            VNC_DISPLAY,
            "-rfbport",
            str(VNC_PORT),
            "-listen",
            "127.0.0.1",
            "-forever",
            "-shared",
            "-rfbauth",
            VNC_PASSWORD_FILE_PATH,
            env=display_env,
        )
        if not await self._wait_for_port(VNC_PORT):
            await self.stop()
            raise RuntimeError("x11vnc failed to become ready")
        novnc_port = port_from_env(NOVNC_PORT_ENV_VAR, NOVNC_PORT)
        self._novnc_process = await self._launch(
            "novnc",
            "websockify",
            "--web",
            NOVNC_WEB_ROOT,
            f"0.0.0.0:{novnc_port}",
            f"127.0.0.1:{VNC_PORT}",
            env=child_env,
        )
        self.log.info("vnc.started", display=VNC_DISPLAY, novnc_port=novnc_port)

    async def _start_aio_browser(self, display_env: dict[str, str]) -> None:
        config = self._aio_browser
        if config is None:
            return
        executable = Path(config.executable_path)
        mcp_executable = Path(config.mcp_executable_path)
        if (
            not executable.is_absolute()
            or not executable.is_file()
            or not os.access(executable, os.X_OK)
        ):
            raise RuntimeError("AIO Chromium executable is unavailable")
        if (
            not mcp_executable.is_absolute()
            or not mcp_executable.is_file()
            or not os.access(mcp_executable, os.X_OK)
        ):
            raise RuntimeError("AIO browser MCP executable is unavailable")

        profile_dir = config.runtime_root / "profile"
        output_dir = config.runtime_root / "downloads"
        for directory in (config.runtime_root, profile_dir, output_dir):
            directory.mkdir(parents=True, exist_ok=True)
            # Cube starts the supervisor as root and launches Chromium as the
            # fixed sandbox user. Non-root runtimes already own the directory
            # they created and cannot change its ownership (including CI).
            if os.geteuid() == 0:
                os.chown(directory, 1000, 1000)
        for stale_lock in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
            (profile_dir / stale_lock).unlink(missing_ok=True)

        browser_env = {
            **display_env,
            "HOME": "/home/user",
            "XDG_CONFIG_HOME": str(config.runtime_root / "config"),
            "XDG_CACHE_HOME": str(config.runtime_root / "cache"),
        }
        for directory in (
            Path(browser_env["XDG_CONFIG_HOME"]),
            Path(browser_env["XDG_CACHE_HOME"]),
        ):
            directory.mkdir(parents=True, exist_ok=True)
            if os.geteuid() == 0:
                os.chown(directory, 1000, 1000)
        self._aio_chromium_process = await self._launch(
            "aio_chromium",
            config.executable_path,
            f"--user-data-dir={profile_dir}",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-backgrounding-occluded-windows",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-blink-features=AutomationControlled",
            "--disable-gpu",
            "--disable-logging",
            "--disable-features=Translate",
            "--log-level=3",
            "--no-default-browser-check",
            "--no-first-run",
            "--noerrdialogs",
            "--password-store=basic",
            "--remote-allow-origins=*",
            "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={config.cdp_port}",
            "--start-maximized",
            "--window-size=1280,720",
            "about:blank",
            env=browser_env,
            user=1000,
            group=1000,
        )
        if not await self._wait_for_cdp(
            config.cdp_port,
            self._aio_chromium_process,
            timeout_seconds=_BROWSER_READINESS_TIMEOUT_SECONDS,
        ):
            await self.stop()
            raise RuntimeError("AIO Chromium CDP endpoint failed to become ready")

        self._aio_browser_mcp_process = await self._launch(
            "aio_browser_mcp",
            config.mcp_executable_path,
            "--port",
            str(config.mcp_port),
            "--host",
            "127.0.0.1",
            "--browser",
            "chrome",
            "--output-dir",
            str(output_dir),
            "--cdp-endpoint",
            config.cdp_endpoint,
            "--viewport-size",
            "0,0",
            env=browser_env,
            user=1000,
            group=1000,
        )
        if not await self._wait_for_port(
            config.mcp_port, timeout_seconds=_BROWSER_READINESS_TIMEOUT_SECONDS
        ):
            await self.stop()
            raise RuntimeError("AIO browser MCP endpoint failed to become ready")

        os.environ[AIO_BROWSER_CDP_ENDPOINT_ENV_VAR] = config.cdp_endpoint
        os.environ[AIO_BROWSER_MCP_URL_ENV_VAR] = config.mcp_url
        os.environ.setdefault(AIO_BROWSER_EXECUTABLE_PATH_ENV_VAR, config.executable_path)
        self.log.info(
            "aio_browser.started",
            cdp_port=config.cdp_port,
            mcp_port=config.mcp_port,
        )

    async def _launch(
        self,
        name: str,
        *command: str,
        env: dict[str, str],
        user: int | None = None,
        group: int | None = None,
    ) -> asyncio.subprocess.Process:
        process_options: dict[str, Any] = {}
        if user is not None:
            process_options["user"] = user
        if group is not None:
            process_options["group"] = group
        process = await asyncio.create_subprocess_exec(
            *command,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
            **process_options,
        )
        asyncio.create_task(self._forward_logs(name, process))
        return process

    async def _forward_logs(self, name: str, process: asyncio.subprocess.Process) -> None:
        if not process.stdout:
            return
        log = self.log.debug if name == "fluxbox" else self.log.info
        async for line in iter_process_lines(
            process.stdout,
            on_error=lambda error: self.log.warn(f"{name}.log_forward_error", exc=error),
        ):
            log(f"{name}.stdout", line=line)

    def _clear_display_artifacts(self) -> None:
        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        for path in (
            Path(f"/tmp/.X{display_number}-lock"),
            Path(f"/tmp/.X11-unix/X{display_number}"),
        ):
            path.unlink(missing_ok=True)

    async def _wait_for_path(
        self,
        path: Path,
        process: asyncio.subprocess.Process,
        timeout_seconds: float = _READINESS_TIMEOUT_SECONDS,
    ) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            if process.returncode is not None:
                return False
            if path.exists():
                return True
            await asyncio.sleep(0.1)
        self.log.warn("path_readiness.timeout", path=str(path), timeout=timeout_seconds)
        return False

    async def _wait_for_port(
        self, port: int, timeout_seconds: float = _READINESS_TIMEOUT_SECONDS
    ) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=port, timeout=timeout_seconds)
        return False

    async def _wait_for_cdp(
        self,
        port: int,
        process: asyncio.subprocess.Process,
        *,
        timeout_seconds: float,
    ) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            if process.returncode is not None:
                return False
            writer: asyncio.StreamWriter | None = None
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(
                    b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                )
                await writer.drain()
                response = await asyncio.wait_for(reader.read(64 * 1024), timeout=1)
                headers, separator, body = response.partition(b"\r\n\r\n")
                status_lines = headers.splitlines()
                payload = (
                    json.loads(body)
                    if separator and status_lines and b" 200 " in status_lines[0]
                    else {}
                )
                if isinstance(payload, dict) and isinstance(
                    payload.get("webSocketDebuggerUrl"), str
                ):
                    return True
            except (ConnectionRefusedError, OSError, TimeoutError, json.JSONDecodeError):
                pass
            finally:
                if writer is not None:
                    writer.close()
                    with contextlib.suppress(OSError):
                        await writer.wait_closed()
            await asyncio.sleep(0.1)
        self.log.warn("cdp_readiness.timeout", port=port, timeout=timeout_seconds)
        return False

    async def stop(self) -> None:
        for name, process in (
            ("novnc", self._novnc_process),
            ("x11vnc", self._x11vnc_process),
            ("aio_browser_mcp", self._aio_browser_mcp_process),
            ("aio_chromium", self._aio_chromium_process),
            ("fluxbox", self._fluxbox_process),
            ("xvfb", self._xvfb_process),
        ):
            if process and process.returncode is None:
                self.log.info(f"{name}.terminating")
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=_READINESS_TIMEOUT_SECONDS)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=_READINESS_TIMEOUT_SECONDS)
                    except TimeoutError:
                        self.log.warn(f"{name}.stop_timeout")
            setattr(self, f"_{name}_process", None)
        Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
        self._clear_display_artifacts()

    def crash(self) -> tuple[str, int] | None:
        for name, process in (
            ("xvfb", self._xvfb_process),
            ("fluxbox", self._fluxbox_process),
            ("aio_chromium", self._aio_chromium_process),
            ("aio_browser_mcp", self._aio_browser_mcp_process),
            ("x11vnc", self._x11vnc_process),
            ("novnc", self._novnc_process),
        ):
            if process and process.returncode is not None:
                return name, process.returncode
        return None
