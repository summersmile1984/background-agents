"""OpenCode adapter for the generic harness contract."""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..prompt_stream import OpenCodePromptStream
from ..types import AgentHarness

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger
    from ..opencode_client import OpenCodeClient
    from .base import HarnessPrompt


class OpenCodeHarnessDriver:
    harness = AgentHarness.OPENCODE

    def __init__(
        self,
        *,
        client: OpenCodeClient,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        sse_inactivity_timeout_seconds: float,
        prompt_max_duration_seconds: float,
        prompt_cleanup_timeout_seconds: float,
    ) -> None:
        self._client = client
        self._log = log
        self._session_id: str | None = None
        self._stream = OpenCodePromptStream(
            client=client,
            attachment_processor=attachment_processor,
            log=log,
            sse_inactivity_timeout_seconds=sse_inactivity_timeout_seconds,
            prompt_max_duration_seconds=prompt_max_duration_seconds,
            prompt_cleanup_timeout_seconds=prompt_cleanup_timeout_seconds,
        )

    @property
    def session_id(self) -> str | None:
        return self._session_id

    async def start(self, existing_session_id: str | None = None) -> str:
        if existing_session_id:
            try:
                if await self._client.session_exists(existing_session_id):
                    self._session_id = existing_session_id
                    return existing_session_id
            except Exception as error:
                self._log.warn("harness.session_resume_failed", harness=self.harness, exc=error)
        self._session_id = await self._client.create_session()
        if not self._session_id:
            raise RuntimeError("OpenCode returned no session ID")
        return self._session_id

    async def stream_prompt(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, object]]:
        if not self._session_id:
            raise RuntimeError("OpenCode session not initialized")
        async for event in self._stream.stream_prompt(
            opencode_session_id=self._session_id,
            message_id=prompt.message_id,
            content=prompt.content,
            model=prompt.model,
            reasoning_effort=prompt.reasoning_effort,
            attachments=prompt.attachments,
        ):
            yield event

    async def stop(self, *, reason: str) -> bool:
        return await self._client.request_stop(self._session_id, reason=reason)

    async def close(self) -> None:
        await self._client.aclose()
