"""Deterministic loopback-only fixture for sandbox visual verification tests."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_STYLE = """
  :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f6fb; color: #172033; }
  header { background: #18233a; color: white; padding: 18px 24px; }
  main { width: min(980px, calc(100% - 32px)); margin: 28px auto; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .card { min-height: 130px; padding: 18px; border: 1px solid #cbd5e1; border-radius: 14px;
          background: white; box-shadow: 0 8px 24px rgb(15 23 42 / 8%); }
  .status { display: inline-block; padding: 4px 10px; border-radius: 999px;
            background: #dcfce7; color: #166534; font-weight: 700; }
  @media (max-width: 640px) {
    header { padding: 14px 16px; }
    main { width: min(100% - 24px, 980px); margin-top: 16px; }
    .grid { grid-template-columns: 1fr; }
  }
"""


def page(title: str, body: str, *, script: str = "") -> bytes:
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title><style>{BASE_STYLE}</style></head>"
        f"<body><header>Open-Inspect fixture</header>{body}{script}</body></html>"
    ).encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send(200, b"ok", "text/plain; charset=utf-8")
            return
        if self.path == "/":
            self._send(
                200,
                page(
                    "Dashboard",
                    """
                    <main data-testid="app-ready">
                      <span class="status">Ready</span>
                      <h1>Visual verification dashboard</h1>
                      <div class="grid">
                        <section class="card">Deterministic content</section>
                        <section class="card">Desktop and mobile</section>
                        <section class="card">Prompt-scoped artifacts</section>
                      </div>
                    </main>
                    """,
                ),
            )
            return
        if self.path == "/loading":
            self._send(
                200,
                page(
                    "Loading",
                    '<main><p id="loading">Loading fixture…</p><div id="mount"></div></main>',
                    script="""
                    <script>
                    setTimeout(() => {
                      document.querySelector('#loading').remove();
                      document.querySelector('#mount').innerHTML =
                        '<section data-testid="app-ready" class="card"><h1>Loaded state</h1></section>';
                    }, 150);
                    </script>
                    """,
                ),
            )
            return
        if self.path == "/responsive":
            self._send(
                200,
                page(
                    "Responsive",
                    """
                    <main data-testid="app-ready">
                      <h1>Responsive state</h1>
                      <div class="grid" data-testid="responsive-grid">
                        <section class="card">One</section><section class="card">Two</section>
                        <section class="card">Three</section>
                      </div>
                    </main>
                    """,
                ),
            )
            return
        if self.path == "/failure":
            self._send(
                500,
                page(
                    "Intentional failure",
                    '<main><h1>Intentional failure state</h1><p data-testid="error">Failed</p></main>',
                ),
            )
            return
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send(
        self, status: int, content: bytes, content_type: str = "text/html; charset=utf-8"
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
