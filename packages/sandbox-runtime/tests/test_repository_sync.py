from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_sync import RepositorySynchronizer
from sandbox_runtime.runtime_config import BootMode

if TYPE_CHECKING:
    from pathlib import Path


def _repo(tmp_path: Path) -> RepoEntry:
    return RepoEntry(
        owner="owner",
        name="repo",
        branch="main",
        path=tmp_path / "repo",
    )


@pytest.mark.asyncio
async def test_failed_clone_removes_partial_checkout_for_next_retry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = _repo(tmp_path)
    command: list[str] = []

    async def create_subprocess_exec(*args: str, **_kwargs: object) -> SimpleNamespace:
        command.extend(args)
        repo.path.mkdir(parents=True)
        (repo.path / ".git").mkdir()
        return SimpleNamespace(returncode=128)

    monkeypatch.setattr("asyncio.create_subprocess_exec", create_subprocess_exec)
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    synchronizer._communicate_owned_subprocess = AsyncMock(return_value=(b"", b"network error"))

    assert await synchronizer._clone_repo(repo) is False
    assert not repo.path.exists()
    assert "--single-branch" in command
    assert "--no-tags" in command
    assert "--filter=blob:none" in command


@pytest.mark.asyncio
async def test_clone_transport_exception_removes_partial_checkout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = _repo(tmp_path)

    async def create_subprocess_exec(*_args: str, **_kwargs: object) -> SimpleNamespace:
        repo.path.mkdir(parents=True)
        return SimpleNamespace(returncode=None)

    monkeypatch.setattr("asyncio.create_subprocess_exec", create_subprocess_exec)
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    synchronizer._communicate_owned_subprocess = AsyncMock(
        side_effect=RuntimeError("transport interrupted")
    )

    assert await synchronizer._clone_repo(repo) is False
    assert not repo.path.exists()


@pytest.mark.asyncio
async def test_successful_clone_preserves_checkout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = _repo(tmp_path)

    async def create_subprocess_exec(*_args: str, **_kwargs: object) -> SimpleNamespace:
        repo.path.mkdir(parents=True)
        (repo.path / ".git").mkdir()
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("asyncio.create_subprocess_exec", create_subprocess_exec)
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    synchronizer._communicate_owned_subprocess = AsyncMock(return_value=(b"", b""))

    assert await synchronizer._clone_repo(repo) is True
    assert repo.path.is_dir()


@pytest.mark.asyncio
async def test_fresh_sync_does_not_fetch_again_after_successful_clone(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    synchronizer = RepositorySynchronizer("github.com", MagicMock())
    synchronizer._clone_repo = AsyncMock(return_value=True)
    synchronizer._update_existing_repo = AsyncMock(return_value=True)

    assert await synchronizer._sync_repo(repo, BootMode.FRESH) is True
    synchronizer._clone_repo.assert_awaited_once_with(repo)
    synchronizer._update_existing_repo.assert_not_awaited()
