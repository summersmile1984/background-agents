from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sandbox_runtime.harness.base import (
    VISUAL_VERIFICATION_SYSTEM_INSTRUCTION,
    HarnessPrompt,
)
from sandbox_runtime.harness.claude import ClaudeHarnessDriver
from sandbox_runtime.harness.codex import CodexHarnessDriver
from sandbox_runtime.harness.deepseek import DeepSeekHarnessDriver


class Log:
    def info(self, *_args, **_kwargs):
        pass

    def warn(self, *_args, **_kwargs):
        pass


def deepseek_environment(model: str = "deepseek/deepseek-v4-flash") -> dict[str, str]:
    return {
        "CODEX_OPENAI_BASE_URL": "https://relay.example.test",
        "SANDBOX_AUTH_TOKEN": "sandbox-token",
        "SESSION_CONFIG": json.dumps({"session_id": "session-1", "model": model}),
    }


def visual_policy() -> str:
    return json.dumps(
        {
            "enabled": True,
            "trigger": "explicit_only",
            "maxScenarios": 3,
            "maxCaptures": 4,
            "timeoutMs": 120000,
            "maxUploadBytes": 10485760,
            "allowedServiceNames": [],
            "allowRepositoryDeclaration": False,
            "allowVideo": False,
            "completionBehavior": "report_only",
        }
    )


def test_visual_verification_instruction_defers_to_platform_runner() -> None:
    assert "runs automatically after your response" in VISUAL_VERIFICATION_SYSTEM_INSTRUCTION
    assert "Do not invoke `oi-visual-verify`" in VISUAL_VERIFICATION_SYSTEM_INSTRUCTION


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
                    "method": "item/agentMessage/delta",
                    "params": {"threadId": "thread-1", "turnId": "turn-1", "delta": " world"},
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
        environment={
            "CONTROL_PLANE_URL": "https://control.example.test",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": '{"session_id":"session-1"}',
        },
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
            HarnessPrompt(
                message_id="message-1",
                content="hello",
                model="openai/gpt-5.6",
                reasoning_effort="xhigh",
            )
        )
    ]

    assert rpc.notifications_sent == ["initialized"]
    assert events[0] == {"type": "token", "content": "hello", "messageId": "message-1"}
    assert events[1] == {
        "type": "token",
        "content": "hello world",
        "messageId": "message-1",
    }
    assert events[2]["type"] == "tool_call"
    assert events[-1]["type"] == "step_finish"
    turn_request = next(params for method, params in rpc.requests if method == "turn/start")
    assert turn_request["model"] == "gpt-5.6"
    assert turn_request["effort"] == "xhigh"
    thread_request = next(params for method, params in rpc.requests if method == "thread/start")
    assert thread_request["config"]["mcp_servers"]["open_inspect"]["args"] == [
        "-m",
        "sandbox_runtime.native_mcp",
    ]
    assert thread_request["config"]["mcp_servers"]["open_inspect"]["env"] == {
        "CONTROL_PLANE_URL": "https://control.example.test",
        "OPEN_INSPECT_SESSION_ID": "session-1",
        "SANDBOX_AUTH_TOKEN": "sandbox-token",
    }
    assert thread_request["config"]["mcp_servers"]["docs_search"] == {
        "url": "https://mcp.example.test/mcp",
        "http_headers": {"X-Key": "secret"},
    }
    assert (
        "CODEX_OPENAI_BASE_URL" in thread_request["config"]["shell_environment_policy"]["exclude"]
    )
    assert "SANDBOX_AUTH_TOKEN" in thread_request["config"]["shell_environment_policy"]["exclude"]


async def test_codex_driver_sends_visual_instruction_without_model_prefix_leakage():
    rpc = FakeRpc()
    driver = CodexHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment={"OPENINSPECT_VISUAL_VERIFICATION_POLICY": visual_policy()},
        rpc=rpc,
    )

    await driver.start()
    async for _event in driver.stream_prompt(
        HarnessPrompt(message_id="message-1", content="hello", model="openai/gpt-5.6")
    ):
        pass

    thread_request = next(params for method, params in rpc.requests if method == "thread/start")
    turn_request = next(params for method, params in rpc.requests if method == "turn/start")
    assert thread_request["developerInstructions"] == VISUAL_VERIFICATION_SYSTEM_INSTRUCTION
    assert turn_request["model"] == "gpt-5.6"


def test_codex_driver_configures_https_model_relay():
    driver = CodexHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment={"CODEX_OPENAI_BASE_URL": "https://codex-relay.example.test/relay/"},
    )

    assert driver._rpc._command == [
        "codex",
        "-c",
        'openai_base_url="https://codex-relay.example.test/relay"',
        "app-server",
        "--stdio",
        "--strict-config",
    ]


def test_codex_driver_rejects_insecure_model_relay():
    try:
        CodexHarnessDriver(
            workspace_path="/workspace",
            log=Log(),
            environment={"CODEX_OPENAI_BASE_URL": "http://relay.example.test"},
        )
    except ValueError as error:
        assert "must be an HTTPS URL" in str(error)
    else:
        raise AssertionError("insecure Codex relay URL was accepted")


