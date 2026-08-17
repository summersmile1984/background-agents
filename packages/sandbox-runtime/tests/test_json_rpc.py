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

    await rpc.start()
    await rpc.close()
