from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from sandbox_runtime.agent_bridge_process import AgentBridgeProcess
from sandbox_runtime.types import AgentHarness


class _Log:
    def info(self, *_args, **_kwargs):
        pass

    def warn(self, *_args, **_kwargs):
        pass

    def error(self, *_args, **_kwargs):
        pass


async def test_deepseek_provider_key_is_never_restored_for_bridge_child(monkeypatch):
    config = SimpleNamespace(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.test",
        sandbox_token="sandbox-token",
        session_id="session-1",
        agent_harness=AgentHarness.DEEPSEEK,
        agent_session_id=None,
    )
    process = SimpleNamespace(returncode=None, stdout=None)
    create_process = AsyncMock(return_value=process)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "must-not-enter-child")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "sandbox-token")
    monkeypatch.setenv(
        "SESSION_CONFIG",
        '{"session_id":"session-1","model":"deepseek/deepseek-v4-flash"}',
    )
    monkeypatch.setattr(
        "sandbox_runtime.agent_bridge_process.asyncio.create_subprocess_exec", create_process
    )
    monkeypatch.setattr("sandbox_runtime.agent_bridge_process.asyncio.sleep", AsyncMock())

    await AgentBridgeProcess(config, _Log()).start()

    child_environment = create_process.await_args.kwargs["env"]
    assert "DEEPSEEK_API_KEY" not in child_environment
    assert child_environment["SANDBOX_AUTH_TOKEN"] == "sandbox-token"
    assert create_process.await_args.args[-1] == "deepseek"
