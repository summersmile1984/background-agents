import json
from unittest.mock import AsyncMock, MagicMock, patch

from tests.runtime_helpers import make_opencode_server


async def test_opencode_uses_host_relay_with_the_session_token(tmp_path):
    environment = {
        "SANDBOX_ID": "sandbox-1",
        "SANDBOX_AUTH_TOKEN": "sandbox-token",
        "CODEX_OPENAI_BASE_URL": "https://relay.example.test",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
        "SESSION_CONFIG": json.dumps(
            {
                "session_id": "session-1",
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "agent_harness": "opencode",
            }
        ),
    }
    server = make_opencode_server(environment, workspace_path=tmp_path)
    process = MagicMock(stdout=None)
    create_process = AsyncMock(return_value=process)

    with (
        patch.dict("os.environ", environment, clear=True),
        patch("sandbox_runtime.opencode_server.asyncio.create_subprocess_exec", create_process),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coroutine: coroutine.close(),
        ),
    ):
        server._setup_managed_oauth = MagicMock()
        server._resolve_mcp_servers = MagicMock(return_value=[])
        server._prepare_opencode_filesystem = MagicMock(return_value=set())
        server._wait_for_health = AsyncMock()

        await server.start((), tmp_path)

    child_environment = create_process.await_args.kwargs["env"]
    config = json.loads(child_environment["OPENCODE_CONFIG_CONTENT"])
    deepseek = config["provider"]["deepseek"]
    assert deepseek["options"] == {
        "baseURL": "https://relay.example.test/sessions/session-1/deepseek/openai",
        "apiKey": "sandbox-token",
    }
    assert "DEEPSEEK_API_KEY" not in child_environment
