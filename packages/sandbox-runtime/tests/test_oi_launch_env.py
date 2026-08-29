from __future__ import annotations

import runpy
from pathlib import Path

_LAUNCHER = Path(__file__).resolve().parents[2] / "e2b-infra" / "oi-launch.py"
_MODULE = runpy.run_path(str(_LAUNCHER), run_name="oi_launch_test")
_restore_chunked_env = _MODULE["_restore_chunked_env"]
_chunk_prefix = _MODULE["CREATE_TIME_ENV_CHUNK_PREFIX"]
_chunked_marker = _MODULE["CREATE_TIME_ENV_CHUNKED_MARKER"]


def test_restore_chunked_env_reassembles_values_and_removes_transport_keys() -> None:
    environment = {
        _chunked_marker: "1",
        f"{_chunk_prefix}434f4445585f415554485f4a534f4e_1": "🙂tail",
        f"{_chunk_prefix}434f4445585f415554485f4a534f4e_0": "head",
        "SMALL": "value",
    }

    _restore_chunked_env(environment)

    assert environment == {"CODEX_AUTH_JSON": "head🙂tail", "SMALL": "value"}


def test_restore_chunked_env_fails_closed_on_missing_chunk() -> None:
    environment = {
        _chunked_marker: "1",
        f"{_chunk_prefix}4b4559_1": "tail",
    }

    try:
        _restore_chunked_env(environment)
    except ValueError as error:
        assert "incomplete split environment value" in str(error)
    else:
        raise AssertionError("missing split environment chunk was accepted")
