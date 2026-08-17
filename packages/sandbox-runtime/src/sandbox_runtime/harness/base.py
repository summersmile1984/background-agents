"""Small provider contract owned by the sandbox bridge.

The control-plane WebSocket remains the stable product protocol. Drivers only
translate one harness' native transport into that existing event vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from ..attachment_processor import HydratedSessionAttachment
    from ..types import AgentHarness


@dataclass(frozen=True)
class HarnessPrompt:
    message_id: str
    content: str
    model: str | None = None
    reasoning_effort: str | None = None
    attachments: list[HydratedSessionAttachment] | None = None


class HarnessDriver(Protocol):
    """Lifecycle and prompt surface implemented by each native harness."""

    harness: AgentHarness

    @property
    def session_id(self) -> str | None: ...

    async def start(self, existing_session_id: str | None = None) -> str | None: ...

    def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]: ...

    async def stop(self, *, reason: str) -> bool: ...

    async def close(self) -> None: ...
