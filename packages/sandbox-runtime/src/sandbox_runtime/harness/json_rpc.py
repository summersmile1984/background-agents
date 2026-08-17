"""Line-delimited JSON-RPC subprocess transport used by native harness servers."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

_RPC_SHUTDOWN_TIMEOUT_SECONDS = 5.0


class JsonRpcProcess:
    def __init__(self, command: list[str], *, cwd: str, env: dict[str, str], log: Any) -> None:
        self._command = command
        self._cwd = cwd
        self._env = env
        self._log = log
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self.notifications: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._next_id = 1

    async def start(self) -> None:
        if self._process and self._process.returncode is None:
            return
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            cwd=self._cwd,
            env=self._env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

    async def request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        process = self._require_process()
        if not process.stdin:
            raise RuntimeError("Harness RPC stdin is unavailable")
        request_id = self._next_id
        self._next_id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        payload = json.dumps({"id": request_id, "method": method, "params": params})
        process.stdin.write(payload.encode("utf-8") + b"\n")
        await process.stdin.drain()
        response = await future
        if "error" in response:
            raise RuntimeError(f"{method} failed: {response['error']}")
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        process = self._require_process()
        if not process.stdin:
            raise RuntimeError("Harness RPC stdin is unavailable")
        payload: dict[str, Any] = {"method": method}
        if params is not None:
            payload["params"] = params
        process.stdin.write(json.dumps(payload).encode("utf-8") + b"\n")
        await process.stdin.drain()

    async def close(self) -> None:
        process = self._process
        if process and process.stdin:
            process.stdin.close()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                await process.stdin.wait_closed()
        if process and process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=_RPC_SHUTDOWN_TIMEOUT_SECONDS)
            except TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=_RPC_SHUTDOWN_TIMEOUT_SECONDS)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task:
                if not task.done():
                    task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        self._fail_pending(RuntimeError("Harness RPC process closed"))
        self._process = None
        self._reader_task = None
        self._stderr_task = None

    def _require_process(self) -> asyncio.subprocess.Process:
        if not self._process or self._process.returncode is not None:
            raise RuntimeError("Harness RPC process is not running")
        return self._process

    async def _read_stdout(self) -> None:
        process = self._require_process()
        if not process.stdout:
            return
        try:
            async for raw_line in process.stdout:
                try:
                    message = json.loads(raw_line)
                except json.JSONDecodeError:
                    self._log.warn(
                        "harness.rpc_invalid_json", line=raw_line.decode(errors="replace")
                    )
                    continue
                request_id = message.get("id")
                if isinstance(request_id, int) and request_id in self._pending:
                    self._pending.pop(request_id).set_result(message)
                elif "method" in message:
                    await self.notifications.put(message)
        except Exception as error:
            self._fail_pending(error)

    async def _read_stderr(self) -> None:
        process = self._require_process()
        if not process.stderr:
            return
        async for raw_line in process.stderr:
            self._log.info(
                "harness.rpc_log",
                detail=raw_line.decode(errors="replace").rstrip(),
            )

    def _fail_pending(self, error: BaseException) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
