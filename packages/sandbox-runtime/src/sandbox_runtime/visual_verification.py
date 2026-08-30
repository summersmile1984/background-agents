"""Harness-independent browser verification and screenshot upload executor."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import stat
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, NoReturn
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .dev_services import DEV_SERVICE_METADATA_PATH
from .log_config import get_logger
from .prompt_context import read_prompt_context
from .verification_manifest import (
    VERIFICATION_MANIFEST_RELATIVE_PATH,
    VerificationAssertion,
    VerificationManifest,
    VerificationScenario,
    VerificationViewport,
    VisualVerificationPolicy,
    VisualVerificationReport,
    VisualVerificationRequest,
    load_verification_manifest,
    load_visual_verification_policy,
)
from .visual_verification_store import (
    REPORT_ROOT,
    StoredVisualVerification,
    load_stored_visual_verification,
    visual_verification_lock,
    visual_verification_request_digest,
    write_stored_visual_verification,
)

POLICY_ENV_VAR = "OPENINSPECT_VISUAL_VERIFICATION_POLICY"
AGENT_BROWSER_COMMAND = "agent-browser"
UPLOAD_MEDIA_COMMAND = "upload-media"
CAPTURE_ROOT = Path("/tmp/oi-visual")
COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024
READINESS_RETRY_SECONDS = 0.25
MAX_REDIRECTS = 5
DEFAULT_AD_HOC_VIEWPORT_WIDTH = 1440
DEFAULT_AD_HOC_VIEWPORT_HEIGHT = 900
BROWSER_ENVIRONMENT_KEYS = {
    "AGENT_BROWSER_EXECUTABLE_PATH",
    "CHROME_PATH",
    "CI",
    "DISPLAY",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
    "TMPDIR",
    "USER",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
}

EXIT_PASSED = 0
EXIT_FAILED = 10
EXIT_BLOCKED = 20
EXIT_INVALID_REQUEST = 64
EXIT_RUNTIME_ERROR = 70

log = get_logger("visual-verification")


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log_stage(
    *,
    message_id: str,
    stage: str,
    outcome: str,
    started: float,
    scenario_id: str | None = None,
    service_name: str | None = None,
    failure_code: str | None = None,
    **metrics: Any,
) -> None:
    """Emit bounded stage telemetry without URLs, prompt text, or artifact IDs."""
    fields = {
        "message_id": message_id,
        "stage": stage,
        "outcome": outcome,
        "duration_ms": int((time.monotonic() - started) * 1000),
        **({"scenario_id": scenario_id} if scenario_id else {}),
        **({"service_name": service_name} if service_name else {}),
        **({"failure_code": failure_code} if failure_code else {}),
        **metrics,
    }
    writer = log.info if outcome in {"passed", "ready", "uploaded", "skipped"} else log.warn
    writer("visual_verification.stage", **fields)


class StrictMetadataModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class DevServiceEntry(StrictMetadataModel):
    name: str
    kind: str
    state: str
    pid: int = Field(gt=1)
    ports: list[int]
    primary_url: str | None = Field(alias="primaryUrl")
    port: int | None = None
    data_dir: str | None = Field(default=None, alias="dataDir")
    cwd: str | None = None
    has_snapshot_command: bool = Field(alias="hasSnapshotCommand")

    @field_validator("primary_url")
    @classmethod
    def validate_primary_url(cls, value: str | None) -> str | None:
        if value is None:
            return value
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname not in {"127.0.0.1", "::1"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in {"", "/"}
        ):
            raise ValueError("primaryUrl must be a credential-free loopback HTTP origin")
        return value.rstrip("/")


class DevServiceMetadata(StrictMetadataModel):
    version: int
    sandbox_id: str = Field(alias="sandboxId")
    generated_at: str = Field(alias="generatedAt")
    manifest_path: str | None = Field(alias="manifestPath")
    services: list[DevServiceEntry]


@dataclass(frozen=True)
class SelectedScenario:
    service: str
    base_path: str
    scenario: VerificationScenario


class VerificationProblem(Exception):
    def __init__(self, code: str, message: str, *, scenario_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.scenario_id = scenario_id


class VerificationFailed(VerificationProblem):
    pass


class VerificationBlocked(VerificationProblem):
    pass


class JsonCommandRunner:
    """Run one bounded command and require agent-browser/upload JSON output."""

    async def run(
        self,
        command: list[str],
        *,
        timeout_seconds: float,
        stdin: str | None = None,
        environment: dict[str, str] | None = None,
        failure_kind: Literal["browser", "upload"] = "browser",
    ) -> dict[str, Any]:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(stdin.encode() if stdin is not None else None),
                timeout=timeout_seconds,
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            code = "browser_timeout" if failure_kind == "browser" else "upload_failed"
            label = "Browser command" if failure_kind == "browser" else "Media upload"
            raise VerificationBlocked(code, f"{label} timed out") from None
        if len(stdout) > COMMAND_OUTPUT_LIMIT_BYTES or len(stderr) > COMMAND_OUTPUT_LIMIT_BYTES:
            code = "browser_output_too_large" if failure_kind == "browser" else "upload_failed"
            label = "Browser output" if failure_kind == "browser" else "Media upload output"
            raise VerificationBlocked(code, f"{label} exceeded its limit")
        if process.returncode:
            diagnostic = _bounded_diagnostic(stderr.decode(errors="replace"))
            if failure_kind == "upload":
                normalized = diagnostic.lower()
                code = (
                    "upload_unauthorized"
                    if any(
                        marker in normalized
                        for marker in ("401", "403", "unauthorized", "forbidden")
                    )
                    else "upload_failed"
                )
            else:
                normalized = diagnostic.lower()
                code = (
                    "browser_crashed"
                    if any(
                        marker in normalized
                        for marker in (
                            "browser crashed",
                            "page crashed",
                            "target closed",
                            "browser has been closed",
                            "browser disconnected",
                        )
                    )
                    else "browser_command_failed"
                )
            raise VerificationBlocked(
                code,
                diagnostic,
            )
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as error:
            code = "browser_invalid_output" if failure_kind == "browser" else "upload_failed"
            label = "Browser" if failure_kind == "browser" else "Media upload"
            raise VerificationBlocked(code, f"{label} returned invalid JSON") from error
        if not isinstance(payload, dict):
            code = "browser_invalid_output" if failure_kind == "browser" else "upload_failed"
            label = "Browser" if failure_kind == "browser" else "Media upload"
            raise VerificationBlocked(code, f"{label} returned a non-object result")
        return payload


class AgentBrowser:
    def __init__(
        self,
        executable: str,
        runner: JsonCommandRunner,
        session_name: str,
        timeout_seconds: float,
        environment: dict[str, str],
    ) -> None:
        self.executable = executable
        self.runner = runner
        self.session_name = session_name
        self.timeout_seconds = timeout_seconds
        self.environment = {
            key: value
            for key, value in environment.items()
            if key in BROWSER_ENVIRONMENT_KEYS or key.startswith("AGENT_BROWSER_")
        }
        self.environment.update(
            {
                "NO_PROXY": "127.0.0.1,localhost,::1",
                "no_proxy": "127.0.0.1,localhost,::1",
            }
        )

    async def command(
        self,
        *arguments: str,
        stdin: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        environment = dict(self.environment)
        if timeout_ms is not None:
            environment["AGENT_BROWSER_DEFAULT_TIMEOUT"] = str(timeout_ms)
        payload = await self.runner.run(
            [
                self.executable,
                "--session",
                self.session_name,
                "--json",
                "--allowed-domains",
                "127.0.0.1,localhost,[::1]",
                *arguments,
            ],
            timeout_seconds=self.timeout_seconds,
            stdin=stdin,
            environment=environment,
        )
        data = payload.get("data")
        if payload.get("success") is not True or not isinstance(data, dict):
            raise VerificationBlocked("browser_command_failed", "Browser command was unsuccessful")
        return data

    async def close(self) -> None:
        try:
            await self.command("close")
        except VerificationProblem:
            return


def _bounded_diagnostic(value: str) -> str:
    compact = " ".join(value.strip().split())
    return (compact or "Browser command failed")[:512]


def _read_json_file(path: Path) -> object:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata is not a regular file"
        )
    if metadata.st_uid != os.geteuid():
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata has the wrong owner"
        )
    if metadata.st_mode & 0o022:
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata is group/world writable"
        )
    if metadata.st_size > 256 * 1024:
        raise VerificationBlocked("service_metadata_invalid", "Service metadata is too large")
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata is invalid"
        ) from error


def load_dev_service_metadata(path: Path, expected_sandbox_id: str) -> DevServiceMetadata:
    try:
        metadata = DevServiceMetadata.model_validate(_read_json_file(path))
    except ValidationError as error:
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata has an unsupported shape"
        ) from error
    if metadata.version != 1:
        raise VerificationBlocked(
            "service_metadata_invalid", "Service metadata version is unsupported"
        )
    if metadata.sandbox_id != expected_sandbox_id:
        raise VerificationBlocked(
            "service_metadata_stale", "Service metadata belongs to another sandbox"
        )
    return metadata


def _session_id_from_environment(environment: dict[str, str]) -> str:
    try:
        config = json.loads(environment.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError as error:
        raise VerificationBlocked("identity_unavailable", "SESSION_CONFIG is invalid") from error
    if not isinstance(config, dict):
        raise VerificationBlocked("identity_unavailable", "SESSION_CONFIG is invalid")
    value = config.get("sessionId") or config.get("session_id")
    if not isinstance(value, str) or not value:
        raise VerificationBlocked("identity_unavailable", "Session identity is unavailable")
    return value


def validate_request_identity(
    request: VisualVerificationRequest,
    environment: dict[str, str],
    *,
    prompt_context_path: Path | None = None,
) -> str:
    session_id = _session_id_from_environment(environment)
    if request.session_id != session_id:
        raise VerificationBlocked("identity_mismatch", "Request session does not match the sandbox")
    context = (
        read_prompt_context(prompt_context_path) if prompt_context_path else read_prompt_context()
    )
    sandbox_id = environment.get("SANDBOX_ID", "")
    if (
        context.session_id != session_id
        or context.message_id != request.message_id
        or not sandbox_id
        or context.sandbox_id != sandbox_id
    ):
        raise VerificationBlocked("identity_mismatch", "Request does not match the active prompt")
    return sandbox_id


def select_scenarios(
    request: VisualVerificationRequest,
    policy: VisualVerificationPolicy,
    *,
    repository_root: Path,
) -> list[SelectedScenario]:
    if request.ad_hoc is not None:
        return [
            SelectedScenario(
                service=request.ad_hoc.service,
                base_path="/",
                scenario=VerificationScenario(
                    id="ad-hoc",
                    path=request.ad_hoc.path,
                    viewport=request.ad_hoc.viewport,
                    capture=request.ad_hoc.capture,
                ),
            )
        ]
    # The Web toggle and chat clients intentionally send `{}` for a plain
    # user-requested screenshot. Resolve that request against the sole
    # supervised HTTP service below; it never opens an arbitrary host/port.
    if request.reason == "user_requested" and not request.scenario_ids:
        return [
            SelectedScenario(
                service="auto",
                base_path="/",
                scenario=VerificationScenario(
                    id="ad-hoc",
                    path="/",
                    viewport=VerificationViewport(
                        width=DEFAULT_AD_HOC_VIEWPORT_WIDTH,
                        height=DEFAULT_AD_HOC_VIEWPORT_HEIGHT,
                    ),
                ),
            )
        ]
    if not policy.allow_repository_declaration:
        return []
    manifest_path = repository_root / VERIFICATION_MANIFEST_RELATIVE_PATH
    if not manifest_path.is_file():
        raise VerificationBlocked(
            "config_missing", "Repository verification declaration is missing"
        )
    try:
        manifest = load_verification_manifest(manifest_path)
    except (OSError, ValueError, ValidationError) as error:
        raise VerificationBlocked(
            "config_invalid", "Repository verification declaration is invalid"
        ) from error
    scenarios = _select_manifest_scenarios(manifest, request.scenario_ids)
    maximum = min(policy.max_scenarios, policy.max_captures)
    return [
        SelectedScenario(service=manifest.service, base_path=manifest.base_path, scenario=scenario)
        for scenario in scenarios[:maximum]
    ]


def _select_manifest_scenarios(
    manifest: VerificationManifest, scenario_ids: list[str] | None
) -> list[VerificationScenario]:
    if not scenario_ids:
        return list(manifest.scenarios)
    by_id = {scenario.id: scenario for scenario in manifest.scenarios}
    missing = [identifier for identifier in scenario_ids if identifier not in by_id]
    if missing:
        raise VerificationBlocked(
            "scenario_not_found", "A requested verification scenario is missing"
        )
    return [by_id[identifier] for identifier in scenario_ids]


def resolve_service(
    metadata: DevServiceMetadata, name: str, policy: VisualVerificationPolicy
) -> DevServiceEntry:
    if name == "auto":
        candidates = [
            service
            for service in metadata.services
            if service.kind == "process"
            and service.state == "ready"
            and service.primary_url
            and (not policy.allowed_service_names or service.name in policy.allowed_service_names)
        ]
        if len(candidates) == 0:
            raise VerificationBlocked(
                "service_not_found", "No ready supervised HTTP service is available"
            )
        if len(candidates) > 1:
            raise VerificationBlocked(
                "service_ambiguous",
                "Name the supervised service when more than one HTTP service is ready",
            )
        return candidates[0]
    if policy.allowed_service_names and name not in policy.allowed_service_names:
        raise VerificationBlocked("service_not_allowed", "Service is not allowed by host policy")
    matches = [service for service in metadata.services if service.name == name]
    if len(matches) != 1:
        raise VerificationBlocked("service_not_found", "Supervised service was not found")
    service = matches[0]
    if service.kind != "process" or service.state != "ready" or not service.primary_url:
        raise VerificationBlocked("service_not_ready", "Supervised HTTP service is not ready")
    parsed = urlsplit(service.primary_url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in service.ports:
        raise VerificationBlocked(
            "service_metadata_invalid", "Service origin uses an undeclared port"
        )
    return service


def build_target_url(service: DevServiceEntry, base_path: str, scenario_path: str) -> str:
    if not service.primary_url:
        raise VerificationBlocked("service_not_ready", "Service does not expose an HTTP origin")
    base = "/" + "/".join(part for part in base_path.split("/") if part)
    suffix = "/".join(part for part in scenario_path.split("/") if part)
    path = f"{base.rstrip('/')}/{suffix}" if suffix else (base or "/")
    return service.primary_url + (path if path.startswith("/") else f"/{path}")


def _same_service_origin(url: str, service: DevServiceEntry) -> bool:
    if not service.primary_url:
        return False
    actual = urlsplit(url)
    expected = urlsplit(service.primary_url)
    actual_port = actual.port or (443 if actual.scheme == "https" else 80)
    expected_port = expected.port or (443 if expected.scheme == "https" else 80)
    return (
        actual.scheme == expected.scheme
        and actual.hostname == expected.hostname
        and actual_port == expected_port
        and actual.username is None
        and actual.password is None
    )


async def wait_for_http_ready(
    url: str,
    service: DevServiceEntry,
    *,
    timeout_seconds: float,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=2.0) as client:
        while time.monotonic() < deadline:
            current = url
            try:
                for _ in range(MAX_REDIRECTS + 1):
                    if not _same_service_origin(current, service):
                        raise VerificationBlocked(
                            "redirect_not_allowed", "Service redirected outside its declared origin"
                        )
                    response = await client.get(current)
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise VerificationBlocked(
                                "redirect_invalid", "Service returned an invalid redirect"
                            )
                        current = urljoin(current, location)
                        continue
                    if 200 <= response.status_code < 400:
                        return current
                    last_error = RuntimeError(f"HTTP status {response.status_code}")
                    break
                else:
                    raise VerificationBlocked(
                        "redirect_invalid", "Service returned too many redirects"
                    )
            except VerificationBlocked:
                raise
            except (httpx.HTTPError, OSError) as error:
                last_error = error
            await asyncio.sleep(READINESS_RETRY_SECONDS)
    raise VerificationBlocked(
        "service_not_ready", "Service did not become HTTP-ready"
    ) from last_error


def _assertion_script(assertion: VerificationAssertion) -> str:
    kind = assertion.kind
    selector = json.dumps(assertion.selector)
    expected = json.dumps(assertion.value)
    return f"""
