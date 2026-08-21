"""Claude Agent SDK driver with disk-backed session resume."""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from ..deepseek_relay import deepseek_relay_url, session_model, uses_deepseek_model
from ..types import AgentHarness
from .mcp_config import claude_mcp_config

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from .base import HarnessPrompt


class ClaudeHarnessDriver:
    harness = AgentHarness.CLAUDE

    _AUTONOMOUS_TOOLS: ClassVar[tuple[str, ...]] = (
        "Bash",
        "Edit",
        "Glob",
        "Grep",
        "NotebookEdit",
        "Read",
        "Task",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
        "Write",
        "mcp__open_inspect__*",
    )

    def __init__(
        self,
        *,
        workspace_path: str,
        log: Any,
        environment: Mapping[str, str] | None = None,
        mcp_servers: tuple[Mapping[str, Any], ...] = (),
        query_function: Any | None = None,
        options_class: Any | None = None,
    ) -> None:
        self._workspace_path = workspace_path
        self._log = log
        self._environment = dict(environment or os.environ)
        if uses_deepseek_model(self._environment):
            relay_url = deepseek_relay_url(self._environment, "anthropic")
            sandbox_token = self._environment.get("SANDBOX_AUTH_TOKEN", "").strip()
            if not relay_url or not sandbox_token:
                raise RuntimeError("DeepSeek Claude Code sessions require the Host model relay")
            model = session_model(self._environment).removeprefix("deepseek/")
            for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
                self._environment.pop(key, None)
            self._environment.update(
                {
                    "ANTHROPIC_BASE_URL": relay_url,
                    "ANTHROPIC_AUTH_TOKEN": sandbox_token,
                    "ANTHROPIC_MODEL": model,
                    "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
                    "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
                    "CLAUDE_CODE_SUBAGENT_MODEL": model,
                }
            )
        self._mcp_servers = mcp_servers
        self._query_function = query_function
        self._options_class = options_class
        self._session_id: str | None = None
        self._active_stream: Any | None = None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    async def start(self, existing_session_id: str | None = None) -> str | None:
        self._load_sdk()
        self._session_id = existing_session_id
        return self._session_id

    async def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]:
        self._load_sdk()
        options = self._build_options(prompt)
        prompt_text = self._materialize_attachments(prompt)
        stream = self._query_function(prompt=prompt_text, options=options)
        self._active_stream = stream
        emitted_text = False
        emitted_output = False
        try:
            async for message in stream:
                class_name = type(message).__name__
                if class_name == "StreamEvent":
                    event = getattr(message, "event", None)
                    delta = self._stream_text_delta(event)
                    if delta:
                        emitted_text = True
                        emitted_output = True
                        yield {
                            "type": "token",
                            "content": delta,
                            "messageId": prompt.message_id,
                        }
                    continue
                if class_name == "AssistantMessage":
                    async for event in self._assistant_events(
                        message, prompt.message_id, emit_text=not emitted_text
                    ):
                        if event.get("type") == "token":
                            emitted_text = True
                        emitted_output = True
                        yield event
                    continue
                if class_name == "UserMessage":
                    async for event in self._assistant_events(
                        message, prompt.message_id, emit_text=False
                    ):
                        emitted_output = True
                        yield event
                    continue
                if class_name != "ResultMessage":
                    continue
                session_id = getattr(message, "session_id", None)
                if isinstance(session_id, str) and session_id:
                    self._session_id = session_id
                is_error = bool(getattr(message, "is_error", False))
                if is_error:
                    result = getattr(message, "result", None)
                    emitted_output = True
                    yield {
                        "type": "error",
                        "error": str(result or "Claude Code execution failed"),
                        "messageId": prompt.message_id,
                    }
                usage = self._usage(getattr(message, "usage", None))
                cost = getattr(message, "total_cost_usd", None)
                emitted_output = True
                yield {
                    "type": "step_finish",
                    "messageId": prompt.message_id,
                    "reason": "error" if is_error else "completed",
                    **({"tokens": usage} if usage else {}),
                    **({"cost": float(cost)} if isinstance(cost, int | float) else {}),
                }
        except Exception as error:
            if self._session_id and not emitted_output:
                stale_session_id = self._session_id
                self._session_id = None
                self._log.warn(
                    "harness.session_resume_failed",
                    harness=self.harness,
                    session_id=stale_session_id,
                    exc=error,
                )
                async for event in self.stream_prompt(prompt):
                    yield event
                return
            raise
        finally:
            self._active_stream = None

    async def stop(self, *, reason: str) -> bool:
        stream = self._active_stream
        aclose = getattr(stream, "aclose", None)
        if not aclose:
            return False
        await aclose()
        self._log.info("harness.turn_interrupted", harness=self.harness, reason=reason)
        return True

    async def close(self) -> None:
        await self.stop(reason="driver_close")

    def _load_sdk(self) -> None:
        if self._query_function is not None and self._options_class is not None:
            return
        try:
            from claude_agent_sdk import ClaudeAgentOptions, query
        except ImportError as error:
            raise RuntimeError("Claude Agent SDK is not installed in the sandbox image") from error
        self._query_function = query
        self._options_class = ClaudeAgentOptions

    def _build_options(self, prompt: HarnessPrompt) -> Any:
        supported_efforts = {"low", "medium", "high", "xhigh", "max"}
        if prompt.reasoning_effort is not None and prompt.reasoning_effort not in supported_efforts:
            raise ValueError(f"Unsupported Claude reasoning effort: {prompt.reasoning_effort}")
        kwargs: dict[str, Any] = {
            "cwd": self._workspace_path,
            "permission_mode": "acceptEdits",
            "allowed_tools": list(self._AUTONOMOUS_TOOLS),
            "include_partial_messages": not uses_deepseek_model(self._environment),
            "system_prompt": {"type": "preset", "preset": "claude_code"},
            "env": self._environment,
            "mcp_servers": claude_mcp_config(self._mcp_servers),
        }
        system_prompt_append = self._environment.get(
            "OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND", ""
        ).strip()
        if system_prompt_append:
            kwargs["system_prompt"]["append"] = system_prompt_append
        if self._session_id:
            kwargs["resume"] = self._session_id
        model = self._normalize_model(prompt.model)
        if model:
            kwargs["model"] = model
        if prompt.reasoning_effort in supported_efforts:
            kwargs["effort"] = prompt.reasoning_effort
        return self._options_class(**kwargs)

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
        return model.split("/", 1)[1] if model.startswith(("anthropic/", "deepseek/")) else None

    @staticmethod
    def _stream_text_delta(event: object) -> str | None:
        if not isinstance(event, dict):
            return None
        if event.get("type") == "content_block_start":
            content_block = event.get("content_block")
            if not isinstance(content_block, dict) or content_block.get("type") != "text":
                return None
            text = content_block.get("text")
            return text if isinstance(text, str) and text else None
        if event.get("type") != "content_block_delta":
            return None
        delta = event.get("delta")
        if not isinstance(delta, dict) or delta.get("type") != "text_delta":
            return None
        text = delta.get("text")
        return text if isinstance(text, str) and text else None

    @staticmethod
    async def _assistant_events(
        message: object, message_id: str, *, emit_text: bool
    ) -> AsyncIterator[dict[str, object]]:
        content = getattr(message, "content", None)
        if not isinstance(content, list):
            return
        for block in content:
            class_name = type(block).__name__
            if class_name == "TextBlock" and emit_text:
                text = getattr(block, "text", None)
                if isinstance(text, str) and text:
                    yield {"type": "token", "content": text, "messageId": message_id}
            elif class_name in {"ToolUseBlock", "ServerToolUseBlock"}:
                tool_input = getattr(block, "input", {})
                yield {
                    "type": "tool_call",
                    "tool": str(getattr(block, "name", "tool")),
                    "args": tool_input if isinstance(tool_input, dict) else {"input": tool_input},
                    "callId": str(getattr(block, "id", "")),
                    "status": "completed",
                    "messageId": message_id,
                }
            elif class_name in {"ToolResultBlock", "ServerToolResultBlock"}:
                content = getattr(block, "content", "")
                rendered = content if isinstance(content, str) else json.dumps(content, default=str)
                is_error = bool(getattr(block, "is_error", False))
                yield {
                    "type": "tool_result",
                    "callId": str(getattr(block, "tool_use_id", "")),
                    "result": rendered,
                    **({"error": rendered} if is_error else {}),
                    "messageId": message_id,
                }

    @staticmethod
    def _usage(value: object) -> dict[str, object] | None:
        if not isinstance(value, dict):
            return None
        input_tokens = value.get("input_tokens")
        output_tokens = value.get("output_tokens")
        cache_read = value.get("cache_read_input_tokens")
        cache_write = value.get("cache_creation_input_tokens")
        numeric = [item for item in (input_tokens, output_tokens) if isinstance(item, int | float)]
        if (
            not numeric
            and not isinstance(cache_read, int | float)
            and not isinstance(cache_write, int | float)
        ):
            return None
        return {
            "total": sum(numeric),
            "input": input_tokens or 0,
            "output": output_tokens or 0,
            "cache": {"read": cache_read or 0, "write": cache_write or 0},
        }
