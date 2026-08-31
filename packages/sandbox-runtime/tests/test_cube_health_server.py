"""Tests for the Cube template's first-party lifecycle probe."""

from __future__ import annotations

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

_HEALTH_SERVER = Path(__file__).resolve().parents[2] / "e2b-infra" / "cube-health-server.py"


def _load_health_server_module():
    spec = importlib.util.spec_from_file_location("oi_cube_health_server", _HEALTH_SERVER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cube_health_endpoint_is_minimal_and_non_sensitive() -> None:
    module = _load_health_server_module()
    server = module.ThreadingHTTPServer(("127.0.0.1", 0), module.HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        host, port = server.server_address
        with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=2) as response:
            assert response.status == 200
            assert response.headers["Content-Type"] == "application/json"
            assert json.load(response) == {"status": "ok"}

        try:
            urllib.request.urlopen(f"http://{host}:{port}/anything-else", timeout=2)
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError("unexpected non-health endpoint success")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