(() => {{
  const kind = {json.dumps(kind)};
  const selector = {selector};
  const expected = {expected};
  const visible = (element) => {{
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 && rect.width > 0 && rect.height > 0;
  }};
  if (kind === "url_path") return {{ passed: location.pathname === expected }};
  const element = document.querySelector(selector);
  if (kind === "visible") return {{ passed: visible(element) }};
  if (kind === "hidden") return {{ passed: !visible(element) }};
  if (kind === "text_contains") return {{
    passed: !!element && (element.textContent || "").includes(expected)
  }};
  return {{ passed: false }};
}})()
""".strip()


async def run_assertion(browser: AgentBrowser, assertion: VerificationAssertion) -> dict[str, Any]:
    if assertion.kind == "no_console_error":
        console_data = await browser.command("console")
        error_data = await browser.command("errors")
        raw_entries = console_data.get("entries")
        raw_errors = error_data.get("errors")
        entries: list[Any] = raw_entries if isinstance(raw_entries, list) else []
        errors: list[Any] = raw_errors if isinstance(raw_errors, list) else []
        error_count = len(errors)
        for entry in entries:
            if isinstance(entry, dict) and entry.get("level") in {"error", "assert"}:
                error_count += 1
        return {
            "kind": assertion.kind,
            "status": "passed" if error_count == 0 else "failed",
            **({"message": f"{error_count} console/page error(s) detected"} if error_count else {}),
        }
    data = await browser.command("eval", "--stdin", stdin=_assertion_script(assertion))
    result = data.get("result")
    passed = isinstance(result, dict) and result.get("passed") is True
    return {
        "kind": assertion.kind,
        "status": "passed" if passed else "failed",
        **({"selector": assertion.selector} if assertion.selector else {}),
        **({"message": "Assertion did not match the rendered page"} if not passed else {}),
    }


async def apply_wait(browser: AgentBrowser, scenario: VerificationScenario) -> None:
    wait = scenario.wait_for
    if wait is None:
        await browser.command("wait", "--load", "domcontentloaded")
        return
    timeout_ms = int(wait.timeout_seconds * 1000)
    if wait.kind == "selector" and wait.value:
        await browser.command("wait", wait.value, timeout_ms=timeout_ms)
    elif wait.kind == "text" and wait.value:
        await browser.command("wait", "--text", wait.value, timeout_ms=timeout_ms)
    else:
        await browser.command(
            "wait",
            "--load",
            wait.value or "domcontentloaded",
            timeout_ms=timeout_ms,
        )


def inspect_png(
    path: Path,
    maximum_bytes: int,
    viewport: VerificationViewport,
    *,
    full_page: bool = False,
) -> int:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise VerificationBlocked("capture_invalid", "Capture is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > maximum_bytes:
        raise VerificationBlocked("capture_invalid", "Capture size is outside the allowed range")
    payload = path.read_bytes()
    if payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise VerificationBlocked("capture_invalid", "Capture is not a valid PNG")
    offset = 8
    width = 0
    height = 0
    seen_header = False
    seen_image_data = False
    seen_end = False
    while offset < len(payload):
        if offset + 12 > len(payload):
            raise VerificationBlocked("capture_invalid", "Capture PNG is truncated")
        chunk_length = struct.unpack(">I", payload[offset : offset + 4])[0]
        chunk_type = payload[offset + 4 : offset + 8]
        chunk_end = offset + 12 + chunk_length
        if chunk_end > len(payload):
            raise VerificationBlocked("capture_invalid", "Capture PNG is truncated")
        chunk_data = payload[offset + 8 : offset + 8 + chunk_length]
        expected_crc = struct.unpack(">I", payload[offset + 8 + chunk_length : chunk_end])[0]
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
            raise VerificationBlocked("capture_invalid", "Capture PNG checksum is invalid")
        if not seen_header:
            if chunk_type != b"IHDR" or chunk_length != 13:
                raise VerificationBlocked("capture_invalid", "Capture PNG header is invalid")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if (
                width <= 0
                or height <= 0
                or bit_depth not in valid_depths.get(color_type, set())
                or compression != 0
                or filtering != 0
                or interlace not in {0, 1}
            ):
                raise VerificationBlocked("capture_invalid", "Capture PNG header is invalid")
            seen_header = True
        elif chunk_type == b"IHDR":
            raise VerificationBlocked("capture_invalid", "Capture PNG contains duplicate headers")
        if chunk_type == b"IDAT":
            seen_image_data = True
        if chunk_type == b"IEND":
            if chunk_length != 0:
                raise VerificationBlocked("capture_invalid", "Capture PNG terminator is invalid")
            seen_end = True
            offset = chunk_end
            break
        offset = chunk_end
    if not seen_header or not seen_image_data or not seen_end or offset != len(payload):
        raise VerificationBlocked("capture_invalid", "Capture PNG is incomplete")
    if width != viewport.width or (
        height < viewport.height if full_page else height != viewport.height
    ):
        raise VerificationBlocked("capture_invalid", "Capture dimensions do not match the request")
    return metadata.st_size


async def upload_capture(
    runner: JsonCommandRunner,
    executable: str,
    capture_path: Path,
    scenario: VerificationScenario,
    source_url: str,
    timeout_seconds: float,
    environment: dict[str, str],
) -> str:
    command = [
        executable,
        str(capture_path),
        "--caption",
        f"Visual verification: {scenario.id}",
        "--source-url",
        source_url,
        "--viewport",
        json.dumps(scenario.viewport.model_dump(), separators=(",", ":")),
    ]
    if scenario.capture == "full_page":
        command.append("--full-page")
    payload = await runner.run(
        command,
        timeout_seconds=timeout_seconds,
        environment=environment,
        failure_kind="upload",
    )
    artifact_id = payload.get("artifactId")
    if not isinstance(artifact_id, str) or not artifact_id:
        raise VerificationBlocked("upload_failed", "Media upload returned no artifact ID")
    return artifact_id


def _scenario_source(selected: SelectedScenario, service_name: str | None = None) -> str:
    base = "/" + "/".join(part for part in selected.base_path.split("/") if part)
    suffix = "/".join(part for part in selected.scenario.path.split("/") if part)
    path = f"{base.rstrip('/')}/{suffix}" if suffix else (base or "/")
    return f"{service_name or selected.service}:{path}"


async def run_selected_scenario(
    selected: SelectedScenario,
    *,
    message_id: str,
    metadata: DevServiceMetadata,
    policy: VisualVerificationPolicy,
    browser: AgentBrowser,
    runner: JsonCommandRunner,
    upload_executable: str,
    capture_dir: Path,
    environment: dict[str, str],
) -> dict[str, Any]:
    started = time.monotonic()
    scenario = selected.scenario
    service = resolve_service(metadata, selected.service, policy)
    resolved_service_name = service.name
    target = build_target_url(service, selected.base_path, scenario.path)
    readiness_started = time.monotonic()
    try:
        target = await wait_for_http_ready(
            target,
            service,
            timeout_seconds=min(30.0, policy.timeout_ms / 1000),
        )
    except VerificationProblem as problem:
        log_stage(
            message_id=message_id,
            stage="service_readiness",
            outcome="blocked",
            started=readiness_started,
            scenario_id=scenario.id,
            service_name=resolved_service_name,
            failure_code=problem.code,
        )
        raise
    log_stage(
        message_id=message_id,
        stage="service_readiness",
        outcome="ready",
        started=readiness_started,
        scenario_id=scenario.id,
        service_name=resolved_service_name,
    )
    navigation_started = time.monotonic()
    try:
        await browser.command("console", "--clear")
        await browser.command("errors", "--clear")
        await browser.command(
            "set", "viewport", str(scenario.viewport.width), str(scenario.viewport.height)
        )
        opened = await browser.command("open", target)
        opened_url = opened.get("url")
        if not isinstance(opened_url, str) or not _same_service_origin(opened_url, service):
            raise VerificationBlocked(
                "redirect_not_allowed", "Browser navigated outside the declared service origin"
            )
        await apply_wait(browser, scenario)
        current = await browser.command("get", "url")
        current_url = current.get("url")
        if not isinstance(current_url, str) or not _same_service_origin(current_url, service):
            raise VerificationBlocked(
                "redirect_not_allowed", "Browser navigated outside the declared service origin"
            )
    except VerificationProblem as problem:
        log_stage(
            message_id=message_id,
            stage="navigation",
            outcome="blocked",
            started=navigation_started,
            scenario_id=scenario.id,
            service_name=resolved_service_name,
            failure_code=problem.code,
        )
        raise
    log_stage(
        message_id=message_id,
        stage="navigation",
        outcome="passed",
        started=navigation_started,
        scenario_id=scenario.id,
        service_name=resolved_service_name,
    )
    assertion_started = time.monotonic()
    try:
        assertions = [await run_assertion(browser, assertion) for assertion in scenario.assertions]
    except VerificationProblem as problem:
        log_stage(
            message_id=message_id,
            stage="assertions",
            outcome="blocked",
            started=assertion_started,
            scenario_id=scenario.id,
            service_name=resolved_service_name,
            failure_code=problem.code,
        )
        raise
    assertion_failures = sum(item["status"] == "failed" for item in assertions)
    log_stage(
        message_id=message_id,
        stage="assertions",
        outcome="failed" if assertion_failures else "passed",
        started=assertion_started,
        scenario_id=scenario.id,
        service_name=resolved_service_name,
        assertion_count=len(assertions),
        assertion_failure_count=assertion_failures,
    )
    capture_path = capture_dir / f"{scenario.id}.png"
    screenshot_arguments = ["screenshot"]
    if scenario.capture == "full_page":
        screenshot_arguments.append("--full")
    screenshot_arguments.append(str(capture_path))
    capture_started = time.monotonic()
    capture_bytes = 0
    try:
        for capture_attempt in range(2):
            capture_path.unlink(missing_ok=True)
            await browser.command(*screenshot_arguments)
            capture_path.chmod(0o600)
            try:
                capture_bytes = inspect_png(
                    capture_path,
                    policy.max_upload_bytes,
                    scenario.viewport,
                    full_page=scenario.capture == "full_page",
                )
                break
            except VerificationBlocked as problem:
                if problem.code != "capture_invalid" or capture_attempt > 0:
                    raise
    except VerificationProblem as problem:
        log_stage(
            message_id=message_id,
            stage="capture",
            outcome="blocked",
            started=capture_started,
            scenario_id=scenario.id,
            service_name=resolved_service_name,
            failure_code=problem.code,
            capture_attempt_count=capture_attempt + 1,
        )
        raise
    log_stage(
        message_id=message_id,
        stage="capture",
        outcome="passed",
        started=capture_started,
        scenario_id=scenario.id,
        service_name=resolved_service_name,
        capture_bytes=capture_bytes,
        capture_attempt_count=capture_attempt + 1,
    )
    upload_started = time.monotonic()
    try:
        artifact_id = await upload_capture(
            runner,
            upload_executable,
            capture_path,
            scenario,
            current_url,
            policy.timeout_ms / 1000,
            environment,
        )
    except VerificationProblem as problem:
        log_stage(
            message_id=message_id,
            stage="upload",
            outcome="blocked",
            started=upload_started,
            scenario_id=scenario.id,
            service_name=resolved_service_name,
            failure_code=problem.code,
            capture_bytes=capture_bytes,
            artifact_count=0,
        )
        raise
    log_stage(
        message_id=message_id,
        stage="upload",
        outcome="uploaded",
        started=upload_started,
        scenario_id=scenario.id,
        service_name=resolved_service_name,
        capture_bytes=capture_bytes,
        artifact_count=1,
    )
    status = "failed" if any(item["status"] == "failed" for item in assertions) else "passed"
    return {
        "id": scenario.id,
        "status": status,
        "source": _scenario_source(selected, resolved_service_name),
        "viewport": scenario.viewport.model_dump(),
        "assertions": assertions,
        "artifactIds": [artifact_id],
        "durationMs": int((time.monotonic() - started) * 1000),
    }


def _report(
    *,
    message_id: str,
    status: str,
    started_at: str,
    scenarios: list[dict[str, Any]],
    failure: VerificationProblem | None,
) -> dict[str, Any]:
    return {
        "version": 1,
        "messageId": message_id,
        "status": status,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "scenarios": scenarios,
        "failure": (
            {
                "code": failure.code,
                "message": failure.message,
                **({"scenarioId": failure.scenario_id} if failure.scenario_id else {}),
            }
            if failure
            else None
        ),
    }


async def execute_visual_verification(
    request: VisualVerificationRequest,
    *,
    environment: dict[str, str] | None = None,
    repository_root: Path | None = None,
    metadata_path: Path = DEV_SERVICE_METADATA_PATH,
    prompt_context_path: Path | None = None,
    runner: JsonCommandRunner | None = None,
    agent_browser_executable: str | None = None,
    upload_executable: str | None = None,
) -> tuple[dict[str, Any], int]:
    started_at = utc_now()
    configuration_started = time.monotonic()
    env = environment or dict(os.environ)
    scenarios: list[dict[str, Any]] = []
    try:
        policy = load_visual_verification_policy(env.get(POLICY_ENV_VAR))
        if not policy.enabled:
            log_stage(
                message_id=request.message_id,
                stage="configuration",
                outcome="skipped",
                started=configuration_started,
                failure_code="policy_disabled",
            )
            return (
                _report(
                    message_id=request.message_id,
                    status="not_requested",
                    started_at=started_at,
                    scenarios=[],
                    failure=None,
                ),
                EXIT_PASSED,
            )
        if request.reason == "repository_declared" and not policy.allow_repository_declaration:
            log_stage(
                message_id=request.message_id,
                stage="configuration",
                outcome="skipped",
                started=configuration_started,
                failure_code="repository_declaration_disabled",
            )
            return (
                _report(
                    message_id=request.message_id,
                    status="not_requested",
                    started_at=started_at,
                    scenarios=[],
                    failure=None,
                ),
                EXIT_PASSED,
            )
        sandbox_id = validate_request_identity(
            request,
            env,
            prompt_context_path=prompt_context_path,
        )
        metadata = load_dev_service_metadata(metadata_path, sandbox_id)
        selected = select_scenarios(
            request,
            policy,
            repository_root=repository_root or Path.cwd(),
        )
        if not selected:
            log_stage(
                message_id=request.message_id,
                stage="configuration",
                outcome="skipped",
                started=configuration_started,
                failure_code="no_scenarios_selected",
            )
            return (
                _report(
                    message_id=request.message_id,
                    status="not_requested",
                    started_at=started_at,
                    scenarios=[],
                    failure=None,
                ),
                EXIT_PASSED,
            )
        log_stage(
            message_id=request.message_id,
            stage="configuration",
            outcome="passed",
            started=configuration_started,
            scenario_count=len(selected),
        )
        command_runner = runner or JsonCommandRunner()
        browser_command = agent_browser_executable or shutil.which(AGENT_BROWSER_COMMAND)
        uploader_command = upload_executable or shutil.which(UPLOAD_MEDIA_COMMAND)
        if not browser_command:
            log_stage(
                message_id=request.message_id,
                stage="runtime_requirements",
                outcome="blocked",
                started=configuration_started,
                failure_code="browser_unavailable",
            )
            raise VerificationBlocked("browser_unavailable", "agent-browser is not installed")
        if not uploader_command:
            log_stage(
                message_id=request.message_id,
                stage="runtime_requirements",
                outcome="blocked",
                started=configuration_started,
                failure_code="upload_unavailable",
            )
            raise VerificationBlocked("upload_unavailable", "upload-media is not installed")
        log_stage(
            message_id=request.message_id,
            stage="runtime_requirements",
            outcome="passed",
            started=configuration_started,
        )
        invocation_digest = hashlib.sha256(request.message_id.encode()).hexdigest()[:20]
        capture_dir = CAPTURE_ROOT / invocation_digest / secrets.token_hex(8)
        capture_dir.mkdir(parents=True, mode=0o700)
        capture_dir.chmod(0o700)

        def fresh_browser() -> AgentBrowser:
            return AgentBrowser(
                browser_command,
                command_runner,
                f"oi-visual-{invocation_digest}-{secrets.token_hex(4)}",
                policy.timeout_ms / 1000,
                env,
            )

        browser = fresh_browser()
        try:
            async with asyncio.timeout(policy.timeout_ms / 1000):
                for item in selected:
                    scenario_started = time.monotonic()
                    for browser_attempt in range(2):
                        try:
                            result = await run_selected_scenario(
                                item,
                                message_id=request.message_id,
                                metadata=metadata,
                                policy=policy,
                                browser=browser,
                                runner=command_runner,
                                upload_executable=uploader_command,
                                capture_dir=capture_dir,
                                environment=env,
                            )
                            break
                        except VerificationBlocked as problem:
                            if problem.code == "browser_crashed" and browser_attempt == 0:
                                await browser.close()
                                browser = fresh_browser()
                                continue
                            problem.scenario_id = item.scenario.id
                            log_stage(
                                message_id=request.message_id,
                                stage="scenario",
                                outcome="blocked",
                                started=scenario_started,
                                scenario_id=item.scenario.id,
                                service_name=item.service,
                                failure_code=problem.code,
                            )
                            scenarios.append(
                                {
                                    "id": item.scenario.id,
                                    "status": "blocked",
                                    "source": _scenario_source(item),
                                    "viewport": item.scenario.viewport.model_dump(),
                                    "assertions": [],
                                    "artifactIds": [],
                                    "durationMs": 0,
                                }
                            )
                            raise
                        except VerificationProblem as problem:
                            problem.scenario_id = item.scenario.id
                            log_stage(
                                message_id=request.message_id,
                                stage="scenario",
                                outcome="failed",
                                started=scenario_started,
                                scenario_id=item.scenario.id,
                                service_name=item.service,
                                failure_code=problem.code,
                            )
                            raise
                    scenarios.append(result)
                    log_stage(
                        message_id=request.message_id,
                        stage="scenario",
                        outcome=str(result["status"]),
                        started=scenario_started,
                        scenario_id=item.scenario.id,
                        service_name=item.service,
                        artifact_count=len(result["artifactIds"]),
                    )
        except TimeoutError as error:
            raise VerificationBlocked(
                "verification_timeout", "Visual verification timed out"
            ) from error
        finally:
            await browser.close()
            shutil.rmtree(capture_dir, ignore_errors=True)
        failed = next((scenario for scenario in scenarios if scenario["status"] == "failed"), None)
        if failed:
            assertion_problem = VerificationFailed(
                "assertion_failed",
                "One or more visual assertions failed",
                scenario_id=str(failed["id"]),
            )
            return (
                _report(
                    message_id=request.message_id,
                    status="failed",
                    started_at=started_at,
                    scenarios=scenarios,
                    failure=assertion_problem,
                ),
                EXIT_FAILED,
            )
        return (
            _report(
                message_id=request.message_id,
                status="passed",
                started_at=started_at,
                scenarios=scenarios,
                failure=None,
            ),
            EXIT_PASSED,
        )
    except VerificationFailed as problem:
        return (
            _report(
                message_id=request.message_id,
                status="failed",
                started_at=started_at,
                scenarios=scenarios,
                failure=problem,
            ),
            EXIT_FAILED,
        )
    except VerificationBlocked as problem:
        return (
            _report(
                message_id=request.message_id,
                status="blocked",
                started_at=started_at,
                scenarios=scenarios,
                failure=problem,
            ),
            EXIT_BLOCKED,
        )
    except (ValidationError, ValueError, json.JSONDecodeError):
        config_problem = VerificationBlocked(
            "runtime_config_invalid", "Visual verification configuration is invalid"
        )
        return (
            _report(
                message_id=request.message_id,
                status="blocked",
                started_at=started_at,
                scenarios=scenarios,
                failure=config_problem,
            ),
            EXIT_RUNTIME_ERROR,
        )


def _invalid_request_report(message: str) -> dict[str, Any]:
    started = utc_now()
    return _report(
        message_id="unknown",
        status="blocked",
        started_at=started,
        scenarios=[],
        failure=VerificationBlocked("invalid_request", message[:512]),
    )


def _exit_code_for_report(report: VisualVerificationReport) -> int:
    if report.status in {"passed", "not_requested"}:
        return EXIT_PASSED
    if report.status == "failed":
        return EXIT_FAILED
    return EXIT_BLOCKED


async def execute_idempotent_visual_verification(
    request: VisualVerificationRequest,
    *,
    report_root: Path = REPORT_ROOT,
    environment: dict[str, str] | None = None,
    repository_root: Path | None = None,
    metadata_path: Path = DEV_SERVICE_METADATA_PATH,
    prompt_context_path: Path | None = None,
    runner: JsonCommandRunner | None = None,
    agent_browser_executable: str | None = None,
    upload_executable: str | None = None,
) -> tuple[dict[str, Any], int]:
    """Execute once per request digest and replay the exact persisted report."""
    request_digest = visual_verification_request_digest(request)
    with visual_verification_lock(request.message_id, report_root):
        existing = load_stored_visual_verification(request.message_id, report_root)
        if existing is not None:
            if existing.request_digest != request_digest:
                conflict = VisualVerificationReport.model_validate(
                    _report(
                        message_id=request.message_id,
                        status="blocked",
                        started_at=utc_now(),
                        scenarios=[],
                        failure=VerificationBlocked(
                            "verification_request_conflict",
                            "A different verification request already completed for this message",
                        ),
                    )
                )
                return conflict.model_dump(mode="json", by_alias=True), EXIT_BLOCKED
            return (
                existing.report.model_dump(mode="json", by_alias=True),
                _exit_code_for_report(existing.report),
            )

        report_data, exit_code = await execute_visual_verification(
            request,
            environment=environment,
            repository_root=repository_root,
            metadata_path=metadata_path,
            prompt_context_path=prompt_context_path,
            runner=runner,
            agent_browser_executable=agent_browser_executable,
            upload_executable=upload_executable,
        )
        report = VisualVerificationReport.model_validate(report_data)
        write_stored_visual_verification(
            StoredVisualVerification(requestDigest=request_digest, report=report),
            report_root,
        )
        return report.model_dump(mode="json", by_alias=True), exit_code


def persist_blocked_visual_verification(
    request: VisualVerificationRequest,
    *,
    failure_code: str,
    failure_message: str,
    report_root: Path = REPORT_ROOT,
) -> tuple[dict[str, Any], int]:
    """Persist a terminal blocked result without starting a browser.

    This is used when the prompt is cancelled before the canonical verifier can
    finish. It shares the normal request-digest lock and replay semantics so a
    completed report always wins over a later cancellation notification.
    """
    request_digest = visual_verification_request_digest(request)
    with visual_verification_lock(request.message_id, report_root):
        existing = load_stored_visual_verification(request.message_id, report_root)
        if existing is not None:
            if existing.request_digest != request_digest:
                conflict = VisualVerificationReport.model_validate(
                    _report(
                        message_id=request.message_id,
                        status="blocked",
                        started_at=utc_now(),
                        scenarios=[],
                        failure=VerificationBlocked(
                            "verification_request_conflict",
                            "A different verification request already completed for this message",
                        ),
                    )
                )
                return conflict.model_dump(mode="json", by_alias=True), EXIT_BLOCKED
            return (
                existing.report.model_dump(mode="json", by_alias=True),
                _exit_code_for_report(existing.report),
            )

        started_at = utc_now()
        report = VisualVerificationReport.model_validate(
            _report(
                message_id=request.message_id,
                status="blocked",
                started_at=started_at,
                scenarios=[],
                failure=VerificationBlocked(failure_code, failure_message),
            )
        )
        write_stored_visual_verification(
            StoredVisualVerification(requestDigest=request_digest, report=report),
            report_root,
        )
        return report.model_dump(mode="json", by_alias=True), EXIT_BLOCKED


async def async_main() -> int:
    try:
        raw = await asyncio.to_thread(sys.stdin.read)
        if len(raw.encode()) > 64 * 1024:
            raise ValueError("request exceeds 65536 bytes")
        request = VisualVerificationRequest.model_validate_json(raw)
    except (ValidationError, ValueError) as error:
        print(json.dumps(_invalid_request_report(str(error)), separators=(",", ":")))
        return EXIT_INVALID_REQUEST
    try:
        report, exit_code = await execute_idempotent_visual_verification(request)
    except Exception:
        report = _report(
            message_id=request.message_id,
            status="blocked",
            started_at=utc_now(),
            scenarios=[],
            failure=VerificationBlocked("runtime_error", "Visual verification failed unexpectedly"),
        )
        exit_code = EXIT_RUNTIME_ERROR
    print(json.dumps(report, separators=(",", ":")))
    return exit_code


def main() -> NoReturn:
    raise SystemExit(asyncio.run(async_main()))


if __name__ == "__main__":
    main()
