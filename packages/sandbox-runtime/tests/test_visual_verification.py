import json
import os
import shutil
import socket
import struct
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from sandbox_runtime.prompt_context import PromptContext, write_prompt_context
from sandbox_runtime.verification_manifest import VerificationScenario, VisualVerificationRequest
from sandbox_runtime.visual_verification import (
    EXIT_BLOCKED,
    EXIT_FAILED,
    EXIT_PASSED,
    AgentBrowser,
    JsonCommandRunner,
    VerificationBlocked,
    apply_wait,
    execute_idempotent_visual_verification,
    execute_visual_verification,
    load_dev_service_metadata,
    persist_blocked_visual_verification,
)
from sandbox_runtime.visual_verification_store import load_stored_visual_verification


class ReadyHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = b"<html><main>Dashboard</main></html>"
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class ReadyServer:
    def __enter__(self) -> "ReadyServer":
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ReadyHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


class UploadHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(content_length)
        self.server.requests.append(  # type: ignore[attr-defined]
            {
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "contentType": self.headers.get("content-type"),
                "body": body,
            }
        )
        response = json.dumps({"artifactId": "artifact-real-1"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class UploadServer:
    def __enter__(self) -> "UploadServer":
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), UploadHandler)
        self.server.requests = []  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        return self

    @property
    def requests(self) -> list[dict[str, Any]]:
        return self.server.requests  # type: ignore[attr-defined,no-any-return]

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


class FakeRunner(JsonCommandRunner):
    def __init__(
        self,
        *,
        assertion_passes: bool = True,
        opened_url: str | None = None,
        invalid_captures: int = 0,
        browser_crashes: int = 0,
    ) -> None:
        self.assertion_passes = assertion_passes
        self.opened_url = opened_url
        self.invalid_captures = invalid_captures
        self.browser_crashes = browser_crashes
        self.current_url = ""
        self.commands: list[list[str]] = []
        self.environments: list[dict[str, str]] = []

    async def run(
        self,
        command: list[str],
        *,
        timeout_seconds: float,
        stdin: str | None = None,
        environment: dict[str, str] | None = None,
        failure_kind: str = "browser",
    ) -> dict[str, Any]:
        del timeout_seconds, stdin, failure_kind
        self.commands.append(command)
        self.environments.append(dict(environment or {}))
        if command[0] == "/fake/upload-media":
            return {"artifactId": "artifact-1"}
        action = next(
            (
                item
                for item in command
                if item
                in {
                    "open",
                    "set",
                    "wait",
                    "eval",
                    "console",
                    "errors",
                    "screenshot",
                    "get",
                    "close",
                }
            ),
            "",
        )
        if action == "open":
            if self.browser_crashes > 0:
                self.browser_crashes -= 1
                raise VerificationBlocked("browser_crashed", "Browser crashed")
            requested = command[command.index("open") + 1]
            self.current_url = self.opened_url or requested
            data: dict[str, Any] = {"url": self.current_url}
        elif action == "get":
            data = {"url": self.current_url}
        elif action == "eval":
            data = {"result": {"passed": self.assertion_passes}}
        elif action == "console":
            data = {"entries": []}
        elif action == "errors":
            data = {"errors": []}
        elif action == "screenshot":
            path = Path(next(item for item in command if item.endswith(".png")))
            if self.invalid_captures > 0:
                self.invalid_captures -= 1
                path.write_bytes(b"not-a-png")
            else:
                path.write_bytes(png_bytes(800, 600))
            data = {"path": str(path)}
        else:
            data = {}
        return {"success": True, "data": data, "error": None}


def png_bytes(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    pixels = b"".join(b"\x00" + b"\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )


def write_metadata(path: Path, sandbox_id: str, port: int) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "sandboxId": sandbox_id,
                "generatedAt": "2026-08-26T00:00:00.000Z",
                "manifestPath": "/workspace/repo/.openinspect/environment.yaml",
                "services": [
                    {
                        "name": "web",
                        "kind": "process",
                        "state": "ready",
                        "pid": 123,
                        "ports": [port],
                        "primaryUrl": f"http://127.0.0.1:{port}",
                        "port": port,
                        "dataDir": None,
                        "cwd": "/workspace/repo",
                        "hasSnapshotCommand": False,
                    }
                ],
            }
        )
    )
    path.chmod(0o600)


