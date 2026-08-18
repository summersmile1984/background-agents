"""Lifecycle tests for the native harness JSON-RPC transport."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness.json_rpc import JsonRpcProcess

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.asyncio
async def test_close_allows_server_to_exit_on_stdin_eof(tmp_path: Path) -> None:
    rpc = JsonRpcProcess(
        [
            sys.executable,
            "-c",
            "import sys; [None for _ in sys.stdin]",
        ],
        cwd=str(tmp_path),
        env={},
        log=MagicMock(),
    )

    await rpc.start()
    await rpc.close()


@pytest.mark.asyncio
async def test_request_accepts_bare_stream_events_and_sends_json_rpc_version(
    tmp_path: Path,
) -> None:
    script = """
import json
import sys
request = json.loads(sys.stdin.readline())
print(json.dumps({"type": "response_delta", "delta": "hello"}), flush=True)
print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {
    "status": "accepted", "received_jsonrpc": request.get("jsonrpc")
}}), flush=True)
for _line in sys.stdin:
    pass
"""
    rpc = JsonRpcProcess(
        [sys.executable, "-c", script],
        cwd=str(tmp_path),
        env={},
        log=MagicMock(),
    )

    await rpc.start()
    result = await rpc.request("thread/message", {"thread_id": "thread-1", "input": "hi"})
    event = await rpc.notifications.get()
    await rpc.close()

    assert result == {"status": "accepted", "received_jsonrpc": "2.0"}
    assert event == {"type": "response_delta", "delta": "hello"}

    await rpc.start()
    await rpc.close()