def test_codex_driver_uses_deepseek_responses_relay_without_provider_key():
    environment = deepseek_environment()
    environment["DEEPSEEK_API_KEY"] = "must-stay-on-host"
    driver = CodexHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment=environment,
    )

    command = driver._rpc._command
    assert 'model_provider="deepseek"' in command
    assert (
        'model_providers.deepseek.base_url="https://relay.example.test/sessions/session-1/'
        'deepseek/openai"'
    ) in command
    assert 'model_providers.deepseek.env_key="SANDBOX_AUTH_TOKEN"' in command
    assert "must-stay-on-host" not in repr(command)


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
    assert options.kwargs["permission_mode"] == "acceptEdits"
    assert "Bash" in options.kwargs["allowed_tools"]
    assert "mcp__open_inspect__*" in options.kwargs["allowed_tools"]
    assert options.kwargs["mcp_servers"]["open_inspect"]["command"] == "python"
    yield StreamEvent(
        {
            "type": "content_block_start",
            "content_block": {"type": "text", "text": "h"},
        }
    )
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
    assert events[0] == {"type": "token", "content": "h", "messageId": "message-1"}
    assert events[1] == {"type": "token", "content": "hi", "messageId": "message-1"}
    assert events[2] == {
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


def test_claude_driver_uses_anthropic_relay_with_sandbox_token():
    environment = deepseek_environment()
    environment["CLAUDE_CODE_OAUTH_TOKEN"] = "must-not-be-used"
    driver = ClaudeHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment=environment,
        query_function=fake_claude_query,
        options_class=Options,
    )

    assert driver._environment["ANTHROPIC_BASE_URL"] == (
        "https://relay.example.test/sessions/session-1/deepseek/anthropic"
    )
    assert driver._environment["ANTHROPIC_AUTH_TOKEN"] == "sandbox-token"
    assert driver._environment["ANTHROPIC_MODEL"] == "deepseek-v4-flash"
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in driver._environment
    options = driver._build_options(
        HarnessPrompt(
            message_id="message-1",
            content="hello",
            model="deepseek/deepseek-v4-flash",
        )
    )
    assert options.kwargs["include_partial_messages"] is False


def test_claude_driver_forwards_validated_system_prompt_setting():
    driver = ClaudeHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment={
            "CLAUDE_CODE_OAUTH_TOKEN": "setup-token",
            "OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND": "Follow repository conventions.",
        },
        query_function=fake_claude_query,
        options_class=Options,
    )

    options = driver._build_options(
        HarnessPrompt(
            message_id="message-1",
            content="hello",
            model="anthropic/claude-sonnet-5",
            reasoning_effort="high",
        )
    )

    assert options.kwargs["system_prompt"] == {
        "type": "preset",
        "preset": "claude_code",
        "append": "Follow repository conventions.",
    }
    assert options.kwargs["effort"] == "high"


def test_claude_driver_merges_visual_instruction_with_user_setting():
    driver = ClaudeHarnessDriver(
        workspace_path="/workspace",
        log=Log(),
        environment={
            "CLAUDE_CODE_OAUTH_TOKEN": "setup-token",
            "OI_HARNESS_SETTING_SYSTEM_PROMPT_APPEND": "Follow repository conventions.",
            "OPENINSPECT_VISUAL_VERIFICATION_POLICY": visual_policy(),
        },
        query_function=fake_claude_query,
        options_class=Options,
    )

    options = driver._build_options(HarnessPrompt(message_id="message-1", content="hello"))

    assert options.kwargs["system_prompt"]["append"] == (
        "Follow repository conventions.\n\n" + VISUAL_VERIFICATION_SYSTEM_INSTRUCTION
    )


class FakeCodeWhaleRpc:
    def __init__(self, *, include_stale_response: bool = False):
        import asyncio

        self.notifications = asyncio.Queue()
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.closed = False
        self.include_stale_response = include_stale_response

    async def start(self):
        pass

    async def request(self, method, params):
        self.requests.append((method, params))
        if method == "capabilities":
            return {
                "methods": [
                    "thread/start",
                    "thread/resume",
                    "thread/message",
                    "thread/interrupt",
                ]
            }
        if method == "thread/start":
            return {"thread_id": "codewhale-thread", "status": "ok"}
        if method == "thread/resume":
            return {"thread_id": params["thread_id"], "status": "ok"}
        if method == "thread/message":
            if self.include_stale_response:
                await self.notifications.put(
                    {"type": "response_delta", "response_id": "stale-response", "delta": "old"}
                )
                await self.notifications.put(
                    {"type": "response_end", "response_id": "stale-response"}
                )
            await self.notifications.put({"type": "response_start", "response_id": "response-1"})
            await self.notifications.put(
                {"type": "response_delta", "response_id": "response-1", "delta": "H"}
            )
            await self.notifications.put(
                {
                    "type": "response_delta",
                    "response_id": "response-1",
                    "delta": "ARNESS_OK: deepseek",
                }
            )
            await self.notifications.put({"type": "response_end", "response_id": "response-1"})
            return {"thread_id": params["thread_id"], "status": "accepted"}
        if method == "thread/interrupt":
            return {"interrupted": True}
        if method == "shutdown":
            return {"status": "stopped"}
        return {}

    async def close(self):
        self.closed = True


