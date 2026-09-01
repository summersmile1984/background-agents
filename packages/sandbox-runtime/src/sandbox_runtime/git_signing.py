"""Purpose-specific commit-signing broker client and Git runtime configuration."""

import asyncio
import contextlib
import json
import os
import re
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

from .constants import BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR, REPO_MANIFEST_FILE_PATH
from .log_config import get_logger
from .repo_config import RepoConfigError, RepoEntry, read_repo_manifest
from .types import GitUser

GIT_SIGNER_COMMAND = "oi-git-sign"
GIT_CONFIG_TIMEOUT_SECONDS = 10.0
SIGNING_CONFIG_FETCH_TIMEOUT_SECONDS = 5.0
SIGNING_CONFIG_FETCH_MAX_ATTEMPTS = 3
SIGNING_CONFIG_RETRY_BACKOFF_SECONDS = 0.25
SIGNING_CONFIG_CACHE_MAX_AGE_SECONDS = 300.0
RETRYABLE_SIGNING_CONFIG_STATUS_CODES = frozenset({408, 425, 429})
UNSIGNED_SCM_PROVIDERS = frozenset({"bitbucket", "gitea", "gitlab"})
SIGNING_CONFIG_KEYS = (
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
    "gpg.format",
    "gpg.ssh.program",
    "user.signingkey",
    "commit.gpgsign",
)
UNSIGNED_GIT_USER = GitUser(
    name="OpenInspect",
    email="open-inspect@noreply.open-inspect.invalid",
)


class GitSigningError(RuntimeError):
    """Bounded runtime error that never includes secret configuration values."""


class _TransientGitSigningConfigurationError(GitSigningError):
    """A retryable broker failure that may use a policy-safe cached value."""


class DisabledCommitSigningConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: Literal[False]


class EnabledCommitSigningConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: Literal[True]
    committerName: str = Field(min_length=1, max_length=256)
    committerEmail: str = Field(min_length=3, max_length=320)
    publicKey: str = Field(min_length=1)

    @classmethod
    def _non_blank(cls, value: str, field_name: str) -> str:
        if not value.strip():
            raise ValueError(f"{field_name} must not be blank")
        return value

    @field_validator("committerName")
    @classmethod
    def validate_committer_name(cls, value: str) -> str:
        return cls._non_blank(value, "committerName")

    @field_validator("committerEmail")
    @classmethod
    def validate_committer_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("invalid committer email")
        return value

    @field_validator("publicKey")
    @classmethod
    def validate_public_key(cls, value: str) -> str:
        if not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", value):
            raise ValueError("invalid Ed25519 public key")
        return value


CommitSigningConfiguration = Annotated[
    DisabledCommitSigningConfiguration | EnabledCommitSigningConfiguration,
    Field(discriminator="enabled"),
]
CONFIGURATION_ADAPTER: TypeAdapter[CommitSigningConfiguration] = TypeAdapter(
    CommitSigningConfiguration
)


def parse_commit_signing_configuration(payload: object) -> CommitSigningConfiguration:
    try:
        return CONFIGURATION_ADAPTER.validate_python(payload)
    except ValidationError:
        raise GitSigningError("Invalid commit signing configuration") from None