def verification_request(*, declared: bool = False) -> VisualVerificationRequest:
    if declared:
        return VisualVerificationRequest.model_validate(
            {
                "version": 1,
                "sessionId": "session-1",
                "messageId": "message-1",
                "scenarioIds": ["home"],
                "reason": "repository_declared",
            }
        )
    return VisualVerificationRequest.model_validate(
        {
            "version": 1,
            "sessionId": "session-1",
            "messageId": "message-1",
            "adHoc": {
                "service": "web",
                "path": "/",
                "viewport": {"width": 800, "height": 600},
                "capture": "viewport",
            },
            "reason": "user_requested",
        }
    )


def verification_environment(*, allow_repository: bool = False) -> dict[str, str]:
    return {
        **os.environ,
        "SANDBOX_ID": "sandbox-1",
        "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
        "OPENINSPECT_VISUAL_VERIFICATION_POLICY": json.dumps(
            {
                "enabled": True,
                "trigger": "explicit_only",
                "maxScenarios": 3,
                "maxCaptures": 4,
                "timeoutMs": 30_000,
                "maxUploadBytes": 10 * 1024 * 1024,
                "allowedServiceNames": ["web"],
                "allowRepositoryDeclaration": allow_repository,
                "allowVideo": False,
                "completionBehavior": "report_only",
            }
        ),
    }


async def run_with_fixture(
    tmp_path: Path, runner: FakeRunner, *, declared: bool = False
) -> tuple[dict[str, Any], int]:
    context_path = tmp_path / "prompt.json"
    metadata_path = tmp_path / "services.json"
    write_prompt_context(PromptContext("session-1", "message-1", "sandbox-1"), context_path)
    if declared:
        declaration = tmp_path / ".openinspect" / "verification.yaml"
        declaration.parent.mkdir()
        declaration.write_text(
            """
version: 1
service: web
scenarios:
  - id: home
    path: /
    viewport: {width: 800, height: 600}
    assertions:
      - {kind: visible, selector: body}
"""
        )
    with ReadyServer() as server:
        write_metadata(metadata_path, "sandbox-1", server.port)
        return await execute_visual_verification(
            verification_request(declared=declared),
            environment=verification_environment(allow_repository=declared),
            repository_root=tmp_path,
            metadata_path=metadata_path,
            prompt_context_path=context_path,
            runner=runner,
            agent_browser_executable="/fake/agent-browser",
            upload_executable="/fake/upload-media",
        )


async def test_visual_verification_passes_only_after_upload(tmp_path: Path, caplog) -> None:
    caplog.set_level("INFO", logger="visual-verification")
    runner = FakeRunner()

    report, exit_code = await run_with_fixture(tmp_path, runner)

    assert exit_code == EXIT_PASSED, json.dumps(report, indent=2)
    assert report["status"] == "passed"
    assert report["scenarios"][0]["artifactIds"] == ["artifact-1"]
    assert any(command[0] == "/fake/upload-media" for command in runner.commands)
    assert any("--allowed-domains" in command for command in runner.commands)
    stage_records = [
        record for record in caplog.records if record.getMessage() == "visual_verification.stage"
    ]
    assert {record.stage for record in stage_records} == {
        "configuration",
        "runtime_requirements",
        "service_readiness",
        "navigation",
        "assertions",
        "capture",
        "upload",
        "scenario",
    }
    assert all("url" not in record.__dict__ for record in stage_records)
    assert all("artifact_id" not in record.__dict__ for record in stage_records)


@pytest.mark.parametrize(
    ("wait_for", "expected_arguments"),
    [
        ({"kind": "selector", "value": "#ready", "timeout_seconds": 7}, ["wait", "#ready"]),
        (
            {"kind": "text", "value": "Dashboard ready", "timeout_seconds": 8},
            ["wait", "--text", "Dashboard ready"],
        ),
        (
            {"kind": "load", "value": "networkidle", "timeout_seconds": 9},
            ["wait", "--load", "networkidle"],
        ),
    ],
)
async def test_apply_wait_matches_agent_browser_0_21_cli(
    wait_for: dict[str, object], expected_arguments: list[str]
) -> None:
    runner = FakeRunner()
    browser = AgentBrowser(
        "/fake/agent-browser",
        runner,
        "session-1",
        30,
        {},
    )
    scenario = VerificationScenario.model_validate(
        {
            "id": "home",
            "viewport": {"width": 800, "height": 600},
            "wait_for": wait_for,
        }
    )

    await apply_wait(browser, scenario)

    assert runner.commands[-1][-len(expected_arguments) :] == expected_arguments
    assert "--timeout" not in runner.commands[-1]
    assert runner.environments[-1]["AGENT_BROWSER_DEFAULT_TIMEOUT"] == str(
        int(float(wait_for["timeout_seconds"]) * 1000)
    )


