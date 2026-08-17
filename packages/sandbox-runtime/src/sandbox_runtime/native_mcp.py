"""Built-in MCP tools shared by Codex and Claude native harnesses."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import quote

import httpx
from mcp.server.fastmcp import FastMCP

from .constants import REPO_MANIFEST_FILE_PATH

mcp = FastMCP(
    "Open Inspect",
    instructions=(
        "Open-Inspect control-plane tools. Respect each tool's authorization wording, "
        "especially for externally visible Slack messages and child sessions."
    ),
)


class ToolRequestError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code


class ControlPlaneToolClient:
    def __init__(self, environment: dict[str, str] | None = None) -> None:
        env = environment or dict(os.environ)
        self.base_url = env.get("CONTROL_PLANE_URL", "http://localhost:8787").rstrip("/")
        self.token = env.get("SANDBOX_AUTH_TOKEN", "")
        self.session_id = _session_id(env.get("SESSION_CONFIG", "{}"))

    async def request(
        self, method: str, path: str, *, body: dict[str, object] | None = None
    ) -> object:
        if not self.token:
            raise RuntimeError("SANDBOX_AUTH_TOKEN is unavailable")
        if not self.session_id:
            raise RuntimeError("session ID is unavailable")
        url = f"{self.base_url}/sessions/{self.session_id}{path}"
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.request(
                method,
                url,
                headers={"Authorization": f"Bearer {self.token}"},
                json=body,
            )
        if response.is_error:
            raise ToolRequestError(response.status_code, _error_detail(response))
        try:
            return response.json()
        except ValueError:
            return response.text


def _client() -> ControlPlaneToolClient:
    return ControlPlaneToolClient()


@mcp.tool(name="create_pull_request")
async def create_pull_request(
    title: str,
    body: str,
    base_branch: str | None = None,
    repo: str | None = None,
    draft: bool | None = None,
) -> str:
    """Create or update a pull request for committed changes using platform auth.

    Call after committing. Do not use the gh CLI. In a multi-repository session,
    repo must be the exact owner/name from the session.
    """
    try:
        target = _resolve_repository(repo)
        head_branch = await asyncio.to_thread(_current_branch, target.get("path"))
        payload: dict[str, object] = {
            "title": title,
            "body": body,
            "headBranch": head_branch,
            "timestamp": int(time.time() * 1000),
        }
        if base_branch is not None:
            payload["baseBranch"] = base_branch
        if draft is not None:
            payload["draft"] = draft
        if target.get("owner") and target.get("name"):
            payload["repoOwner"] = target["owner"]
            payload["repoName"] = target["name"]
        result = await _client().request("POST", "/pr", body=payload)
        if not isinstance(result, dict):
            return f"Pull request request completed: {result}"
        if result.get("status") == "manual" and result.get("createPrUrl"):
            return f"Branch pushed. Finish creating the pull request at {result['createPrUrl']}"
        action = "updated" if result.get("updated") else "created"
        return (
            f"Pull request {action}: #{result.get('prNumber', '?')} "
            f"{result.get('prUrl', '')}".strip()
        )
    except Exception as error:
        return _failure("create pull request", error)


@mcp.tool(name="spawn_child")
async def spawn_child(
    title: str,
    prompt: str,
    model: str | None = None,
    reasoning: str | None = None,
) -> str:
    """Spawn a separate child sandbox only when the user explicitly asks for a child session.

    Do not infer this authorization from requests for subagents, subtasks, or parallel work.
    """
    body: dict[str, object] = {"title": title, "prompt": prompt}
    if model:
        body["model"] = model
    if reasoning:
        body["reasoningEffort"] = reasoning
    try:
        result = await _client().request("POST", "/children", body=body)
        return _json_result(result)
    except Exception as error:
        return _failure("spawn child", error)


@mcp.tool(name="get_child_status")
async def get_child_status(
    child_id: str | None = None,
    include_response: bool = False,
    include_trajectory: bool = False,
    trajectory_limit: int | None = None,
    trajectory_cursor: str | None = None,
    include_event_data: bool = False,
) -> str:
    """Read child-session status when its result is needed; do not poll repeatedly."""
    path = "/children"
    if child_id:
        query: list[str] = []
        options = {
            "includeResponse": include_response,
            "includeTrajectory": include_trajectory or include_event_data,
            "includeEventData": include_event_data,
        }
        query.extend(f"{key}=true" for key, value in options.items() if value)
        if trajectory_limit is not None:
            query.append(f"trajectoryLimit={trajectory_limit}")
        if trajectory_cursor:
            query.append(f"trajectoryCursor={quote(trajectory_cursor, safe='')}")
        path += f"/{quote(child_id, safe='')}"
        if query:
            path += "?" + "&".join(query)
    try:
        return _json_result(await _client().request("GET", path))
    except Exception as error:
        return _failure("get child status", error)


@mcp.tool(name="send_child_prompt")
async def send_child_prompt(child_id: str, prompt: str) -> str:
    """Queue a follow-up prompt for a direct child; it does not interrupt active work."""
    try:
        result = await _client().request(
            "POST",
            f"/children/{quote(child_id, safe='')}/prompt",
            body={"content": prompt},
        )
        return _json_result(result)
    except Exception as error:
        return _failure("send child prompt", error)


@mcp.tool(name="cancel_child")
async def cancel_child(child_id: str, cancel_nested: bool = True) -> str:
    """Cancel a child only when requested or clearly obsolete; nested children default to cancel."""
    try:
        result = await _client().request(
            "POST",
            f"/children/{quote(child_id, safe='')}/cancel",
            body={"cancelNested": cancel_nested},
        )
        return _json_result(result)
    except Exception as error:
        return _failure("cancel child", error)


@mcp.tool(name="slack_notify")
async def slack_notify(
    channel: str,
    text: str,
    thread_ts: str | None = None,
    reason: str | None = None,
) -> str:
    """Post to an authorized Slack channel only when the user explicitly asks you to notify it."""
    try:
        result = await _client().request(
            "POST",
            "/slack-notify",
            body={"channel": channel, "text": text, "thread_ts": thread_ts, "reason": reason},
        )
        return _json_result(result)
    except Exception as error:
        return _failure("notify Slack", error)


def _session_id(raw_config: str) -> str:
    try:
        config = json.loads(raw_config)
    except json.JSONDecodeError:
        return ""
    if not isinstance(config, dict):
        return ""
    value = config.get("sessionId") or config.get("session_id")
    return value if isinstance(value, str) else ""


def _repositories() -> list[dict[str, str]]:
    try:
        payload = json.loads(Path(REPO_MANIFEST_FILE_PATH).read_text())
    except (OSError, json.JSONDecodeError):
        return []
    raw_repositories = payload.get("repositories") if isinstance(payload, dict) else None
    if not isinstance(raw_repositories, list):
        return []
    repositories: list[dict[str, str]] = []
    for raw in raw_repositories:
        if not isinstance(raw, dict):
            continue
        entry = {
            "owner": str(raw.get("owner") or "").strip(),
            "name": str(raw.get("name") or "").strip(),
            "path": str(raw.get("path") or "").strip(),
        }
        if all(entry.values()):
            repositories.append(entry)
    return repositories


def _resolve_repository(repo: str | None) -> dict[str, str]:
    repositories = _repositories()
    if repo:
        normalized = repo.strip().casefold()
        for repository in repositories:
            if f"{repository['owner']}/{repository['name']}".casefold() == normalized:
                return repository
        choices = ", ".join(f"{item['owner']}/{item['name']}" for item in repositories)
        if choices:
            raise ValueError(f"repository is not in this session; choose one of: {choices}")
        separator = repo.rfind("/")
        if separator <= 0 or separator == len(repo) - 1:
            raise ValueError('repo must be "owner/name"')
        return {"owner": repo[:separator], "name": repo[separator + 1 :], "path": ""}
    if len(repositories) > 1:
        choices = ", ".join(f"{item['owner']}/{item['name']}" for item in repositories)
        raise ValueError(f"repo is required for a multi-repository session: {choices}")
    return repositories[0] if repositories else {"owner": "", "name": "", "path": ""}


def _current_branch(repo_path: str | None) -> str | None:
    command = ["git"]
    if repo_path:
        command.extend(["-C", repo_path])
    command.extend(["rev-parse", "--abbrev-ref", "HEAD"])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    branch = result.stdout.strip()
    return branch if branch and branch != "HEAD" else None


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text or f"HTTP {response.status_code}"
    if isinstance(payload, dict):
        detail = payload.get("error") or payload.get("message")
        if isinstance(detail, str):
            return detail
    return json.dumps(payload, default=str)


def _failure(action: str, error: Exception) -> str:
    if isinstance(error, ToolRequestError):
        return f"Failed to {action}: {error} (HTTP {error.status_code})"
    return f"Failed to {action}: {error}"


def _json_result(result: object) -> str:
    return json.dumps(result, ensure_ascii=False, default=str)


if __name__ == "__main__":
    mcp.run(transport="stdio")