async def test_deepseek_driver_translates_codewhale_events_and_persists_state(tmp_path):
    rpc = FakeCodeWhaleRpc(include_stale_response=True)
    mcp_path = tmp_path / "memory" / "mcp.json"
    state_path = tmp_path / "state"
    driver = DeepSeekHarnessDriver(
        workspace_path="/workspace",
        state_path=state_path,
        log=Log(),
        environment={**deepseek_environment(), "DEEPSEEK_API_KEY": "must-stay-on-host"},
        mcp_servers=(
            {
                "name": "docs search",
                "type": "remote",
                "url": "https://mcp.example.test/mcp",
            },
        ),
        mcp_config_path=mcp_path,
        rpc=rpc,
    )
    assert await driver.start() is None
    driver._stale_response_ids.add("stale-response")

    events = [
        event
        async for event in driver.stream_prompt(
            HarnessPrompt(
                message_id="message-1",
                content="hello",
                model="deepseek/deepseek-v4-pro",
            )
        )
    ]

    assert driver.session_id == "codewhale-thread"
    assert events == [
        {"type": "token", "content": "H", "messageId": "message-1"},
        {
            "type": "token",
            "content": "HARNESS_OK: deepseek",
            "messageId": "message-1",
        },
        {"type": "step_finish", "messageId": "message-1", "reason": "accepted"},
    ]
    thread_request = next(params for method, params in rpc.requests if method == "thread/start")
    assert thread_request == {
        "cwd": "/workspace",
        "model_provider": "deepseek",
        "persist_extended_history": True,
        "model": "deepseek-v4-pro",
    }
    assert json.loads(mcp_path.read_text())["servers"]["docs_search"] == {
        "url": "https://mcp.example.test/mcp"
    }
    assert state_path.is_dir()
    assert "DEEPSEEK_API_KEY" not in driver._environment
    assert "DEEPSEEK_BASE_URL" not in driver._environment
    assert "CODEWHALE_BASE_URL" not in driver._environment
    config = driver._config_path.read_text()
    assert "[providers.deepseek]" in config
    assert 'api_key_env = "SANDBOX_AUTH_TOKEN"' in config
    assert 'base_url = "https://relay.example.test/sessions/session-1/deepseek/openai"' in config
    assert "sandbox-token" not in config
    assert "must-stay-on-host" not in driver._environment.values()
    await driver.close()
    assert rpc.closed


async def test_deepseek_driver_binds_session_token_to_custom_endpoint(tmp_path):
    driver = DeepSeekHarnessDriver(
        workspace_path="/workspace",
        state_path=tmp_path / "state",
        log=Log(),
        environment=deepseek_environment(),
        mcp_config_path=tmp_path / "mcp.json",
    )

    command = driver._rpc._command
    assert command[:2] == ["codewhale", "app-server"]
    assert command[command.index("--config") + 1] == str(driver._config_path)
    assert "--api-key" not in command
    assert "sandbox-token" not in command
    assert "must-stay-on-host" not in command
    await driver.close()


async def test_deepseek_driver_prepends_bounded_visual_instruction(tmp_path):
    rpc = FakeCodeWhaleRpc()
    environment = deepseek_environment()
    environment["OPENINSPECT_VISUAL_VERIFICATION_POLICY"] = visual_policy()
    driver = DeepSeekHarnessDriver(
        workspace_path="/workspace",
        state_path=tmp_path / "state",
        log=Log(),
        environment=environment,
        mcp_config_path=tmp_path / "mcp.json",
        rpc=rpc,
    )

    async for _event in driver.stream_prompt(
        HarnessPrompt(
            message_id="message-1",
            content="hello",
            model="deepseek/deepseek-v4-flash",
        )
    ):
        pass

    message_request = next(params for method, params in rpc.requests if method == "thread/message")
    assert message_request["input"] == (
        "<open-inspect-platform>\n"
        + VISUAL_VERIFICATION_SYSTEM_INSTRUCTION
        + "\n</open-inspect-platform>\n\nhello"
    )
    thread_request = next(params for method, params in rpc.requests if method == "thread/start")
    assert thread_request["model"] == "deepseek-v4-flash"


def test_native_drivers_ignore_models_owned_by_the_other_provider():
    assert CodexHarnessDriver._normalize_model("anthropic/claude-sonnet-5") is None
    assert ClaudeHarnessDriver._normalize_model("openai/gpt-5.6") is None
    assert DeepSeekHarnessDriver._normalize_model("openai/gpt-5.6") is None
    assert CodexHarnessDriver._normalize_model("deepseek/deepseek-v4-flash") == (
        "deepseek-v4-flash"
    )
    assert ClaudeHarnessDriver._normalize_model("deepseek/deepseek-v4-flash") == (
        "deepseek-v4-flash"
    )


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