async def test_visual_verification_preserves_capture_on_assertion_failure(tmp_path: Path) -> None:
    report, exit_code = await run_with_fixture(
        tmp_path,
        FakeRunner(assertion_passes=False),
        declared=True,
    )

    assert exit_code == EXIT_FAILED
    assert report["status"] == "failed"
    assert report["failure"]["code"] == "assertion_failed"
    assert report["scenarios"][0]["artifactIds"] == ["artifact-1"]


async def test_visual_verification_recaptures_one_invalid_png(tmp_path: Path) -> None:
    runner = FakeRunner(invalid_captures=1)

    report, exit_code = await run_with_fixture(tmp_path, runner)

    assert exit_code == EXIT_PASSED
    assert report["status"] == "passed"
    assert sum("screenshot" in command for command in runner.commands) == 2


async def test_visual_verification_retries_one_browser_crash_in_fresh_context(
    tmp_path: Path,
) -> None:
    runner = FakeRunner(browser_crashes=1)

    report, exit_code = await run_with_fixture(tmp_path, runner)

    assert exit_code == EXIT_PASSED
    assert report["status"] == "passed"
    sessions = {
        command[command.index("--session") + 1]
        for command in runner.commands
        if "--session" in command
    }
    assert len(sessions) == 2


async def test_visual_verification_reports_blocked_scenario_after_retry_exhaustion(
    tmp_path: Path,
) -> None:
    report, exit_code = await run_with_fixture(tmp_path, FakeRunner(browser_crashes=2))

    assert exit_code == EXIT_BLOCKED
    assert report["failure"]["code"] == "browser_crashed"
    assert report["scenarios"] == [
        {
            "id": "ad-hoc",
            "status": "blocked",
            "source": "web:/",
            "viewport": {"width": 800, "height": 600},
            "assertions": [],
            "artifactIds": [],
            "durationMs": 0,
        }
    ]


async def test_visual_verification_rejects_browser_cross_origin_redirect(tmp_path: Path) -> None:
    report, exit_code = await run_with_fixture(
        tmp_path,
        FakeRunner(opened_url="http://127.0.0.1:65534/private"),
    )

    assert exit_code == EXIT_BLOCKED
    assert report["status"] == "blocked"
    assert report["failure"]["code"] == "redirect_not_allowed"


async def test_visual_verification_rejects_wrong_prompt_identity(tmp_path: Path) -> None:
    context_path = tmp_path / "prompt.json"
    metadata_path = tmp_path / "services.json"
    write_prompt_context(PromptContext("session-1", "other-message", "sandbox-1"), context_path)
    write_metadata(metadata_path, "sandbox-1", _free_port())

    report, exit_code = await execute_visual_verification(
        verification_request(),
        environment=verification_environment(),
        metadata_path=metadata_path,
        prompt_context_path=context_path,
    )

    assert exit_code == EXIT_BLOCKED
    assert report["failure"]["code"] == "identity_mismatch"


async def test_visual_verification_replays_same_request_and_rejects_conflict(
    tmp_path: Path,
) -> None:
    context_path = tmp_path / "prompt.json"
    metadata_path = tmp_path / "services.json"
    report_root = tmp_path / "reports"
    runner = FakeRunner()
    request = verification_request()
    write_prompt_context(PromptContext("session-1", "message-1", "sandbox-1"), context_path)

    with ReadyServer() as server:
        write_metadata(metadata_path, "sandbox-1", server.port)
        kwargs = {
            "report_root": report_root,
            "environment": verification_environment(),
            "repository_root": tmp_path,
            "metadata_path": metadata_path,
            "prompt_context_path": context_path,
            "runner": runner,
            "agent_browser_executable": "/fake/agent-browser",
            "upload_executable": "/fake/upload-media",
        }
        first, first_exit = await execute_idempotent_visual_verification(request, **kwargs)
        replay, replay_exit = await execute_idempotent_visual_verification(request, **kwargs)
        conflict_request = VisualVerificationRequest.model_validate(
            {
                **request.model_dump(by_alias=True),
                "adHoc": {
                    "service": "web",
                    "path": "/other",
                    "viewport": {"width": 800, "height": 600},
                    "capture": "viewport",
                },
            }
        )
        conflict, conflict_exit = await execute_idempotent_visual_verification(
            conflict_request, **kwargs
        )

    assert first_exit == EXIT_PASSED
    assert replay_exit == EXIT_PASSED
    assert replay == first
    assert sum(command[0] == "/fake/upload-media" for command in runner.commands) == 1
    assert conflict_exit == EXIT_BLOCKED
    assert conflict["failure"]["code"] == "verification_request_conflict"


