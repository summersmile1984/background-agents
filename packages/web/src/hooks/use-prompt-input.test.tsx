// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { usePromptInput } from "./use-prompt-input";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  sendTyping: vi.fn(),
  clearAttachments: vi.fn(),
  uploadAll: vi.fn(),
}));

vi.mock("@/hooks/use-session-attachments", () => ({
  DEFAULT_ATTACHMENT_ONLY_MESSAGE: "See the attached files.",
  useSessionAttachments: () => ({
    attachments: [],
    attachmentError: null,
    isUploading: false,
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: mocks.clearAttachments,
    hasAttachments: () => false,
    uploadAll: mocks.uploadAll,
  }),
}));

function PromptHarness({ canSubmit }: { canSubmit: boolean }) {
  const prompt = usePromptInput(
    "session-1",
    mocks.sendPrompt,
    mocks.sendTyping,
    "model-1",
    undefined,
    false,
    "active",
    canSubmit
  );

  return (
    <form onSubmit={prompt.handleSubmit}>
      <textarea
        aria-label="Prompt"
        value={prompt.prompt}
        onChange={prompt.handleInputChange}
        onKeyDown={prompt.handleKeyDown}
      />
      <button type="button" onClick={() => prompt.setVisualVerificationRequested(true)}>
        Verify UI
      </button>
      <button type="submit">Send</button>
    </form>
  );
}

beforeEach(() => {
  mocks.sendPrompt.mockReset();
  mocks.sendTyping.mockReset();
  mocks.clearAttachments.mockReset();
  mocks.uploadAll.mockReset();
});

afterEach(cleanup);

describe("usePromptInput", () => {
  it("accepts draft edits but blocks the send shortcut before the session is ready", () => {
    render(<PromptHarness canSubmit={false} />);

    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Draft while connecting" } });
    expect(input).toHaveValue("Draft while connecting");

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(input).toHaveValue("Draft while connecting");
  });

  it("sends an explicit visual verification selection and clears it after acknowledgement", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("request-1");
    mocks.sendPrompt.mockResolvedValue({
      ok: true,
      clientRequestId: "request-1",
      messageId: "message-1",
      position: 1,
    });
    render(<PromptHarness canSubmit />);

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Check the responsive layout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify UI" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mocks.sendPrompt).toHaveBeenCalledWith(
        "Check the responsive layout",
        "model-1",
        undefined,
        undefined,
        "request-1",
        {}
      );
    });
  });
});
