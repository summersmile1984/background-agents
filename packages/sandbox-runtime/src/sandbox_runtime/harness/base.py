"""Small provider contract owned by the sandbox bridge.

The control-plane WebSocket remains the stable product protocol. Drivers only
translate one harness' native transport into that existing event vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from ..verification_manifest import load_visual_verification_policy

VISUAL_VERIFICATION_POLICY_ENV = "OPENINSPECT_VISUAL_VERIFICATION_POLICY"
VISUAL_VERIFICATION_SYSTEM_INSTRUCTION = (
    "Open-Inspect platform visual verification is enabled. When the user requests browser/UI "
    "verification or repository policy requires it, invoke `oi-visual-verify` with its versioned "
    "JSON request. Only call a UI change visually verified when the command's final JSON has "
    "status `passed` and non-empty artifact IDs; for `failed` or `blocked`, state what remains "
    "unverified and never claim that verification passed."
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Mapping

    from ..attachment_processor import HydratedSessionAttachment
    from ..types import AgentHarness


@dataclass(frozen=True)
class HarnessPrompt:
    message_id: str
    content: str
    model: str | None = None
    reasoning_effort: str | None = None
    attachments: list[HydratedSessionAttachment] | None = None


def visual_verification_system_instruction(environment: Mapping[str, str]) -> str | None:
    """Return the platform instruction only when the host-owned policy enables it."""
    policy = load_visual_verification_policy(environment.get(VISUAL_VERIFICATION_POLICY_ENV))
    return VISUAL_VERIFICATION_SYSTEM_INSTRUCTION if policy.enabled else None


def merge_system_instructions(*parts: str | None) -> str | None:
    """Join independent instruction sources without empty separators or mutation."""
    values = [part.strip() for part in parts if part and part.strip()]
    return "\n\n".join(values) if values else None


class HarnessDriver(Protocol):
    """Lifecycle and prompt surface implemented by each native harness."""

    harness: AgentHarness

    @property
    def session_id(self) -> str | None: ...

    async def start(self, existing_session_id: str | None = None) -> str | None: ...

    def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]: ...

    async def stop(self, *, reason: str) -> bool: ...

    async def close(self) -> None: ...
