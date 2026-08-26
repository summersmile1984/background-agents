import { describe, expect, it } from "vitest";
import { canReuseThreadSession } from "./dispatcher";

const thread = {
  sessionId: "session-1",
  repositoryKey: "gitea-default:huangdong/chatbi",
  targetLabel: "huangdong/chatbi",
  model: "openai/gpt-5.6-luna",
  actorId: "feishu:tenant:user",
  createdAt: 1,
} as const;

describe("canReuseThreadSession", () => {
  it("does not route a native model to a legacy harness-unknown session", () => {
    expect(canReuseThreadSession(thread, "openai/gpt-5.6-luna")).toBe(false);
  });

  it("reuses a session only when its current model and harness both match", () => {
    expect(canReuseThreadSession({ ...thread, harness: "codex" }, "openai/gpt-5.6-luna")).toBe(
      true
    );
    expect(canReuseThreadSession({ ...thread, harness: "opencode" }, "openai/gpt-5.6-luna")).toBe(
      false
    );
    expect(canReuseThreadSession({ ...thread, harness: "codex" }, "openai/gpt-5.6-sol")).toBe(
      false
    );
  });
});
