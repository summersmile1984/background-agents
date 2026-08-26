"""Owner-only idempotency store for prompt-scoped visual verification reports."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from pydantic import Field

from .constants import VISUAL_VERIFICATION_REPORT_DIR_PATH
from .verification_manifest import (
    StrictVerificationModel,
    VisualVerificationReport,
    VisualVerificationRequest,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

REPORT_ROOT = Path(VISUAL_VERIFICATION_REPORT_DIR_PATH)


class StoredVisualVerification(StrictVerificationModel):
    version: Literal[1] = 1
    request_digest: str = Field(alias="requestDigest", pattern=r"^[a-f0-9]{64}$")
    report: VisualVerificationReport


def visual_verification_request_digest(request: VisualVerificationRequest) -> str:
    canonical = json.dumps(
        request.model_dump(mode="json", by_alias=True, exclude_none=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


def _message_key(message_id: str) -> str:
    return hashlib.sha256(message_id.encode()).hexdigest()


def report_path(message_id: str, root: Path = REPORT_ROOT) -> Path:
    return root / f"{_message_key(message_id)}.json"


def _ensure_report_root(root: Path) -> None:
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    metadata = root.lstat()
    if root.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("visual verification report root must be a directory")
    if metadata.st_uid != os.geteuid():
        raise ValueError("visual verification report root has the wrong owner")
    root.chmod(0o700)


@contextlib.contextmanager
def visual_verification_lock(message_id: str, root: Path = REPORT_ROOT) -> Iterator[None]:
    _ensure_report_root(root)
    lock_path = root / f"{_message_key(message_id)}.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "r+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            yield
    except Exception:
        # fdopen owns the descriptor once entered; close only if construction failed.
        with contextlib.suppress(OSError):
            os.close(descriptor)
        raise


def load_stored_visual_verification(
    message_id: str,
    root: Path = REPORT_ROOT,
) -> StoredVisualVerification | None:
    path = report_path(message_id, root)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("visual verification report must be a regular file")
    if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise ValueError("visual verification report permissions are unsafe")
    if metadata.st_size > 128 * 1024:
        raise ValueError("visual verification report exceeds its size limit")
    stored = StoredVisualVerification.model_validate_json(path.read_text())
    if stored.report.message_id != message_id:
        raise ValueError("visual verification report identity does not match")
    return stored


def write_stored_visual_verification(
    stored: StoredVisualVerification,
    root: Path = REPORT_ROOT,
) -> None:
    _ensure_report_root(root)
    path = report_path(stored.report.message_id, root)
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=root,
        prefix=f".{path.name}.",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        temporary_path.chmod(0o600)
        temporary.write(stored.model_dump_json(by_alias=True))
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)
