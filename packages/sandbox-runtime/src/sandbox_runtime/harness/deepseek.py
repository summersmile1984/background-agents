"""DeepSeek CodeWhale app-server driver.

CodeWhale exposes newline-delimited JSON-RPC 2.0 on stdio. Its streaming
events are bare JSON objects rather than JSON-RPC notifications, so this
adapter keeps that transport detail behind the provider-neutral bridge.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..types import AgentHarness
from .json_rpc import JsonRpcProcess
from .mcp_config import codewhale_mcp_config

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from .base import HarnessPrompt

_REQUIRED_METHODS = {
    "thread/start",
    "thread/resume",
    "thread/message",
    "thread/interrupt",
}


class DeepSeekHarnessDriver:
    harness = AgentHarness.DEEPSEEK

    def __init__(
        self,
        *,
        workspace_path: str,
        state_path: str | Path,
        log: Any,
        environment: Mapping[str, str] | None = None,
        mcp_servers: tuple[Mapping[str, Any], ...] = (),
        mcp_config_path: str | Path | None = None,
        rpc: JsonRpcProcess | None = None,
    ) -> None:
        self._workspace_path = workspace_path
        self._state_path = Path(state_path)
        self._state_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._log = log
        self._environment = dict(environment or os.environ)
        self._environment.update(
            {
                "CODEWHALE_HOME": str(self._state_path),
                "CODEWHALE_APPROVAL_POLICY": "never",
                "CODEWHALE_SANDBOX_MODE": "danger-full-access",
                "CODEWHALE_ALLOW_SHELL": "true",
                "CODEWHALE_NO_UPDATE_CHECK": "true",
                "CODEWHALE_TELEMETRY": "false",
            }
        )
        self._owned_mcp_dir: Path | None = None
        if mcp_config_path is None:
            memory_root = Path("/dev/shm") if Path("/dev/shm").is_dir() else None
            self._owned_mcp_dir = Path(
                tempfile.mkdtemp(prefix="open-inspect-codewhale-", dir=memory_root)
            )
            self._owned_mcp_dir.chmod(0o700)
            mcp_path = self._owned_mcp_dir / "mcp.json"
        else:
            mcp_path = Path(mcp_config_path)
            mcp_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        mcp_path.write_text(json.dumps(codewhale_mcp_config(mcp_servers), separators=(",", ":")))
        mcp_path.chmod(0o600)
        self._environment["CODEWHALE_MCP_CONFIG"] = str(mcp_path)

        self._rpc = rpc or JsonRpcProcess(
            ["codewhale", "app-server", "--stdio"],
            cwd=workspace_path,
            env=self._environment,
            log=log,
        )
        self._rpc_started = False
        self._thread_prepared = False
        self._session_id: str | None = None
        self._active_request: asyncio.Task[dict[str, Any]] | None = None
        self._stale_response_ids: set[str] = set()

    @property
    def session_id(self) -> str | None:
        return self._session_id

    async def start(self, existing_session_id: str | None = None) -> str | None:
        if not self._rpc_started:
            await self._rpc.start()
            capabilities = await self._rpc.request("capabilities", {})
            methods = capabilities.get("methods")
            if not isinstance(methods, list) or not _REQUIRED_METHODS.issubset(methods):
                raise RuntimeError("CodeWhale app-server lacks required thread methods")
            self._rpc_started = True
        if existing_session_id and not self._session_id:
            self._session_id = existing_session_id
        return self._session_id

    async def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]:
        await self.start(self._session_id)
        await self._ensure_thread(prompt.model)
        if not self._session_id:
            raise RuntimeError("CodeWhale thread not initialized")
        self._drain_notifications()
        prompt_text = self._materialize_attachments(prompt)
        request_task = asyncio.create_task(
            self._rpc.request(
                "thread/message",
                {"thread_id": self._session_id, "input": prompt_text},
            )
        )
        self._active_request = request_task
        response_ended = False
        active_response_id: str | None = None
        try:
            while not response_ended:
                if request_task.done():
                    try:
                        event = self._rpc.notifications.get_nowait()
                    except asyncio.QueueEmpty:
                        await request_task
                        break
                else:
                    event_task = asyncio.create_task(self._rpc.notifications.get())
                    done, _pending = await asyncio.wait(
                        {event_task, request_task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if event_task not in done:
                        event_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await event_task
                        continue
                    event = event_task.result()

                event_type = event.get("type")
                response_id = event.get("response_id")
                if not isinstance(response_id, str):
                    continue
                if response_id in self._stale_response_ids:
                    if event_type == "response_end":
                        self._stale_response_ids.discard(response_id)
                    continue
                if event_type == "response_start":
                    active_response_id = response_id
                elif event_type == "response_delta" and response_id == active_response_id:
                    delta = event.get("delta")
                    if isinstance(delta, str) and delta:
                        yield {"type": "token", "content": delta, "messageId": prompt.message_id}
                elif event_type == "response_end" and response_id == active_response_id:
                    response_ended = True

            response = await request_task
            yield {
                "type": "step_finish",
                "messageId": prompt.message_id,
                "reason": str(response.get("status") or "completed"),
            }
        finally:
            if active_response_id and not response_ended:
                self._stale_response_ids.add(active_response_id)
            if not request_task.done():
                request_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await request_task
            self._active_request = None

    async def stop(self, *, reason: str) -> bool:
        if not self._session_id or not self._active_request:
            return False
        response = await self._rpc.request("thread/interrupt", {"thread_id": self._session_id})
        interrupted = bool(response.get("interrupted"))
        self._log.info(
            "harness.turn_interrupted",
            harness=self.harness,
            reason=reason,
            interrupted=interrupted,
        )
        return interrupted

    async def close(self) -> None:
        if self._rpc_started:
            with contextlib.suppress(Exception):
                await self._rpc.request("shutdown", {})
        await self._rpc.close()
        if self._owned_mcp_dir:
            shutil.rmtree(self._owned_mcp_dir, ignore_errors=True)

    async def _ensure_thread(self, model: str | None) -> None:
        if self._thread_prepared:
            return
        normalized_model = self._normalize_model(model)
        response: dict[str, Any] | None = None
        if self._session_id:
            try:
                response = await self._rpc.request(
                    "thread/resume",
                    {
                        "thread_id": self._session_id,
                        "cwd": self._workspace_path,
                        "approval_policy": "never",
                        "sandbox": "danger-full-access",
                        "model_provider": "deepseek",
                        **({"model": normalized_model} if normalized_model else {}),
                    },
                )
            except Exception as error:
                self._log.warn(
                    "harness.session_resume_failed",
                    harness=self.harness,
                    session_id=self._session_id,
                    exc=error,
                )
                self._session_id = None
        if response is None:
            response = await self._rpc.request(
                "thread/start",
                {
                    "cwd": self._workspace_path,
                    "model_provider": "deepseek",
                    "persist_extended_history": True,
                    **({"model": normalized_model} if normalized_model else {}),
                },
            )
        thread_id = response.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            raise RuntimeError("CodeWhale app-server returned no thread ID")
        self._session_id = thread_id
        self._thread_prepared = True

    def _materialize_attachments(self, prompt: HarnessPrompt) -> str:
        if not prompt.attachments:
            return prompt.content
        attachment_dir = Path("/tmp/open-inspect-attachments") / prompt.message_id
        attachment_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        paths: list[str] = []
        for index, attachment in enumerate(prompt.attachments):
            suffix = {
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/gif": ".gif",
                "image/webp": ".webp",
            }[attachment["mimeType"]]
            path = attachment_dir / f"{index:02d}{suffix}"
            path.write_bytes(base64.b64decode(attachment["content"], validate=True))
            paths.append(str(path))
        rendered_paths = "\n".join(f"- {path}" for path in paths)
        return f"{prompt.content}\n\nAttached images are available at:\n{rendered_paths}"

    @staticmethod
    def _normalize_model(model: str | None) -> str | None:
        if not model:
            return None
        if "/" not in model:
            return model
        return model.split("/", 1)[1] if model.startswith("deepseek/") else None

    def _drain_notifications(self) -> None:
        while True:
            try:
                self._rpc.notifications.get_nowait()
            except asyncio.QueueEmpty:
                return