def test_cancelled_visual_verification_is_persisted_and_replayed(tmp_path: Path) -> None:
    report_root = tmp_path / "reports"
    request = verification_request()

    first, first_exit = persist_blocked_visual_verification(
        request,
        failure_code="cancelled",
        failure_message="Visual verification was cancelled with the prompt",
        report_root=report_root,
    )
    replay, replay_exit = persist_blocked_visual_verification(
        request,
        failure_code="cancelled",
        failure_message="A different message must not replace the persisted report",
        report_root=report_root,
    )

    assert first_exit == EXIT_BLOCKED
    assert replay_exit == EXIT_BLOCKED
    assert replay == first
    assert first["status"] == "blocked"
    assert first["failure"]["code"] == "cancelled"
    stored = load_stored_visual_verification(request.message_id, report_root)
    assert stored is not None
    assert stored.report.failure is not None
    assert stored.report.failure.code == "cancelled"


def test_cancelled_visual_verification_rejects_a_conflicting_request(tmp_path: Path) -> None:
    report_root = tmp_path / "reports"
    request = verification_request()
    persist_blocked_visual_verification(
        request,
        failure_code="cancelled",
        failure_message="Visual verification was cancelled with the prompt",
        report_root=report_root,
    )
    conflict_request = VisualVerificationRequest.model_validate(
        {
            **request.model_dump(by_alias=True),
            "adHoc": {
                "service": "web",
                "path": "/other",
                "viewport": {"width": 800, "height": 600},
                "capture": "viewport",
            },
        }
    )

    conflict, conflict_exit = persist_blocked_visual_verification(
        conflict_request,
        failure_code="cancelled",
        failure_message="Visual verification was cancelled with the prompt",
        report_root=report_root,
    )

    assert conflict_exit == EXIT_BLOCKED
    assert conflict["failure"]["code"] == "verification_request_conflict"
    stored = load_stored_visual_verification(request.message_id, report_root)
    assert stored is not None
    assert stored.report.failure is not None
    assert stored.report.failure.code == "cancelled"


@pytest.mark.skipif(
    not os.environ.get("OI_AGENT_BROWSER_BIN"),
    reason="set OI_AGENT_BROWSER_BIN to run the real Chrome integration",
)
async def test_real_agent_browser_capture_and_upload(tmp_path: Path) -> None:
    agent_browser = os.environ["OI_AGENT_BROWSER_BIN"]
    context_path = tmp_path / "prompt.json"
    metadata_path = tmp_path / "services.json"
    uploader = tmp_path / "upload-media"
    source_uploader = (
        Path(__file__).parents[1] / "src" / "sandbox_runtime" / "bin" / "upload-media.js"
    )
    shutil.copy2(source_uploader, uploader)
    uploader.chmod(0o700)
    write_prompt_context(PromptContext("session-1", "message-1", "sandbox-1"), context_path)

    with ReadyServer() as application, UploadServer() as control_plane:
        write_metadata(metadata_path, "sandbox-1", application.port)
        environment = {
            **verification_environment(),
            "CONTROL_PLANE_URL": f"http://127.0.0.1:{control_plane.port}",
            "SANDBOX_AUTH_TOKEN": "sandbox-auth-test",
        }
        report, exit_code = await execute_visual_verification(
            verification_request(),
            environment=environment,
            repository_root=tmp_path,
            metadata_path=metadata_path,
            prompt_context_path=context_path,
            agent_browser_executable=agent_browser,
            upload_executable=str(uploader),
        )

    assert exit_code == EXIT_PASSED, json.dumps(report, indent=2)
    assert report["status"] == "passed"
    assert report["scenarios"][0]["artifactIds"] == ["artifact-real-1"]
    assert len(control_plane.requests) == 1
    upload = control_plane.requests[0]
    assert upload["path"] == "/sessions/session-1/media"
    assert upload["authorization"] == "Bearer sandbox-auth-test"
    assert str(upload["contentType"]).startswith("multipart/form-data; boundary=")
    assert b"Visual verification: ad-hoc" in upload["body"]
    assert b"image/png" in upload["body"]


def test_service_metadata_rejects_world_writable_files(tmp_path: Path) -> None:
    path = tmp_path / "services.json"
    write_metadata(path, "sandbox-1", _free_port())
    path.chmod(0o622)

    try:
        load_dev_service_metadata(path, "sandbox-1")
    except Exception as error:
        assert getattr(error, "code", None) == "service_metadata_invalid"
    else:
        raise AssertionError("world-writable metadata was accepted")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
