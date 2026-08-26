import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from sandbox_runtime.verification_manifest import (
    VerificationManifest,
    VisualVerificationRequest,
    load_verification_manifest,
    load_visual_verification_policy,
)


def valid_manifest() -> dict[str, object]:
    return {
        "version": 1,
        "service": "web",
        "base_path": "/",
        "scenarios": [
            {
                "id": "home-desktop",
                "path": "/dashboard",
                "viewport": {"width": 1440, "height": 900},
                "wait_for": {"kind": "selector", "value": "main"},
                "assertions": [
                    {"kind": "visible", "selector": "main"},
                    {"kind": "url_path", "value": "/dashboard"},
                    {"kind": "no_console_error"},
                ],
                "capture": "viewport",
            }
        ],
    }


def test_verification_manifest_accepts_bounded_scenario() -> None:
    parsed = VerificationManifest.model_validate(valid_manifest())

    assert parsed.scenarios[0].viewport.width == 1440
    assert parsed.scenarios[0].assertions[-1].kind == "no_console_error"


@pytest.mark.parametrize(
    "path",
    [
        "https://example.com/",
        "//example.com/",
        "/../secret",
        "/%2e%2e/secret",
        "/%252e%252e/secret",
        "/%255c%255cexample.com/",
        "/x%253fq=1",
        "/x?q=1",
        "/x#y",
    ],
)
def test_verification_manifest_rejects_non_local_paths(path: str) -> None:
    payload = valid_manifest()
    payload["scenarios"][0]["path"] = path  # type: ignore[index]

    with pytest.raises(ValidationError):
        VerificationManifest.model_validate(payload)


def test_verification_manifest_rejects_unknown_fields_and_duplicate_ids() -> None:
    payload = valid_manifest()
    scenario = dict(payload["scenarios"][0])  # type: ignore[index]
    scenario["unexpected"] = True
    payload["scenarios"] = [scenario, scenario]

    with pytest.raises(ValidationError):
        VerificationManifest.model_validate(payload)


def test_verification_request_cross_surface_shape() -> None:
    request = VisualVerificationRequest.model_validate(
        {
            "version": 1,
            "sessionId": "session-1",
            "messageId": "message-1",
            "adHoc": {
                "service": "web",
                "path": "/",
                "viewport": {"width": 390, "height": 844},
                "capture": "full_page",
            },
            "reason": "user_requested",
        }
    )

    assert request.ad_hoc is not None
    assert request.ad_hoc.viewport.width == 390


def test_policy_is_disabled_by_default_and_enforces_hard_limits() -> None:
    assert load_visual_verification_policy(None).enabled is False

    with pytest.raises(ValidationError):
        load_visual_verification_policy(json.dumps({"enabled": True, "maxScenarios": 6}))


def test_load_verification_manifest_from_yaml(tmp_path: Path) -> None:
    path = tmp_path / "verification.yaml"
    path.write_text(
        """
version: 1
service: web
scenarios:
  - id: home
    path: /
    viewport: {width: 1280, height: 720}
    assertions:
      - {kind: visible, selector: body}
"""
    )

    assert load_verification_manifest(path).scenarios[0].id == "home"
