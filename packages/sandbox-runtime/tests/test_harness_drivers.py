from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sandbox_runtime.harness.base import HarnessPrompt
from sandbox_runtime.harness.claude import ClaudeHarnessDriver
from sandbox_runtime.harness.codex import CodexHarnessDriver


class Log:
    def info(self, *_args, **_kwargs):
        pass

    def warn(self, *_args, **_kwargs):
        pass


class FakeRpc:
    def __init__(self):
        import asyncio

        self.notifications = asyncio.Queue()
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications_sent: list[str] = []

    async def start(self):
        pass

    async def notify(self, method, _params=None):
        self.notifications_sent.append(method)

    async def request(self, method, params):
        self.requests.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "thread/resume":
            return {"thread": {"id": params["threadId"]}}
        if method == "turn/start":
            await self.notifications.put(
                {
                    "method": "item/agentMessage/delta",
                    "params": {"threadId": "thread-1", "turnId": "turn-1", "delta": "hello"},
                }
            )
            await self.notifications.put(
                {
                    "method": "item/started",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "item": {
                            "id": "call-1",
                            "type": "commandExecution",
                            "command": "pwd",
                            "cwd": "/workspace",
                            "status": "inProgress",
                        },
                    },
                }
            )
            await self.notifications.put(
                {
                    "method": "turn/completed",
                    "params": {
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "turn": {"id": "turn-1", "status": "completed", "items": []},
                    },
                }
            )
            return {"turn": {"id": "turn-1"}}
        return {}

    async def close(self):
        pass


async def test_codex_driver_translates_app_server_notifications():
    rpc = FakeRpc()
    driver = CodexHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        rpc=rpc,
        mcp_servers=(
            {
                "name": "docs search",
                "type": "remote",
                "url": "https://mcp.example.test/mcp",
                "headers": {"X-Key": "secret"},
            },
        ),
    )
    assert await driver.start() == "thread-1"

    events = [
        event
        async for event in driver.stream_prompt(
            HarnessPrompt(message_id="message-1", content="hello", model="openai/gpt-5.6")
        )
    ]

    assert rpc.notifications_sent == ["initialized"]
    assert events[0] == {"type": "token", "content": "hello", "messageId": "message-1"}
    assert events[1]["type"] == "tool_call"
    assert events[-1]["type"] == "step_finish"
    turn_request = next(params for method, params in rpc.requests if method == "turn/start")
    assert turn_request["model"] == "gpt-5.6"
    thread_request = next(params for method, params in rpc.requests if method == "thread/start")
    assert thread_request["config"]["mcp_servers"]["open_inspect"]["args"] == [
        "-m",
        "sandbox_runtime.native_mcp",
    ]
    assert thread_request["config"]["mcp_servers"]["docs_search"] == {
        "url": "https://mcp.example.test/mcp",
        "http_headers": {"X-Key": "secret"},
    }


@dataclass
class StreamEvent:
    event: dict[str, Any]


@dataclass
class ResultMessage:
    session_id: str
    is_error: bool = False
    result: str | None = None
    usage: dict[str, int] | None = None
    total_cost_usd: float | None = None


@dataclass
class ToolResultBlock:
    tool_use_id: str
    content: str
    is_error: bool = False


@dataclass
class UserMessage:
    content: list[Any]


class Options:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


async def fake_claude_query(*, prompt, options):
    assert prompt == "hello"
    assert options.kwargs["permission_mode"] == "bypassPermissions"
    assert options.kwargs["mcp_servers"]["open_inspect"]["command"] == "python"
    yield StreamEvent(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}}
    )
    yield UserMessage([ToolResultBlock(tool_use_id="call-1", content="done")])
    yield ResultMessage(
        session_id="claude-session",
        usage={"input_tokens": 2, "output_tokens": 3},
        total_cost_usd=0.01,
    )


async def test_claude_driver_uses_setup_token_environment_and_persists_session():
    driver = ClaudeHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment={"CLAUDE_CODE_OAUTH_TOKEN": "setup-token"},
        query_function=fake_claude_query,
        options_class=Options,
    )
    await driver.start()

    events = [
        event
        async for event in driver.stream_prompt(
            HarnessPrompt(
                message_id="message-1",
                content="hello",
                model="anthropic/claude-sonnet-5",
                reasoning_effort="high",
            )
        )
    ]

    assert driver.session_id == "claude-session"
    assert events[0] == {"type": "token", "content": "hi", "messageId": "message-1"}
    assert events[1] == {
        "type": "tool_result",
        "callId": "call-1",
        "result": "done",
        "messageId": "message-1",
    }
    assert events[-1]["tokens"] == {
        "total": 5,
        "input": 2,
        "output": 3,
        "cache": {"read": 0, "write": 0},
    }


def test_native_drivers_ignore_models_owned_by_the_other_provider():
    assert CodexHarnessDriver._normalize_model("anthropic/claude-sonnet-5") is None
    assert ClaudeHarnessDriver._normalize_model("openai/gpt-5.6") is None


async def test_claude_driver_falls_back_when_persisted_session_is_stale():
    attempts: list[str | None] = []

    async def query_with_stale_resume(*, prompt, options):
        del prompt
        attempts.append(options.kwargs.get("resume"))
        if options.kwargs.get("resume"):
            raise RuntimeError("session not found")
        yield ResultMessage(session_id="new-session")

    driver = ClaudeHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        query_function=query_with_stale_resume,
        options_class=Options,
    )
    await driver.start("stale-session")

    events = [
        event
        async for event in driver.stream_prompt(
            HarnessPrompt(message_id="message-1", content="continue")
        )
    ]

    assert attempts == ["stale-session", None]
    assert driver.session_id == "new-session"
    assert events[-1]["type"] == "step_finish"