def resolve_session_scm_provider(environment: Mapping[str, str]) -> str | None:
    """Read the immutable SCM provider from the persisted launch specification."""
    try:
        session_config = json.loads(environment.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return None
    if not isinstance(session_config, dict):
        return None
    launch_spec = session_config.get("launch_spec")
    if not isinstance(launch_spec, dict):
        return None
    target = launch_spec.get("target")
    if not isinstance(target, dict):
        return None
    provider = target.get("provider")
    return provider if isinstance(provider, str) and provider else None


def _is_retryable_status(status_code: int) -> bool:
    return status_code in RETRYABLE_SIGNING_CONFIG_STATUS_CODES or status_code >= 500


class GitSigningRuntime:
    def __init__(
        self,
        *,
        control_plane_url: str,
        session_id: str,
        auth_token: str,
        repo_manifest_path: str | Path = REPO_MANIFEST_FILE_PATH,
        signer_path: str | Path | None = None,
        scm_provider: str | None = None,
    ) -> None:
        self.control_plane_url = control_plane_url.rstrip("/")
        self.session_id = session_id
        self.auth_token = auth_token
        self.scm_provider = scm_provider
        self.repo_manifest_path = Path(repo_manifest_path)
        self.signer_path = (
            Path(signer_path)
            if signer_path is not None
            else Path(os.environ.get(BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR))
            / GIT_SIGNER_COMMAND
        )
        self._cached_configuration: CommitSigningConfiguration | None = None
        self._cached_configuration_at: float | None = None
        self.log = get_logger("git-signing", session_id=session_id)

    async def initialize(self, author: GitUser | None) -> None:
        await self.refresh(author)

    async def refresh(self, author: GitUser | None) -> None:
        repositories = self._read_repositories()
        if not repositories:
            return
        if self.scm_provider in UNSIGNED_SCM_PROVIDERS:
            configuration: CommitSigningConfiguration = DisabledCommitSigningConfiguration(
                enabled=False
            )
        else:
            configuration = await self._fetch_configuration_with_fallback()
        await self._apply_configuration(configuration, author, repositories=repositories)

    async def _fetch_configuration_with_fallback(self) -> CommitSigningConfiguration:
        try:
            configuration = await self._fetch_configuration()
        except _TransientGitSigningConfigurationError:
            cached = self._resolve_cached_configuration()
            if cached is None:
                raise
            self.log.warn(
                "git_signing.configuration_cache_fallback",
                scm_provider=self.scm_provider or "unknown",
                signing_enabled=cached.enabled,
            )
            return cached
        self._cached_configuration = configuration
        self._cached_configuration_at = time.monotonic()
        return configuration

    def _resolve_cached_configuration(self) -> CommitSigningConfiguration | None:
        configuration = self._cached_configuration
        cached_at = self._cached_configuration_at
        if configuration is None or cached_at is None:
            return None
        if isinstance(configuration, DisabledCommitSigningConfiguration):
            # A stale disabled GitHub state could bypass a newly enabled signing
            # policy. Non-GitHub sessions never fetch or cache this response.
            return None
        if time.monotonic() - cached_at <= SIGNING_CONFIG_CACHE_MAX_AGE_SECONDS:
            return configuration
        return None

    async def _fetch_configuration(self) -> CommitSigningConfiguration:
        url = f"{self.control_plane_url}/sessions/{quote(self.session_id, safe='')}/commit-signing"
        async with httpx.AsyncClient(timeout=SIGNING_CONFIG_FETCH_TIMEOUT_SECONDS) as client:
            for attempt in range(1, SIGNING_CONFIG_FETCH_MAX_ATTEMPTS + 1):
                try:
                    response = await client.get(
                        url,
                        headers={"Authorization": f"Bearer {self.auth_token}"},
                    )
                except httpx.HTTPError:
                    retryable = True
                    status_code: int | None = None
                else:
                    status_code = response.status_code
                    retryable = _is_retryable_status(status_code)
                    if response.is_success:
                        try:
                            return parse_commit_signing_configuration(response.json())
                        except ValueError:
                            raise GitSigningError(
                                "Commit signing configuration unavailable"
                            ) from None
                    if not retryable:
                        raise GitSigningError("Commit signing configuration unavailable") from None

                if attempt == SIGNING_CONFIG_FETCH_MAX_ATTEMPTS:
                    break
                self.log.warn(
                    "git_signing.configuration_fetch_retry",
                    attempt=attempt,
                    max_attempts=SIGNING_CONFIG_FETCH_MAX_ATTEMPTS,
                    http_status=status_code,
                )
                await asyncio.sleep(SIGNING_CONFIG_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))

        raise _TransientGitSigningConfigurationError("Commit signing configuration unavailable")

    async def apply_configuration(self, configuration: object, author: GitUser | None) -> None:
        """Validate and apply a configuration without fetching it."""
        await self._apply_configuration(parse_commit_signing_configuration(configuration), author)

    async def _apply_configuration(
        self,
        configuration: CommitSigningConfiguration,
        author: GitUser | None,
        *,
        repositories: Sequence[RepoEntry] | None = None,
    ) -> None:
        repositories = repositories if repositories is not None else self._read_repositories()

        # Validate the whole target set before mutating any repository. This
        # prevents a missing secondary checkout from leaving only the earlier
        # repositories with a changed signing policy.
        if any(not (repository.path / ".git").exists() for repository in repositories):
            raise GitSigningError("Session repository is unavailable for Git configuration")

        if isinstance(configuration, DisabledCommitSigningConfiguration):
            effective_author = author or UNSIGNED_GIT_USER
            for repository in repositories:
                await self._remove_signing_git_config(repository.path)
                await self._set_git_config(repository.path, "user.name", effective_author.name)
                await self._set_git_config(repository.path, "user.email", effective_author.email)
            return

        effective_author = author or GitUser(
            name=configuration.committerName,
            email=configuration.committerEmail,
        )
        signing_values = (
            ("committer.name", configuration.committerName),
            ("committer.email", configuration.committerEmail),
            ("gpg.format", "ssh"),
            ("gpg.ssh.program", str(self.signer_path)),
            ("user.signingkey", f"key::{configuration.publicKey}"),
            ("commit.gpgsign", "true"),
        )
        author_values = (
            ("author.name", effective_author.name),
            ("author.email", effective_author.email),
            ("user.name", effective_author.name),
            ("user.email", effective_author.email),
        )
        for repository in repositories:
            for key, value in signing_values:
                await self._set_git_config(repository.path, key, value)
            for key, value in author_values:
                await self._set_git_config(repository.path, key, value)

    def _read_repositories(self) -> list[RepoEntry]:
        try:
            return read_repo_manifest(self.repo_manifest_path)
        except RepoConfigError:
            raise GitSigningError("Invalid repository manifest") from None

    async def _remove_signing_git_config(self, repository: Path) -> None:
        for key in SIGNING_CONFIG_KEYS:
            await self._run_git_config(repository, "--unset-all", key, allow_missing=True)

    async def _set_git_config(self, repository: Path, key: str, value: str) -> None:
        await self._run_git_config(repository, "--replace-all", key, value)

    async def _run_git_config(
        self,
        repository: Path,
        *args: str,
        allow_missing: bool = False,
    ) -> None:
        if not (repository / ".git").exists():
            raise GitSigningError("Session repository is unavailable for Git configuration")

        command = ["git", "config", "--local", *args]
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=repository,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, _stderr = await asyncio.wait_for(
                process.communicate(), timeout=GIT_CONFIG_TIMEOUT_SECONDS
            )
        except TimeoutError:
            process.kill()
            with contextlib.suppress(ProcessLookupError):
                await process.wait()
            raise GitSigningError("Git signing configuration timed out") from None

        if process.returncode == 0 or (allow_missing and process.returncode in {1, 5}):
            return
        raise GitSigningError("Git signing configuration failed")
