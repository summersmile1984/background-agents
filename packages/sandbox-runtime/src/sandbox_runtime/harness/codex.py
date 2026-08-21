"""Codex app-server driver.

The app-server protocol is native JSON-RPC over stdio. This adapter keeps those
details inside the sandbox and emits the existing Open-Inspect event contract.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from ..deepseek_relay import deepseek_relay_url, uses_deepseek_model
from ..harness_credentials import remove_runtime_codex_auth
from ..types import AgentHarness
from .json_rpc import JsonRpcProcess
from .mcp_config import codex_mcp_config

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from .base import HarnessPrompt

_SECRET_ENV_NAMES = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_AUTH_JSON",
    "CODEX_ACCESS_TOKEN",
    "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    "CODEX_HOME",
    "CODEX_OPENAI_BASE_URL",
    "DEEPSEEK_RELAY_BASE_URL",
    "SANDBOX_AUTH_TOKEN",
)
_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}
_CODEX_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL"
_BUILTIN_MCP_ENV_NAMES = (
    "CONTROL_PLANE_URL",
    "SANDBOX_AUTH_TOKEN",
)


class CodexHarnessDriver:
    harness = AgentHarness.CODEX

    def __init__(
        self,
        *,
        workspace_path: str,
        log: Any,
        environment: Mapping[str, str] | None = None,
        mcp_servers: tuple[Mapping[str, Any], ...] = (),
        rpc: JsonRpcProcess | None = None,
    ) -> None:
        self._workspace_path = workspace_path
        self._log = log
        self._environment = dict(environment or os.environ)
        self._mcp_servers = mcp_servers
        self._rpc = rpc or JsonRpcProcess(
            self._app_server_command(self._environment),
            cwd=workspace_path,
            env=self._environment,
            log=log,
        )
        self._session_id: str | None = None
        self._active_turn_id: str | None = None
        self._latest_usage: dict[str, Any] | None = None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    async def start(self, existing_session_id: str | None = None) -> str:
        await self._rpc.start()
        await self._rpc.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "open-inspect",
                    "title": "Open-Inspect sandbox bridge",
                    "version": "0.1.0",
                },
                "capabilities": {},
            },
        )
        await self._rpc.notify("initialized")
        remove_runtime_codex_auth()

        response: dict[str, Any] | None = None
        if existing_session_id:
            try:
                response = await self._rpc.request(
                    "thread/resume",
                    {
                        "threadId": existing_session_id,
                        "cwd": self._workspace_path,
                        "approvalPolicy": "never",
                        "sandbox": "danger-full-access",
                        "config": self._thread_config(),
                    },
                )
            except Exception as error:
                self._log.warn(
                    "harness.session_resume_failed",
                    harness=self.harness,
                    session_id=existing_session_id,
                    exc=error,
                )
        if response is None:
            response = await self._rpc.request(
                "thread/start",
                {
                    "cwd": self._workspace_path,
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "serviceName": "open-inspect",
                    "config": self._thread_config(),
                },
            )
        thread = response.get("thread")
        if not isinstance(thread, dict) or not isinstance(thread.get("id"), str):
            raise RuntimeError("Codex app-server returned no thread ID")
        self._session_id = thread["id"]
        return self._session_id

    async def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]:
        if not self._session_id:
            raise RuntimeError("Codex thread not initialized")
        self._drain_notifications()
        self._latest_usage = None
        inputs: list[dict[str, Any]] = [{"type": "text", "text": prompt.content}]
        for attachment in prompt.attachments or []:
            inputs.append(
                {
                    "type": "image",
                    "url": (f"data:{attachment['mimeType']};base64,{attachment['content']}"),
                }
            )
        params: dict[str, Any] = {
            "threadId": self._session_id,
            "input": inputs,
            "cwd": self._workspace_path,
            "approvalPolicy": "never",
        }
        model = self._normalize_model(prompt.model)
        if model:
            params["model"] = model
        if (
            prompt.reasoning_effort is not None
            and prompt.reasoning_effort not in _REASONING_EFFORTS
        ):
            raise ValueError(f"Unsupported Codex reasoning effort: {prompt.reasoning_effort}")
        if prompt.reasoning_effort in _REASONING_EFFORTS:
            params["effort"] = prompt.reasoning_effort

        response = await self._rpc.request("turn/start", params)
        turn = response.get("turn")
        if not isinstance(turn, dict) or not isinstance(turn.get("id"), str):
            raise RuntimeError("Codex app-server returned no turn ID")
        self._active_turn_id = turn["id"]
        cumulative_text = ""

        while True:
            notification = await self._rpc.notifications.get()
            method = notification.get("method")
            event_params = notification.get("params")
            if not isinstance(method, str) or not isinstance(event_params, dict):
                continue
            if event_params.get("threadId") != self._session_id:
                continue
            turn_id = event_params.get("turnId")
            if turn_id and turn_id != self._active_turn_id:
                continue

            if method == "item/agentMessage/delta":
                delta = event_params.get("delta")
                if isinstance(delta, str) and delta:
                    cumulative_text += delta
                    yield {
                        "type": "token",
                        "content": cumulative_text,
                        "messageId": prompt.message_id,
                    }
                continue
            if method == "thread/tokenUsage/updated":
                usage = event_params.get("tokenUsage")
                if isinstance(usage, dict):
                    self._latest_usage = usage
                continue
            if method == "item/started":
                event = self._tool_call_event(event_params.get("item"), prompt.message_id)
                if event:
                    yield event
                continue
            if method == "item/completed":
                event = self._tool_result_event(event_params.get("item"), prompt.message_id)
                if event:
                    yield event
                continue
            if method != "turn/completed":
                continue

            completed_turn = event_params.get("turn")
            status = completed_turn.get("status") if isinstance(completed_turn, dict) else None
            if status == "failed":
                error = completed_turn.get("error") if isinstance(completed_turn, dict) else None
                yield {
                    "type": "error",
                    "error": self._error_text(error),
                    "messageId": prompt.message_id,
                }
            usage = self._usage_event()
            yield {
                "type": "step_finish",
                "messageId": prompt.message_id,
                "reason": str(status or "completed"),
                **({"tokens": usage} if usage else {}),
            }
            self._active_turn_id = None
            return

    async def stop(self, *, reason: str) -> bool:
        if not self._session_id or not self._active_turn_id:
            return False
        await self._rpc.request(
            "turn/interrupt",
            {"threadId": self._session_id, "turnId": self._active_turn_id},
        )
        self._log.info("harness.turn_interrupted", harness=self.harness, reason=reason)
        return True

    async def close(self) -> None:
        await self._rpc.close()

    @staticmethod
    def _normalize_model(model: str | None) -> str | None:
        if not model:
            return None
        if "/" not in model:
            return model
        return model.split("/", 1)[1] if model.startswith(("openai/", "deepseek/")) else None

    @staticmethod
    def _app_server_command(environment: Mapping[str, str]) -> list[str]:
        command = ["codex"]
        if uses_deepseek_model(environment):
            base_url = deepseek_relay_url(environment, "openai")
            if not base_url or not environment.get("SANDBOX_AUTH_TOKEN", "").strip():
                raise RuntimeError("DeepSeek Codex sessions require the Host model relay")
            command.extend(
                [
                    "-c",
                    'model_provider="deepseek"',
                    "-c",
                    'model_providers.deepseek.name="DeepSeek via Open-Inspect Host relay"',
                    "-c",
                    f"model_providers.deepseek.base_url={json.dumps(base_url)}",
                    "-c",
                    'model_providers.deepseek.env_key="SANDBOX_AUTH_TOKEN"',
                    "-c",
                    'model_providers.deepseek.wire_api="responses"',
                    "-c",
                    "model_context_window=1000000",
                ]
            )
            command.extend(["app-server", "--stdio", "--strict-config"])
            return command

        base_url = environment.get(_CODEX_BASE_URL_ENV, "").strip().rstrip("/")
        if base_url:
            parsed = urlsplit(base_url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
            ):
                raise ValueError(f"{_CODEX_BASE_URL_ENV} must be an HTTPS URL without userinfo")
            command.extend(["-c", f"openai_base_url={json.dumps(base_url)}"])
        command.extend(["app-server", "--stdio", "--strict-config"])
        return command

    @staticmethod
    def _error_text(error: object) -> str:
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str):
                return message
        return "Codex turn failed"

    @staticmethod
    def _tool_call_event(item: object, message_id: str) -> dict[str, object] | None:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return None
        item_type = item.get("type")
        if item_type == "commandExecution":
            return {
                "type": "tool_call",
                "tool": "shell",
                "args": {"command": item.get("command", ""), "cwd": item.get("cwd", "")},
                "callId": item["id"],
                "status": item.get("status", "inProgress"),
                "messageId": message_id,
            }
        if item_type == "mcpToolCall":
            arguments = item.get("arguments")
            return {
                "type": "tool_call",
                "tool": f"{item.get('server', 'mcp')}/{item.get('tool', 'tool')}",
                "args": arguments if isinstance(arguments, dict) else {"input": arguments},
                "callId": item["id"],
                "status": item.get("status", "inProgress"),
                "messageId": message_id,
            }
        if item_type == "fileChange":
            return {
                "type": "tool_call",
                "tool": "apply_patch",
                "args": {"changes": item.get("changes", [])},
                "callId": item["id"],
                "status": item.get("status", "inProgress"),
                "messageId": message_id,
            }
        return None

    @staticmethod
    def _tool_result_event(item: object, message_id: str) -> dict[str, object] | None:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            return None
        item_type = item.get("type")
        if item_type not in {"commandExecution", "mcpToolCall", "fileChange"}:
            return None
        if item_type == "commandExecution":
            result: object = item.get("aggregatedOutput") or ""
        elif item_type == "mcpToolCall":
            result = item.get("result") or ""
        else:
            result = item.get("changes") or []
        rendered = result if isinstance(result, str) else json.dumps(result, default=str)
        error = item.get("error")
        return {
            "type": "tool_result",
            "callId": item["id"],
            "result": rendered,
            **({"error": json.dumps(error, default=str)} if error else {}),
            "messageId": message_id,
        }

    def _usage_event(self) -> dict[str, object] | None:
        if not self._latest_usage:
            return None
        latest = self._latest_usage.get("last")
        if not isinstance(latest, dict):
            return None
        return {
            "total": latest.get("totalTokens", 0),
            "input": latest.get("inputTokens", 0),
            "output": latest.get("outputTokens", 0),
            "reasoning": latest.get("reasoningOutputTokens", 0),
            "cache": {"read": latest.get("cachedInputTokens", 0)},
        }

    def _thread_config(self) -> dict[str, object]:
        builtin_environment = {
            key: self._environment[key]
            for key in _BUILTIN_MCP_ENV_NAMES
            if self._environment.get(key)
        }
        try:
            session_config = json.loads(self._environment.get("SESSION_CONFIG", "{}"))
        except json.JSONDecodeError:
            session_config = {}
        if isinstance(session_config, dict):
            session_id = session_config.get("session_id") or session_config.get("sessionId")
            if isinstance(session_id, str) and session_id:
                builtin_environment["OPEN_INSPECT_SESSION_ID"] = session_id
        return {
            "shell_environment_policy": {
                "inherit": "all",
                "exclude": list(_SECRET_ENV_NAMES),
            },
            # Keep the session token out of Codex shell commands while granting
            # it only to the built-in platform MCP subprocess. User-configured
            # MCP servers never receive these values.
            "mcp_servers": codex_mcp_config(
                self._mcp_servers,
                builtin_environment,
            ),
        }

    def _drain_notifications(self) -> None:
        while True:
            try:
                self._rpc.notifications.get_nowait()
            except asyncio.QueueEmpty:
                return
