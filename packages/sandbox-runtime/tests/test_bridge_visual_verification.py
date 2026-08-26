"""Prompt-boundary tests for persisted visual verification reports."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime import bridge as bridge_module
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.types import AgentHarness
from sandbox_runtime.verification_manifest import VisualVerificationReport
from sandbox_runtime.visual_verification_store import StoredVisualVerification


async def successful_event_stream(*_args, **_kwargs):
    yield {
        "type": "token",
        "messageId": "msg-1",
        "content": "done",
    }


def stored_report(message_id: str = "msg-1") -> StoredVisualVerification:
    return StoredVisualVerification(
        requestDigest="a" * 64,
        report=VisualVerificationReport.model_validate(
            {
                "version": 1,
                "messageId": message_id,
                "status": "passed",
                "startedAt": "2026-08-27T00:00:00.000Z",
                "finishedAt": "2026-08-27T00:00:01.000Z",
                "scenarios": [
                    {
                        "id": "home",
                        "status": "passed",
                        "source": "service:web/",
                        "viewport": {"width": 800, "height": 600},
                        "assertions": [],
                        "artifactIds": ["capture-1"],
                        "durationMs": 1000,
                    }
                ],
                "failure": None,
            }
        ),
    )


def blocked_stored_report(message_id: str = "msg-1") -> StoredVisualVerification:
    return StoredVisualVerification(
        requestDigest="b" * 64,
        report=VisualVerificationReport.model_validate(
            {
                "version": 1,
                "messageId": message_id,
                "status": "blocked",
                "startedAt": "2026-08-27T00:00:00.000Z",
                "finishedAt": "2026-08-27T00:00:01.000Z",
                "scenarios": [],
                "failure": {"code": "service_not_ready", "message": "service not ready"},
            }
        ),
    )


def matrix_stored_report(
    status: str,
    failure_code: str | None,
    message_id: str = "msg-1",
) -> StoredVisualVerification:
    if status == "passed":
        return stored_report(message_id)
    scenario_status = "failed" if status == "failed" else "blocked"
    scenarios = (
        [
            {
                "id": "home",
                "status": scenario_status,
                "source": "service:web/",
                "viewport": {"width": 800, "height": 600},
                "assertions": [],
                "artifactIds": ["capture-1"] if status == "failed" else [],
                "durationMs": 1000,
            }
        ]
        if status == "failed"
        else []
    )
    return StoredVisualVerification(
        requestDigest="c" * 64,
        report=VisualVerificationReport.model_validate(
            {
                "version": 1,
                "messageId": message_id,
                "status": status,
                "startedAt": "2026-08-27T00:00:00.000Z",
                "finishedAt": "2026-08-27T00:00:01.000Z",
                "scenarios": scenarios,
                "failure": {
                    "code": failure_code,
                    "message": "Verification did not pass",
                    **({"scenarioId": "home"} if status == "failed" else {}),
                },
            }
        ),
    )


def policy(*, trigger: str = "explicit_only", completion: str = "report_only") -> str:
    return json.dumps(
        {
            "enabled": True,
            "trigger": trigger,
            "maxScenarios": 3,
            "maxCaptures": 4,
            "timeoutMs": 120000,
            "maxUploadBytes": 10485760,
            "allowedServiceNames": [],
            "allowRepositoryDeclaration": True,
            "allowVideo": False,
            "completionBehavior": completion,
        }
    )


@pytest.fixture
def prompt_bridge(monkeypatch: pytest.MonkeyPatch) -> AgentBridge:
    instance = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    instance.opencode_session_id = "oc-session-123"
    instance._configure_git_identity = AsyncMock()
    instance._stream_opencode_response_sse = successful_event_stream
    instance._send_event = AsyncMock()
    monkeypatch.setattr(bridge_module, "write_prompt_context", lambda _context: None)
    monkeypatch.setattr(
        bridge_module,
        "clear_prompt_context",
        lambda *, expected_message_id: expected_message_id,
    )
    return instance


@pytest.mark.asyncio
async def test_emits_persisted_report_before_execution_complete(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        bridge_module,
        "load_stored_visual_verification",
        lambda message_id: stored_report(message_id),
    )

    await prompt_bridge._handle_prompt(
        {
            "messageId": "msg-1",
            "content": "verify the page",
            "author": {"gitIdentity": {"mode": "agent-only"}},
        }
    )

    events = [call.args[0] for call in prompt_bridge._send_event.await_args_list]
    assert [event["type"] for event in events] == [
        "token",
        "visual_verification",
        "execution_complete",
    ]
    assert events[1] == {
        "type": "visual_verification",
        "messageId": "msg-1",
        "requestDigest": "a" * 64,
        "report": stored_report().report.model_dump(mode="json", by_alias=True),
    }
    assert events[2] == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": True,
    }


@pytest.mark.asyncio
async def test_invalid_persisted_report_does_not_crash_prompt_completion(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_load(_message_id: str):
        raise ValueError("unsafe report")

    monkeypatch.setattr(bridge_module, "load_stored_visual_verification", fail_load)

    await prompt_bridge._handle_prompt(
        {
            "messageId": "msg-1",
            "content": "verify the page",
            "author": {"gitIdentity": {"mode": "agent-only"}},
        }
    )

    events = [call.args[0] for call in prompt_bridge._send_event.await_args_list]
    assert [event["type"] for event in events] == ["token", "execution_complete"]
    assert events[-1]["success"] is True


@pytest.mark.asyncio
async def test_explicit_prompt_selection_runs_the_canonical_executor(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(return_value=({"status": "passed"}, 0))
    monkeypatch.setattr(bridge_module, "execute_idempotent_visual_verification", execute)
    monkeypatch.setattr(prompt_bridge, "_harness_workdir", lambda: Path("/workspace"))

    await prompt_bridge._run_platform_visual_verification(
        {
            "visualVerificationRequest": {
                "version": 1,
                "sessionId": "test-session",
                "messageId": "msg-1",
                "scenarioIds": ["home-desktop"],
                "reason": "user_requested",
            }
        },
        "msg-1",
        harness_succeeded=True,
    )

    request = execute.await_args.args[0]
    assert request.message_id == "msg-1"
    assert request.scenario_ids == ["home-desktop"]
    assert execute.await_args.kwargs["repository_root"] == Path("/workspace")


@pytest.mark.asyncio
async def test_always_after_success_derives_a_host_required_request(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "OPENINSPECT_VISUAL_VERIFICATION_POLICY", policy(trigger="always_after_success")
    )
    execute = AsyncMock(return_value=({"status": "passed"}, 0))
    monkeypatch.setattr(bridge_module, "execute_idempotent_visual_verification", execute)
    monkeypatch.setattr(prompt_bridge, "_harness_workdir", lambda: Path("/workspace"))

    await prompt_bridge._run_platform_visual_verification(
        {},
        "msg-1",
        harness_succeeded=True,
    )

    request = execute.await_args.args[0]
    assert request.reason == "host_required"
    assert request.session_id == "test-session"
    assert request.message_id == "msg-1"


@pytest.mark.asyncio
async def test_require_pass_marks_completion_unsuccessful_without_losing_report(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "OPENINSPECT_VISUAL_VERIFICATION_POLICY",
        policy(completion="require_pass"),
    )
    monkeypatch.setattr(
        bridge_module,
        "load_stored_visual_verification",
        lambda message_id: blocked_stored_report(message_id),
    )

    await prompt_bridge._handle_prompt(
        {
            "messageId": "msg-1",
            "content": "verify the page",
            "author": {"gitIdentity": {"mode": "agent-only"}},
        }
    )

    events = [call.args[0] for call in prompt_bridge._send_event.await_args_list]
    assert [event["type"] for event in events] == [
        "token",
        "visual_verification",
        "execution_complete",
    ]
    assert events[-1] == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": False,
        "error": "Visual verification was required but did not pass: blocked",
    }


@pytest.mark.asyncio
async def test_explicit_cancel_persists_report_before_terminal_event(
    prompt_bridge: AgentBridge,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cancelled = blocked_stored_report()
    assert cancelled.report.failure is not None
    cancelled.report.failure.code = "cancelled"
    persist = Mock(return_value=(cancelled.report.model_dump(mode="json", by_alias=True), 20))
    monkeypatch.setattr(bridge_module, "persist_blocked_visual_verification", persist)
    monkeypatch.setattr(
        bridge_module,
        "load_stored_visual_verification",
        lambda _message_id: cancelled,
    )

    await prompt_bridge._handle_cancelled_prompt(
        {
            "visualVerificationRequest": {
                "version": 1,
                "sessionId": "test-session",
                "messageId": "msg-1",
                "reason": "user_requested",
            }
        },
        "msg-1",
    )

    request = persist.call_args.args[0]
    assert request.session_id == "test-session"
    assert request.message_id == "msg-1"
    events = [call.args[0] for call in prompt_bridge._send_event.await_args_list]
    assert [event["type"] for event in events] == [
        "visual_verification",
        "execution_complete",
    ]
    assert events[0]["report"]["failure"]["code"] == "cancelled"
    assert events[1]["success"] is False


@pytest.mark.asyncio
async def test_cancel_without_explicit_verification_only_sends_terminal_event(
    prompt_bridge: AgentBridge,
) -> None:
    await prompt_bridge._handle_cancelled_prompt({}, "msg-1")

    events = [call.args[0] for call in prompt_bridge._send_event.await_args_list]
    assert [event["type"] for event in events] == ["execution_complete"]
    assert events[0]["error"] == "Task was cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("harness", list(AgentHarness))
@pytest.mark.parametrize(
    ("status", "failure_code", "exit_code"),
    [
        ("passed", None, 0),
        ("failed", "assertion_failed", 10),
        ("blocked", "service_not_ready", 20),
    ],
)
async def test_all_harnesses_share_the_visual_verification_boundary(
    harness: AgentHarness,
    status: str,
    failure_code: str | None,
    exit_code: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    instance = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        agent_harness=harness,
        agent_session_id="native-session",
    )
    instance.opencode_session_id = "oc-session" if harness == AgentHarness.OPENCODE else None
    instance._configure_git_identity = AsyncMock()
    instance._ensure_agent_session = AsyncMock()
    instance._stream_opencode_response_sse = successful_event_stream
    instance._stream_harness_response = successful_event_stream
    instance._send_event = AsyncMock()
    monkeypatch.setattr(instance, "_harness_workdir", lambda: Path("/workspace"))
    monkeypatch.setattr(bridge_module, "write_prompt_context", lambda _context: None)
    monkeypatch.setattr(
        bridge_module,
        "clear_prompt_context",
        lambda *, expected_message_id: expected_message_id,
    )
    stored = matrix_stored_report(status, failure_code)
    execute = AsyncMock(
        return_value=(stored.report.model_dump(mode="json", by_alias=True), exit_code)
    )
    monkeypatch.setattr(bridge_module, "execute_idempotent_visual_verification", execute)
    monkeypatch.setattr(
        bridge_module,
        "load_stored_visual_verification",
        lambda _message_id: stored,
    )

    await instance._handle_prompt(
        {
            "messageId": "msg-1",
            "content": "change and verify the page",
            "author": {"gitIdentity": {"mode": "agent-only"}},
            "visualVerificationRequest": {
                "version": 1,
                "sessionId": "test-session",
                "messageId": "msg-1",
                "reason": "user_requested",
            },
        }
    )

    assert execute.await_count == 1
    assert execute.await_args.args[0].message_id == "msg-1"
    events = [call.args[0] for call in instance._send_event.await_args_list]
    assert [event["type"] for event in events] == [
        "token",
        "visual_verification",
        "execution_complete",
    ]
    assert events[1]["report"]["status"] == status
    if status != "passed":
        assert events[1]["report"]["failure"]["code"] == failure_code
        assert "verification passed" not in json.dumps(events).lower()
