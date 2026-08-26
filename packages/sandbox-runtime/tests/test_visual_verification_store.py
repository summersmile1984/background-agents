import json
from pathlib import Path

import pytest

from sandbox_runtime.verification_manifest import (
    VisualVerificationReport,
    VisualVerificationRequest,
)
from sandbox_runtime.visual_verification_store import (
    StoredVisualVerification,
    load_stored_visual_verification,
    report_path,
    visual_verification_request_digest,
    write_stored_visual_verification,
)


def request(path: str = "/") -> VisualVerificationRequest:
    return VisualVerificationRequest.model_validate(
        {
            "version": 1,
            "sessionId": "session-1",
            "messageId": "message-1",
            "adHoc": {
                "service": "web",
                "path": path,
                "viewport": {"width": 800, "height": 600},
            },
            "reason": "user_requested",
        }
    )


def report() -> VisualVerificationReport:
    return VisualVerificationReport.model_validate(
        {
            "version": 1,
            "messageId": "message-1",
            "status": "blocked",
            "startedAt": "2026-08-26T00:00:00.000Z",
            "finishedAt": "2026-08-26T00:00:01.000Z",
            "scenarios": [],
            "failure": {"code": "service_not_ready", "message": "not ready"},
        }
    )


def test_request_digest_is_canonical_and_sensitive_to_selection() -> None:
    assert visual_verification_request_digest(request()) == visual_verification_request_digest(
        request()
    )
    assert visual_verification_request_digest(request()) != visual_verification_request_digest(
        request("/other")
    )


def test_stored_report_round_trip_is_owner_only(tmp_path: Path) -> None:
    stored = StoredVisualVerification(
        requestDigest=visual_verification_request_digest(request()),
        report=report(),
    )

    write_stored_visual_verification(stored, tmp_path)

    assert load_stored_visual_verification("message-1", tmp_path) == stored
    assert report_path("message-1", tmp_path).stat().st_mode & 0o777 == 0o600
    assert tmp_path.stat().st_mode & 0o777 == 0o700


def test_stored_report_rejects_mismatched_message_identity(tmp_path: Path) -> None:
    path = report_path("message-1", tmp_path)
    tmp_path.chmod(0o700)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "requestDigest": "a" * 64,
                "report": {
                    **report().model_dump(mode="json", by_alias=True),
                    "messageId": "other-message",
                },
            }
        )
    )
    path.chmod(0o600)

    try:
        load_stored_visual_verification("message-1", tmp_path)
    except ValueError as error:
        assert "identity" in str(error)
    else:
        raise AssertionError("mismatched report identity was accepted")


def test_stored_report_rejects_world_writable_file(tmp_path: Path) -> None:
    stored = StoredVisualVerification(
        requestDigest=visual_verification_request_digest(request()),
        report=report(),
    )
    write_stored_visual_verification(stored, tmp_path)
    report_path("message-1", tmp_path).chmod(0o622)

    with pytest.raises(ValueError, match="permissions"):
        load_stored_visual_verification("message-1", tmp_path)


def test_stored_report_rejects_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("{}")
    path = report_path("message-1", tmp_path)
    path.symlink_to(target)

    with pytest.raises(ValueError, match="regular file"):
        load_stored_visual_verification("message-1", tmp_path)


def test_store_rejects_symlink_root(tmp_path: Path) -> None:
    real_root = tmp_path / "real"
    real_root.mkdir()
    linked_root = tmp_path / "linked"
    linked_root.symlink_to(real_root, target_is_directory=True)
    stored = StoredVisualVerification(
        requestDigest=visual_verification_request_digest(request()),
        report=report(),
    )

    with pytest.raises(ValueError, match="root must be a directory"):
        write_stored_visual_verification(stored, linked_root)
