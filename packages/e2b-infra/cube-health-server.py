#!/usr/bin/env python3
"""Minimal Cube template liveness endpoint.

Cube's hard template probe must observe the container itself, not an optional
code-interpreter sidecar. The Open-Inspect supervisor remains PID 1's foreground
workload, so the container still terminates when the actual runtime exits.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_CUBE_HEALTH_PORT = 49999


class HealthHandler(BaseHTTPRequestHandler):
    """Serve only the non-sensitive liveness response used by Cube."""

    server_version = "OpenInspectHealth/1"
    sys_version = ""

    def do_GET(self) -> None:
        if self.path.rstrip("/") != "/health":
            self.send_error(404)
            return

        body = json.dumps({"status": "ok"}, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    port = int(os.environ.get("OI_CUBE_HEALTH_PORT", DEFAULT_CUBE_HEALTH_PORT))
    server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
