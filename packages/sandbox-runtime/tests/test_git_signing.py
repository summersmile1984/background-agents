import json
import subprocess
import textwrap
from unittest.mock import AsyncMock

import httpx
import pytest

from sandbox_runtime.git_signing import GitSigningRuntime, resolve_session_scm_provider
from sandbox_runtime.repo_config import RepoEntry, dump_repo_manifest
from sandbox_runtime.types import GitUser

PRIVATE_KEY = """-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----"""
PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p"
ENABLED_CONFIGURATION = {
    "enabled": True,
    "committerName": "Open Inspect",
    "committerEmail": "open-inspect@example.com",
    "publicKey": PUBLIC_KEY,
}
OWNED_SIGNING_CONFIG_KEYS = (
    "author.name",
    "author.email",
    "committer.name",
    "committer.email",
    "gpg.format",
    "gpg.ssh.program",
    "user.signingkey",
    "commit.gpgsign",
)


def git(repo, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=check,
        capture_output=True,
        text=True,
    )


def create_repository(path):
    path.mkdir()
    git(path, "init")
    return path


def create_manifest(tmp_path, repositories=()):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        dump_repo_manifest(
            [
                RepoEntry(owner="acme", name=repository.name, branch="main", path=repository)
                for repository in repositories
            ]
        )
    )
    return manifest


