"""Strict repository and request contracts for visual verification."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal, Self
from urllib.parse import unquote, urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VERIFICATION_MANIFEST_RELATIVE_PATH = Path(".openinspect/verification.yaml")
MAX_VERIFICATION_MANIFEST_BYTES = 64 * 1024
MAX_VERIFICATION_SCENARIOS = 5
MAX_VERIFICATION_CAPTURES = 8
MAX_VERIFICATION_TIMEOUT_MS = 300_000
MAX_SCREENSHOT_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_SELECTOR_BYTES = 512
MAX_EXPECTED_TEXT_BYTES = 1024
SCENARIO_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class StrictVerificationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def validate_http_path(value: str) -> str:
    """Accept a rooted HTTP path without authority, query, fragment, or traversal."""
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        raise ValueError("must be an absolute HTTP path without an authority")
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("must not contain a scheme, authority, query, or fragment")
    decoded = parsed.path
    for _depth in range(3):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    if (
        not decoded.startswith("/")
        or decoded.startswith("//")
        or "\\" in decoded
        or "\x00" in decoded
        or "?" in decoded
        or "#" in decoded
        or any(part == ".." for part in decoded.split("/"))
    ):
        raise ValueError("must not contain traversal segments")
    return value


class VerificationViewport(StrictVerificationModel):
    width: int = Field(ge=320, le=2560)
    height: int = Field(ge=240, le=1600)


class VerificationWaitFor(StrictVerificationModel):
    kind: Literal["selector", "text", "load"]
    value: str | None = None
    timeout_seconds: float = Field(default=20, gt=0, le=60)

    @model_validator(mode="after")
    def validate_value(self) -> Self:
        if self.kind in {"selector", "text"} and not self.value:
            raise ValueError(f"{self.kind} wait requires value")
        if self.kind == "load" and self.value not in {None, "domcontentloaded", "networkidle"}:
            raise ValueError("load wait value must be domcontentloaded or networkidle")
        if self.value and len(self.value.encode()) > MAX_EXPECTED_TEXT_BYTES:
            raise ValueError("wait value is too large")
        return self


class VerificationAssertion(StrictVerificationModel):
    kind: Literal["visible", "hidden", "text_contains", "url_path", "no_console_error"]
    selector: str | None = None
    value: str | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> Self:
        if self.selector and len(self.selector.encode()) > MAX_SELECTOR_BYTES:
            raise ValueError("selector is too large")
        if self.value and len(self.value.encode()) > MAX_EXPECTED_TEXT_BYTES:
            raise ValueError("expected text is too large")
        if self.kind in {"visible", "hidden"}:
            if not self.selector or self.value is not None:
                raise ValueError(f"{self.kind} requires selector and forbids value")
        elif self.kind == "text_contains":
            if not self.selector or self.value is None:
                raise ValueError("text_contains requires selector and value")
        elif self.kind == "url_path":
            if self.selector is not None or self.value is None:
                raise ValueError("url_path requires value and forbids selector")
            validate_http_path(self.value)
        elif self.selector is not None or self.value is not None:
            raise ValueError("no_console_error forbids selector and value")
        return self


class VerificationScenario(StrictVerificationModel):
    id: str
    path: str = "/"
    viewport: VerificationViewport
    wait_for: VerificationWaitFor | None = None
    assertions: list[VerificationAssertion] = Field(default_factory=list, max_length=20)
    capture: Literal["viewport", "full_page"] = "viewport"

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not SCENARIO_ID_PATTERN.fullmatch(value):
            raise ValueError("must use lowercase letters, numbers, and hyphens")
        return value

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return validate_http_path(value)


class VerificationManifest(StrictVerificationModel):
    version: Literal[1] = 1
    service: str
    base_path: str = "/"
    scenarios: list[VerificationScenario] = Field(
        min_length=1, max_length=MAX_VERIFICATION_SCENARIOS
    )

    @field_validator("service")
    @classmethod
    def validate_service(cls, value: str) -> str:
        if not SERVICE_NAME_PATTERN.fullmatch(value):
            raise ValueError("must use lowercase letters, numbers, hyphens, or underscores")
        return value

    @field_validator("base_path")
    @classmethod
    def validate_base_path(cls, value: str) -> str:
        return validate_http_path(value)

    @field_validator("scenarios")
    @classmethod
    def validate_unique_scenarios(
        cls, value: list[VerificationScenario]
    ) -> list[VerificationScenario]:
        identifiers = [scenario.id for scenario in value]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("scenario ids must be unique")
        return value


class AdHocVerification(StrictVerificationModel):
    service: str
    path: str
    viewport: VerificationViewport
    capture: Literal["viewport", "full_page"] = "viewport"

    @field_validator("service")
    @classmethod
    def validate_service(cls, value: str) -> str:
        if not SERVICE_NAME_PATTERN.fullmatch(value):
            raise ValueError("must use lowercase letters, numbers, hyphens, or underscores")
        return value

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return validate_http_path(value)


class VisualVerificationRequest(StrictVerificationModel):
    version: Literal[1] = 1
    session_id: str = Field(alias="sessionId", min_length=1, max_length=128)
    message_id: str = Field(alias="messageId", min_length=1, max_length=128)
    scenario_ids: list[str] | None = Field(default=None, alias="scenarioIds", max_length=5)
    ad_hoc: AdHocVerification | None = Field(default=None, alias="adHoc")
    reason: Literal["user_requested", "repository_declared", "host_required"]

    @field_validator("scenario_ids")
    @classmethod
    def validate_scenario_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if len(value) != len(set(value)):
            raise ValueError("scenarioIds must be unique")
        if any(not SCENARIO_ID_PATTERN.fullmatch(identifier) for identifier in value):
            raise ValueError("scenarioIds contain an invalid id")
        return value

    @model_validator(mode="after")
    def validate_selection(self) -> Self:
        if self.ad_hoc is not None and self.scenario_ids:
            raise ValueError("adHoc and scenarioIds are mutually exclusive")
        return self


class VisualVerificationPolicy(StrictVerificationModel):
    enabled: bool = False
    trigger: Literal["explicit_only", "declared_ui_changes", "always_after_success"] = (
        "explicit_only"
    )
    max_scenarios: int = Field(default=3, alias="maxScenarios", ge=1, le=MAX_VERIFICATION_SCENARIOS)
    max_captures: int = Field(default=4, alias="maxCaptures", ge=1, le=MAX_VERIFICATION_CAPTURES)
    timeout_ms: int = Field(
        default=120_000, alias="timeoutMs", ge=1000, le=MAX_VERIFICATION_TIMEOUT_MS
    )
    max_upload_bytes: int = Field(
        default=MAX_SCREENSHOT_UPLOAD_BYTES,
        alias="maxUploadBytes",
        ge=1024,
        le=MAX_SCREENSHOT_UPLOAD_BYTES,
    )
    allowed_service_names: list[str] = Field(default_factory=list, alias="allowedServiceNames")
    allow_repository_declaration: bool = Field(default=False, alias="allowRepositoryDeclaration")
    allow_video: bool = Field(default=False, alias="allowVideo")
    completion_behavior: Literal["report_only", "require_pass"] = Field(
        default="report_only", alias="completionBehavior"
    )

    @field_validator("allowed_service_names")
    @classmethod
    def validate_allowed_services(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("allowedServiceNames must be unique")
        if any(not SERVICE_NAME_PATTERN.fullmatch(name) for name in value):
            raise ValueError("allowedServiceNames contains an invalid service name")
        return value


class VisualVerificationAssertionResult(StrictVerificationModel):
    kind: Literal["visible", "hidden", "text_contains", "url_path", "no_console_error"]
    status: Literal["passed", "failed"]
    selector: str | None = Field(default=None, max_length=512)
    message: str | None = Field(default=None, max_length=1024)


class VisualVerificationScenarioReport(StrictVerificationModel):
    id: str
    status: Literal["passed", "failed", "blocked"]
    source: str = Field(max_length=2048)
    viewport: VerificationViewport
    assertions: list[VisualVerificationAssertionResult] = Field(max_length=20)
    artifact_ids: list[str] = Field(alias="artifactIds", max_length=MAX_VERIFICATION_CAPTURES)
    duration_ms: int = Field(alias="durationMs", ge=0)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        if not SCENARIO_ID_PATTERN.fullmatch(value):
            raise ValueError("must use lowercase letters, numbers, and hyphens")
        return value


class VisualVerificationFailure(StrictVerificationModel):
    code: str = Field(pattern=r"^[a-z0-9_]+$")
    message: str = Field(min_length=1, max_length=1024)
    scenario_id: str | None = Field(default=None, alias="scenarioId")


class VisualVerificationReport(StrictVerificationModel):
    version: Literal[1] = 1
    message_id: str = Field(alias="messageId", min_length=1, max_length=128)
    status: Literal["passed", "failed", "blocked", "not_requested"]
    started_at: str = Field(alias="startedAt", min_length=1)
    finished_at: str = Field(alias="finishedAt", min_length=1)
    scenarios: list[VisualVerificationScenarioReport] = Field(max_length=MAX_VERIFICATION_SCENARIOS)
    failure: VisualVerificationFailure | None

    @model_validator(mode="after")
    def validate_passed_report(self) -> Self:
        if self.status != "passed":
            return self
        if (
            self.failure is not None
            or not self.scenarios
            or any(
                scenario.status != "passed" or not scenario.artifact_ids
                for scenario in self.scenarios
            )
        ):
            raise ValueError("passed reports require successful scenarios with persisted artifacts")
        return self


def load_verification_manifest(path: Path) -> VerificationManifest:
    if path.stat().st_size > MAX_VERIFICATION_MANIFEST_BYTES:
        raise ValueError(f"verification manifest exceeds {MAX_VERIFICATION_MANIFEST_BYTES} bytes")
    loaded = yaml.safe_load(path.read_text())
    if not isinstance(loaded, dict):
        raise ValueError("verification manifest must contain a YAML object")
    return VerificationManifest.model_validate(loaded)


def load_visual_verification_policy(raw: str | None) -> VisualVerificationPolicy:
    if not raw:
        return VisualVerificationPolicy()
    loaded = json.loads(raw)
    if not isinstance(loaded, dict):
        raise ValueError("visual verification policy must contain a JSON object")
    return VisualVerificationPolicy.model_validate(loaded)