def create_remote_signer(tmp_path):
    private_key = tmp_path / "remote-signing-key"
    private_key.write_text(f"{PRIVATE_KEY}\n")
    private_key.chmod(0o600)
    signer = tmp_path / "oi-git-sign"
    signer.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import os
            import subprocess
            import sys

            arguments = sys.argv[1:]
            if arguments[:2] != ["-Y", "sign"]:
                os.execv("/usr/bin/ssh-keygen", ["/usr/bin/ssh-keygen", *arguments])
            subprocess.run(
                [
                    "/usr/bin/ssh-keygen",
                    "-Y",
                    "sign",
                    "-n",
                    "git",
                    "-f",
                    {str(private_key)!r},
                    arguments[-1],
                ],
                check=True,
            )
            """
        )
    )
    signer.chmod(0o755)
    return signer


def create_runtime(
    tmp_path,
    manifest,
    *,
    signer_path=None,
    control_plane_url="https://control.example.com",
    scm_provider=None,
):
    return GitSigningRuntime(
        control_plane_url=control_plane_url,
        session_id="session-1",
        auth_token="sandbox-token",
        repo_manifest_path=manifest,
        signer_path=signer_path or tmp_path / "oi-git-sign",
        scm_provider=scm_provider,
    )


@pytest.mark.parametrize(
    ("session_config", "expected"),
    [
        ({"launch_spec": {"target": {"provider": "gitea"}}}, "gitea"),
        ({"launch_spec": {"target": {"provider": "github"}}}, "github"),
        ({"launch_spec": {"target": {"provider": None}}}, None),
        ({"provider": "openai"}, None),
    ],
)
def test_resolve_session_scm_provider_uses_launch_target(session_config, expected):
    assert resolve_session_scm_provider({"SESSION_CONFIG": json.dumps(session_config)}) == expected


def test_resolve_session_scm_provider_rejects_malformed_config():
    assert resolve_session_scm_provider({"SESSION_CONFIG": "not-json"}) is None


@pytest.mark.asyncio
async def test_disabled_configuration_removes_signing_state_and_sets_unsigned_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    git(repo, "config", "user.signingkey", "/old/key")
    git(repo, "config", "gpg.ssh.program", "/old/signer")
    git(repo, "config", "commit.gpgsign", "true")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(tmp_path, manifest)

    await runtime.apply_configuration(
        {"enabled": False}, GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")
    )

    assert git(repo, "config", "--get", "user.signingkey", check=False).returncode == 1
    assert git(repo, "config", "--get", "gpg.ssh.program", check=False).returncode == 1
    assert git(repo, "config", "--get", "commit.gpgsign", check=False).returncode == 1
    assert git(repo, "config", "user.name").stdout.strip() == "OpenInspect"
    assert git(repo, "config", "user.email").stdout.strip() == "open-inspect@noreply.github.com"


@pytest.mark.asyncio
async def test_enabled_configuration_creates_a_valid_signed_commit_with_split_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    allowed_signers = tmp_path / "allowed_signers"
    allowed_signers.write_text(f"open-inspect@example.com {PUBLIC_KEY}\n")
    git(repo, "config", "gpg.ssh.allowedSignersFile", str(allowed_signers))
    manifest = create_manifest(tmp_path, [repo])
    signer_path = create_remote_signer(tmp_path)
    runtime = create_runtime(tmp_path, manifest, signer_path=signer_path)

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION,
        GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com"),
    )

    assert git(repo, "config", "gpg.ssh.program").stdout.strip() == str(signer_path)
    assert git(repo, "config", "user.signingkey").stdout.strip() == f"key::{PUBLIC_KEY}"
    (repo / "change.txt").write_text("signed\n")
    git(repo, "add", "change.txt")
    git(repo, "commit", "-m", "signed change")
    assert git(repo, "show", "-s", "--format=%an|%ae|%cn|%ce").stdout.strip() == (
        "Jane Dev|123+jane@users.noreply.github.com|Open Inspect|open-inspect@example.com"
    )
    git(repo, "verify-commit", "HEAD")


@pytest.mark.asyncio
async def test_enabled_agent_only_mode_uses_committer_as_author(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(
        tmp_path,
        manifest,
        signer_path=create_remote_signer(tmp_path),
    )

    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)

    (repo / "change.txt").write_text("agent-only\n")
    git(repo, "add", "change.txt")
    git(repo, "commit", "-m", "agent-only change")
    assert git(repo, "show", "-s", "--format=%an|%ae|%cn|%ce").stdout.strip() == (
        "Open Inspect|open-inspect@example.com|Open Inspect|open-inspect@example.com"
    )


@pytest.mark.asyncio
async def test_recreated_and_synthesized_commits_remain_signed(tmp_path):
    repo = create_repository(tmp_path / "repo")
    main_branch = git(repo, "branch", "--show-current").stdout.strip()
    allowed_signers = tmp_path / "allowed_signers"
    allowed_signers.write_text(f"open-inspect@example.com {PUBLIC_KEY}\n")
    git(repo, "config", "gpg.ssh.allowedSignersFile", str(allowed_signers))
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(
        tmp_path,
        manifest,
        signer_path=create_remote_signer(tmp_path),
    )
    await runtime.apply_configuration(
        ENABLED_CONFIGURATION,
        GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com"),
    )

    def commit_file(filename: str, message: str) -> str:
        (repo / filename).write_text(f"{message}\n")
        git(repo, "add", filename)
        git(repo, "commit", "-m", message)
        return git(repo, "rev-parse", "HEAD").stdout.strip()

    commits: list[str] = [commit_file("normal.txt", "normal")]
    (repo / "normal.txt").write_text("amended\n")
    git(repo, "add", "normal.txt")
    git(repo, "commit", "--amend", "--no-edit")
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "feature")
    commits.append(commit_file("feature.txt", "feature"))
    git(repo, "switch", main_branch)
    commits.append(commit_file("main.txt", "main update"))
    git(repo, "merge", "--no-ff", "feature", "-m", "merge feature")
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "cherry-source")
    cherry_source = commit_file("cherry.txt", "cherry source")
    git(repo, "switch", main_branch)
    git(repo, "cherry-pick", cherry_source)
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "rebase-source")
    commit_file("rebase.txt", "rebase source")
    git(repo, "switch", main_branch)
    commits.append(commit_file("base.txt", "rebase base"))
    git(repo, "switch", "rebase-source")
    git(repo, "rebase", main_branch)
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    for commit in commits:
        git(repo, "verify-commit", commit)
        assert git(repo, "show", "-s", "--format=%an|%cn", commit).stdout.strip() == (
            "Jane Dev|Open Inspect"
        )


@pytest.mark.asyncio
async def test_signer_failure_leaves_work_staged_and_uncommitted(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    unavailable_signer = tmp_path / "oi-git-sign"
    unavailable_signer.write_text("#!/bin/sh\nexit 1\n")
    unavailable_signer.chmod(0o755)
    runtime = create_runtime(tmp_path, manifest, signer_path=unavailable_signer)
    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)
    (repo / "change.txt").write_text("uncommitted\n")
    git(repo, "add", "change.txt")

    result = git(repo, "commit", "-m", "must fail", check=False)

    assert result.returncode != 0
    assert git(repo, "rev-parse", "--verify", "HEAD", check=False).returncode != 0
    assert git(repo, "diff", "--cached", "--name-only").stdout.strip() == "change.txt"


@pytest.mark.asyncio
async def test_refresh_fetches_the_session_broker_with_sandbox_auth(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr("sandbox_runtime.git_signing.httpx.AsyncClient", client_factory)
    runtime = create_runtime(tmp_path, manifest, control_plane_url="https://control.example.com/")

    await runtime.refresh(GitUser(name="Jane Dev", email="jane@example.com"))

    assert len(requests) == 1
    assert str(requests[0].url) == "https://control.example.com/sessions/session-1/commit-signing"
    assert requests[0].headers["Authorization"] == "Bearer sandbox-token"
    assert git(repo, "config", "user.name").stdout.strip() == "Jane Dev"


@pytest.mark.asyncio
async def test_non_github_refresh_never_depends_on_signing_broker(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    runtime = create_runtime(
        tmp_path,
        create_manifest(tmp_path, [repo]),
        scm_provider="gitea",
    )
    client = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.git_signing.httpx.AsyncClient", client)

    await runtime.refresh(GitUser(name="Gitea User", email="user@gitea.example.com"))

    client.assert_not_called()
    assert git(repo, "config", "user.name").stdout.strip() == "Gitea User"
    assert git(repo, "config", "user.email").stdout.strip() == "user@gitea.example.com"
    assert git(repo, "config", "--get", "commit.gpgsign", check=False).returncode == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("transient_status", [408, 425, 429, 503])
async def test_refresh_retries_transient_broker_failures(
    tmp_path, monkeypatch: pytest.MonkeyPatch, transient_status: int
):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) < 3:
            return httpx.Response(transient_status, json={"error": "temporary"})
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", sleep)
    repo = create_repository(tmp_path / "repo")
    runtime = create_runtime(tmp_path, create_manifest(tmp_path, [repo]))

    await runtime.refresh(None)

    assert len(requests) == 3
    assert [call.args[0] for call in sleep.await_args_list] == [0.25, 0.5]


@pytest.mark.asyncio
async def test_refresh_retries_transport_failure(tmp_path, monkeypatch: pytest.MonkeyPatch):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            raise httpx.ConnectError("temporary", request=request)
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", AsyncMock())
    repo = create_repository(tmp_path / "repo")
    runtime = create_runtime(tmp_path, create_manifest(tmp_path, [repo]))

    await runtime.refresh(None)

    assert len(requests) == 2


@pytest.mark.asyncio
async def test_refresh_does_not_retry_permanent_broker_rejection(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(401, json={"error": "unauthorized"})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", sleep)
    repo = create_repository(tmp_path / "repo")
    runtime = create_runtime(tmp_path, create_manifest(tmp_path, [repo]))

    with pytest.raises(RuntimeError, match="Commit signing configuration unavailable"):
        await runtime.refresh(None)

    assert len(requests) == 1
    sleep.assert_not_awaited()


@pytest.mark.asyncio
async def test_enabled_configuration_cache_bridges_a_transient_outage(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(200, json=ENABLED_CONFIGURATION)
        return httpx.Response(503, json={"error": "temporary"})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", AsyncMock())
    runtime = create_runtime(tmp_path, create_manifest(tmp_path, [repo]), scm_provider="github")
    first_author = GitUser(name="First User", email="first@example.com")
    second_author = GitUser(name="Second User", email="second@example.com")

    await runtime.refresh(first_author)
    await runtime.refresh(second_author)

    assert len(requests) == 4
    assert git(repo, "config", "user.name").stdout.strip() == "Second User"
    assert git(repo, "config", "commit.gpgsign").stdout.strip() == "true"


@pytest.mark.asyncio
async def test_enabled_configuration_cache_never_hides_permanent_rejection(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    responses = iter(
        [
            httpx.Response(200, json=ENABLED_CONFIGURATION),
            httpx.Response(401, json={"error": "unauthorized"}),
        ]
    )
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _request: next(responses))
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(
        tmp_path,
        create_manifest(tmp_path, [repo]),
        scm_provider="github",
    )

    await runtime.refresh(None)
    with pytest.raises(RuntimeError, match="Commit signing configuration unavailable"):
        await runtime.refresh(None)


@pytest.mark.asyncio
async def test_enabled_configuration_cache_expires(tmp_path, monkeypatch: pytest.MonkeyPatch):
    repo = create_repository(tmp_path / "repo")
    responses = iter(
        [
            httpx.Response(200, json=ENABLED_CONFIGURATION),
            httpx.Response(503, json={"error": "temporary"}),
            httpx.Response(503, json={"error": "temporary"}),
            httpx.Response(503, json={"error": "temporary"}),
        ]
    )
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _request: next(responses))
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", AsyncMock())
    runtime = create_runtime(
        tmp_path,
        create_manifest(tmp_path, [repo]),
        scm_provider="github",
    )

    await runtime.refresh(None)
    runtime._cached_configuration_at = 0.0
    with pytest.raises(RuntimeError, match="Commit signing configuration unavailable"):
        await runtime.refresh(None)


@pytest.mark.asyncio
async def test_repository_free_session_never_depends_on_signing_broker(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    runtime = create_runtime(tmp_path, create_manifest(tmp_path), scm_provider="github")
    client = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.git_signing.httpx.AsyncClient", client)

    await runtime.refresh(None)

    client.assert_not_called()


@pytest.mark.asyncio
async def test_disabled_github_configuration_never_falls_back_from_cache(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    responses = iter(
        [
            httpx.Response(200, json={"enabled": False}),
            httpx.Response(503, json={"error": "temporary"}),
            httpx.Response(503, json={"error": "temporary"}),
            httpx.Response(503, json={"error": "temporary"}),
        ]
    )
    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(lambda _request: next(responses))
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", AsyncMock())
    repo = create_repository(tmp_path / "repo")
    runtime = create_runtime(
        tmp_path,
        create_manifest(tmp_path, [repo]),
        scm_provider="github",
    )

    await runtime.refresh(None)
    with pytest.raises(RuntimeError, match="Commit signing configuration unavailable"):
        await runtime.refresh(None)


@pytest.mark.asyncio
async def test_enabled_configuration_applies_to_every_manifest_repository(tmp_path):
    repositories = [
        create_repository(tmp_path / "first"),
        create_repository(tmp_path / "second"),
    ]
    manifest = create_manifest(tmp_path, repositories)
    runtime = create_runtime(tmp_path, manifest)

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com")
    )

    for repository in repositories:
        assert git(repository, "config", "author.name").stdout.strip() == "Jane Dev"
        assert git(repository, "config", "committer.name").stdout.strip() == "Open Inspect"
        assert git(repository, "config", "commit.gpgsign").stdout.strip() == "true"


@pytest.mark.asyncio
async def test_reapplying_enabled_configuration_repairs_drift_and_updates_participant(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(tmp_path, manifest)
    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com")
    )
    git(repo, "config", "--add", "user.signingkey", "key::externally-added")
    git(repo, "config", "--add", "commit.gpgsign", "false")

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Ada Dev", email="456+ada@users.noreply.github.com")
    )

    assert git(repo, "config", "--get-all", "user.signingkey").stdout.splitlines() == [
        f"key::{PUBLIC_KEY}"
    ]
    assert git(repo, "config", "--get-all", "commit.gpgsign").stdout.splitlines() == ["true"]
    assert git(repo, "config", "author.name").stdout.strip() == "Ada Dev"
    assert git(repo, "config", "author.email").stdout.strip() == (
        "456+ada@users.noreply.github.com"
    )
    assert git(repo, "config", "user.name").stdout.strip() == "Ada Dev"
    assert git(repo, "config", "user.email").stdout.strip() == "456+ada@users.noreply.github.com"
    assert git(repo, "config", "committer.name").stdout.strip() == "Open Inspect"
    assert git(repo, "config", "committer.email").stdout.strip() == ("open-inspect@example.com")


@pytest.mark.asyncio
async def test_reapplying_disabled_configuration_removes_external_signing_state(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(tmp_path, manifest)
    await runtime.apply_configuration({"enabled": False}, None)
    git(repo, "config", "user.signingkey", "key::externally-added")
    git(repo, "config", "commit.gpgsign", "true")

    await runtime.apply_configuration({"enabled": False}, None)

    assert git(repo, "config", "--get", "user.signingkey", check=False).returncode == 1
    assert git(repo, "config", "--get", "commit.gpgsign", check=False).returncode == 1


@pytest.mark.asyncio
async def test_enabled_disabled_transition_reconciles_owned_config_only(tmp_path):
    repo = create_repository(tmp_path / "repo")
    unowned_key = "gpg.ssh.allowedSignersFile"
    unowned_value = str(tmp_path / "allowed-signers")
    git(repo, "config", unowned_key, unowned_value)
    runtime = create_runtime(tmp_path, create_manifest(tmp_path, [repo]))
    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)

    await runtime.apply_configuration({"enabled": False}, None)

    for key in OWNED_SIGNING_CONFIG_KEYS:
        assert git(repo, "config", "--get", key, check=False).returncode == 1
    assert git(repo, "config", unowned_key).stdout.strip() == unowned_value
    assert git(repo, "config", "user.name").stdout.strip() == "OpenInspect"
    assert git(repo, "config", "user.email").stdout.strip() == (
        "open-inspect@noreply.open-inspect.invalid"
    )

    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)

    assert git(repo, "config", "author.name").stdout.strip() == "Open Inspect"
    assert git(repo, "config", "committer.name").stdout.strip() == "Open Inspect"
    assert git(repo, "config", "gpg.format").stdout.strip() == "ssh"
    assert git(repo, "config", "user.signingkey").stdout.strip() == f"key::{PUBLIC_KEY}"
    assert git(repo, "config", "commit.gpgsign").stdout.strip() == "true"
    assert git(repo, "config", unowned_key).stdout.strip() == unowned_value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "payload"),
    [
        (503, {"error": "unavailable"}),
        (200, {"enabled": True}),
        (200, ["not", "an", "object"]),
        (
            200,
            {
                "enabled": True,
                "committerName": "Open Inspect",
                "committerEmail": "open-inspect@example.com",
                "publicKey": PUBLIC_KEY,
                "privateKey": PRIVATE_KEY,
            },
        ),
    ],
)
async def test_refresh_blocks_on_non_success_or_malformed_broker_results(
    tmp_path, monkeypatch: pytest.MonkeyPatch, status: int, payload
):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    monkeypatch.setattr("sandbox_runtime.git_signing.asyncio.sleep", AsyncMock())
    runtime = create_runtime(tmp_path, manifest)

    with pytest.raises(RuntimeError, match=r"commit signing configuration|Commit signing"):
        await runtime.refresh(GitUser(name="OpenInspect", email="open-inspect@example.com"))


@pytest.mark.asyncio
async def test_multi_repo_preflight_prevents_partial_configuration(tmp_path):
    first = create_repository(tmp_path / "first")
    missing = tmp_path / "missing"
    missing.mkdir()
    manifest = create_manifest(tmp_path, [first, missing])
    runtime = create_runtime(tmp_path, manifest)

    with pytest.raises(RuntimeError, match="repository is unavailable"):
        await runtime.apply_configuration(ENABLED_CONFIGURATION, None)

    assert git(first, "config", "--get", "commit.gpgsign", check=False).returncode == 1


@pytest.mark.asyncio
async def test_refresh_blocks_when_the_repository_manifest_is_unavailable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, tmp_path / "missing-manifest.json")

    with pytest.raises(RuntimeError, match="repository manifest"):
        await runtime.refresh(None)


@pytest.mark.asyncio
async def test_initialize_fetches_public_configuration_without_creating_key_files(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ENABLED_CONFIGURATION)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, manifest)

    await runtime.initialize(GitUser(name="OpenInspect", email="open-inspect@example.com"))

    assert not (tmp_path / "runtime").exists()


@pytest.mark.asyncio
async def test_default_signer_uses_the_configured_runtime_bin(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    install_dir = tmp_path / "runtime-bin"
    monkeypatch.setenv("OPENINSPECT_BIN_INSTALL_DIR", str(install_dir))
    runtime = GitSigningRuntime(
        control_plane_url="https://control.example.com",
        session_id="session-1",
        auth_token="sandbox-token",
        repo_manifest_path=manifest,
    )

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION,
        GitUser(name="OpenInspect", email="open-inspect@example.com"),
    )

    assert git(repo, "config", "gpg.ssh.program").stdout.strip() == str(install_dir / "oi-git-sign")
