import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolveRuntimeLaunchDraftResponse } from "@open-inspect/shared/types/runtime-launch";
import type { Env } from "../types";

const mocks = vi.hoisted(() => ({
  replySessionCard: vi.fn(),
  replySessionText: vi.fn(),
  updateSessionCard: vi.fn(),
  claimCardActionOnce: vi.fn(),
  claimThreadSelection: vi.fn(),
  listConversationSessions: vi.fn(),
  lookupThreadSession: vi.fn(),
  releaseThreadSelection: vi.fn(),
  storeThreadSession: vi.fn(),
  updateThreadSession: vi.fn(),
  createResolvedSession: vi.fn(),
  sendPrompt: vi.fn(),
  resolveFeishuRuntimeDraft: vi.fn(),
  listEnvironmentTargets: vi.fn(),
  listRepositoryCatalog: vi.fn(),
  inferRepositoryTarget: vi.fn(),
  inferRepositoryBranch: vi.fn(),
  findRepositoryTarget: vi.fn(),
}));

vi.mock("../conversation/delivery", () => ({
  replySessionCard: mocks.replySessionCard,
  replySessionText: mocks.replySessionText,
  updateSessionCard: mocks.updateSessionCard,
}));
vi.mock("../conversation/store", () => ({
  claimCardActionOnce: mocks.claimCardActionOnce,
  claimThreadSelection: mocks.claimThreadSelection,
  listConversationSessions: mocks.listConversationSessions,
  lookupThreadSession: mocks.lookupThreadSession,
  releaseThreadSelection: mocks.releaseThreadSelection,
  storeThreadSession: mocks.storeThreadSession,
  updateThreadSession: mocks.updateThreadSession,
}));
vi.mock("../sessions/control-plane-client", () => ({
  createResolvedSession: mocks.createResolvedSession,
  sendPrompt: mocks.sendPrompt,
}));
vi.mock("../sessions/runtime-draft", () => ({
  resolveFeishuRuntimeDraft: mocks.resolveFeishuRuntimeDraft,
}));
vi.mock("../targets", () => ({
  listEnvironmentTargets: mocks.listEnvironmentTargets,
  listRepositoryCatalog: mocks.listRepositoryCatalog,
  inferRepositoryTarget: mocks.inferRepositoryTarget,
  inferRepositoryBranch: mocks.inferRepositoryBranch,
  findRepositoryTarget: mocks.findRepositoryTarget,
}));
vi.mock("../events/visual-verification", () => ({
  visualVerificationForPrompt: vi.fn().mockReturnValue(undefined),
}));

import {
  deliverSingleCardFollowUp,
  handleFeishuLaunchCardAction,
  initializeSingleCardLaunch,
  parseFeishuLaunchCardAction,
} from "./launch-card-actions";

class MemoryKv {
  private readonly data = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.data.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const repository = {
  repositoryKey: "repo-1",
  fullName: "open-inspect/background-agents",
  displayName: "background-agents",
  provider: "github" as const,
  connectionId: "github-main",
  connectionLabel: "GitHub",
  defaultBranch: "main",
};

function runtimeDraft(digest = "a".repeat(64)): ResolveRuntimeLaunchDraftResponse {
  const effort = { value: "high", label: "High", nativeValue: "high", isDefault: true };
  const model = {
    model: "openai/gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Fast model",
    category: "coding",
    routeId: "codex:openai:subscription",
    provider: "openai",
    enabled: true,
    ready: true,
    efforts: [effort],
    supportsAttachments: true,
    supportsToolEvents: true,
    supportsLiveModelSwitch: true,
  };
  const source = { scope: "integration" as const, id: "feishu" };
  return {
    resolverVersion: "1",
    capabilityCatalogVersion: "catalog-1",
    checkedAt: 1,
    draftDigest: digest,
    launchable: true,
    effective: {
      target: {
        kind: "repository",
        connectionId: "github-main",
        provider: "github",
        environmentId: null,
        repositories: [
          {
            repositoryKey: "repo-1",
            connectionId: "github-main",
            externalRepositoryId: "1",
            owner: "open-inspect",
            name: "background-agents",
            branch: "main",
            position: 0,
            webUrl: "https://github.com/open-inspect/background-agents",
            cloneUrl: "https://github.com/open-inspect/background-agents.git",
          },
        ],
      },
      harness: { value: "codex", source, inherited: true },
      routeId: { value: model.routeId, source, inherited: true },
      model: { value: model.model, source, inherited: true },
      effort: { value: "high", source, inherited: true },
      nativeEffort: "high",
      settings: {},
    },
    options: {
      harnesses: [
        {
          harness: "codex",
          displayName: "Codex",
          description: "OpenAI coding agent",
          enabled: true,
          runtimeAvailable: true,
          ready: true,
          settingsSchemaVersion: "1",
          settings: [],
          liveMutation: { model: false, effort: false, settings: [] },
          routes: [
            {
              routeId: model.routeId,
              harness: "codex",
              provider: "openai",
              transport: "native",
              displayName: "OpenAI subscription",
              ready: true,
              code: "READY",
              models: [model],
            },
          ],
        },
      ],
      models: [model],
      efforts: [effort],
      commands: [],
    },
    issues: [],
  };
}

function findActionValue(
  value: unknown,
  action: string,
  argument?: string
): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findActionValue(item, action, argument);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.tag === "button" && record.disabled === true) return null;
  if (
    record.value &&
    typeof record.value === "object" &&
    (record.value as Record<string, unknown>).action === action &&
    (argument === undefined || (record.value as Record<string, unknown>).argument === argument)
  ) {
    return record.value as Record<string, unknown>;
  }
  for (const child of Object.values(record)) {
    const found = findActionValue(child, action, argument);
    if (found) return found;
  }
  return null;
}

function actionPayload(value: Record<string, unknown>, eventId = "event-start") {
  return {
    header: { event_id: eventId, tenant_key: "tenant" },
    event: {
      context: { open_chat_id: "chat", open_message_id: "working-card-1" },
      operator: { open_id: "user" },
      action: { value },
    },
  };
}

function testEnv(): Env {
  return {
    FEISHU_KV: new MemoryKv() as unknown as KVNamespace,
    WEB_APP_URL: "https://open-inspect.example",
  } as Env;
}

describe("Feishu single-card launch actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.replySessionCard.mockResolvedValue({ messageId: "working-card-1" });
    mocks.replySessionText.mockResolvedValue({ messageId: "fallback-text-1" });
    mocks.updateSessionCard.mockResolvedValue({ messageId: "working-card-1" });
    mocks.claimCardActionOnce.mockResolvedValue(true);
    mocks.claimThreadSelection.mockResolvedValue(true);
    mocks.listConversationSessions.mockResolvedValue([]);
    mocks.lookupThreadSession.mockResolvedValue(null);
    mocks.releaseThreadSelection.mockResolvedValue(undefined);
    mocks.storeThreadSession.mockResolvedValue(undefined);
    mocks.updateThreadSession.mockResolvedValue(null);
    mocks.createResolvedSession.mockResolvedValue({
      ok: true,
      data: { sessionId: "session-1", status: "created" },
    });
    mocks.sendPrompt.mockResolvedValue({
      ok: true,
      data: { messageId: "prompt-1", status: "queued" },
    });
    mocks.resolveFeishuRuntimeDraft.mockResolvedValue({ ok: true, data: runtimeDraft() });
    mocks.listEnvironmentTargets.mockResolvedValue([]);
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: [{ id: "github-main", label: "GitHub", provider: "github" }],
      targets: [repository],
    });
    mocks.inferRepositoryTarget.mockReturnValue(repository);
    mocks.inferRepositoryBranch.mockReturnValue(null);
    mocks.findRepositoryTarget.mockImplementation(
      (targets: (typeof repository)[], key: string) =>
        targets.find((target) => target.repositoryKey === key) ?? null
    );
  });

  it("parses JSON 2.0 button and form callbacks with immutable actor coordinates", () => {
    const value = {
      schemaVersion: 2,
      action: "apply_runtime_settings",
      pendingId: "00000000-0000-4000-8000-000000000001",
      selectionRevision: 2,
    };
    expect(
      parseFeishuLaunchCardAction({
        ...actionPayload(value),
        event: {
          ...actionPayload(value).event,
          action: { value, form_value: { runtime_setting_0: "42" } },
        },
      })
    ).toMatchObject({
      value,
      formValue: { runtime_setting_0: "42" },
      tenantKey: "tenant",
      chatId: "chat",
      messageId: "working-card-1",
      openId: "user",
    });
    expect(parseFeishuLaunchCardAction(actionPayload({ ...value, schemaVersion: 1 }))).toBeNull();
  });

  it("creates one reply card and then mutates that same message through the launch lifecycle", async () => {
    const env = testEnv();
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "修复 background-agents",
      incomingMessageId: "incoming-1",
      traceId: "trace-1",
    });

    expect(mocks.replySessionCard).toHaveBeenCalledOnce();
    expect(mocks.updateSessionCard).toHaveBeenCalledOnce();
    expect(mocks.updateSessionCard).toHaveBeenCalledWith(
      env,
      "working-card-1",
      expect.objectContaining({ schema: "2.0" })
    );
    expect(mocks.createResolvedSession).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();

    const launchCard = mocks.updateSessionCard.mock.calls[0]?.[2];
    const startValue = findActionValue(launchCard, "start_session");
    expect(startValue).not.toBeNull();

    await expect(
      handleFeishuLaunchCardAction(actionPayload(startValue!), env, "trace-start")
    ).resolves.toEqual({ ok: true, content: "任务已开始。" });
    await expect(
      handleFeishuLaunchCardAction(actionPayload(startValue!), env, "trace-start-replay")
    ).resolves.toEqual({ ok: false, content: "该操作基于旧状态，请使用当前卡片重试。" });

    expect(mocks.createResolvedSession).toHaveBeenCalledOnce();
    expect(mocks.createResolvedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: expect.stringMatching(/^feishu-session:/),
        runtimeDraftDigest: "a".repeat(64),
      })
    );
    expect(mocks.sendPrompt).toHaveBeenCalledOnce();
    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        clientRequestId: expect.stringMatching(/^feishu-prompt:/),
        callbackContext: expect.objectContaining({
          workingMessageId: "working-card-1",
          cardLifecycle: "single-card-v2",
          routeId: "codex:openai:subscription",
        }),
      })
    );
    expect(mocks.replySessionCard).toHaveBeenCalledOnce();
    expect(mocks.updateSessionCard).toHaveBeenCalledTimes(3);
  });

  it("opens a usable workspace editor when repository inference is ambiguous", async () => {
    const env = testEnv();
    const secondRepository = {
      ...repository,
      repositoryKey: "repo-2",
      fullName: "open-inspect/second-repository",
      displayName: "second-repository",
    };
    mocks.inferRepositoryTarget.mockReturnValue(null);
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: [{ id: "github-main", label: "GitHub", provider: "github" }],
      targets: [repository, secondRepository],
    });
    mocks.listConversationSessions.mockResolvedValue([
      {
        sessionId: "session-recent",
        repositoryKey: secondRepository.repositoryKey,
        targetLabel: secondRepository.fullName,
        model: "openai/gpt-5.6-luna",
        createdAt: 2,
      },
    ]);

    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "检查仓库",
      incomingMessageId: "incoming-ambiguous",
      traceId: "trace-ambiguous",
    });

    const workspaceCard = mocks.updateSessionCard.mock.calls.at(-1)?.[2];
    expect(JSON.stringify(workspaceCard)).toContain("最近使用");
    const targetValue = findActionValue(workspaceCard, "set_target", "repository:repo-2");
    expect(targetValue).not.toBeNull();
    expect(JSON.stringify(workspaceCard)).not.toContain("取消");
    expect(findActionValue(workspaceCard, "apply_editor")).toBeNull();
    await expect(
      handleFeishuLaunchCardAction(
        actionPayload(targetValue!, "event-select-repository"),
        env,
        "trace-select"
      )
    ).resolves.toEqual({ ok: true, content: "目标已选择；点击应用后生效。" });
    expect(
      findActionValue(mocks.updateSessionCard.mock.calls.at(-1)?.[2], "apply_editor")
    ).not.toBeNull();
  });

  it("pages large code-source and environment catalogs within the same workspace card", async () => {
    const env = testEnv();
    mocks.inferRepositoryTarget.mockReturnValue(null);
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: Array.from({ length: 6 }, (_, index) => ({
        id: `connection-${index + 1}`,
        label: `代码源 ${index + 1}`,
        provider: "github" as const,
      })),
      targets: [repository, { ...repository, repositoryKey: "repo-2", displayName: "second" }],
    });
    mocks.listEnvironmentTargets.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        environmentId: `environment-${index + 1}`,
        name: `环境 ${index + 1}`,
        repositoryKeys: [repository.repositoryKey],
      }))
    );

    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root-pagination",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "选择一个工作区",
      incomingMessageId: "incoming-pagination",
      traceId: "trace-pagination",
    });

    const connectionPage = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "connection_page",
      "1"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(connectionPage, "event-connection-page"),
      env,
      "trace-pagination"
    );
    expect(JSON.stringify(mocks.updateSessionCard.mock.calls.at(-1)?.[2])).toContain("代码源 5");

    const environmentPage = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "environment_page",
      "1"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(environmentPage, "event-environment-page"),
      env,
      "trace-pagination"
    );
    expect(JSON.stringify(mocks.updateSessionCard.mock.calls.at(-1)?.[2])).toContain("环境 5");
    expect(
      mocks.updateSessionCard.mock.calls.every(([, messageId]) => messageId === "working-card-1")
    ).toBe(true);
  });

  it("launches an explicitly selected repository-free workspace without inventing a repository", async () => {
    const env = testEnv();
    mocks.inferRepositoryTarget.mockReturnValue(null);
    mocks.listRepositoryCatalog.mockResolvedValue({
      connections: [{ id: "github-main", label: "GitHub", provider: "github" }],
      targets: [repository, { ...repository, repositoryKey: "repo-2", displayName: "second" }],
    });
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root-none",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "创建一个临时工作区",
      incomingMessageId: "incoming-none",
      traceId: "trace-none",
    });

    const workspaceCard = mocks.updateSessionCard.mock.calls.at(-1)?.[2];
    const noneValue = findActionValue(workspaceCard, "set_target", "none")!;
    await handleFeishuLaunchCardAction(actionPayload(noneValue, "event-none"), env, "trace-none");
    const applyValue = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "apply_editor"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(applyValue, "event-apply-none"),
      env,
      "trace-none"
    );
    const startValue = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "start_session"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(startValue, "event-start-none"),
      env,
      "trace-none"
    );

    expect(mocks.createResolvedSession).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "none" } })
    );
  });

  it("rejects actor and revision mismatches before claiming an action id", async () => {
    const env = testEnv();
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "修复 background-agents",
      incomingMessageId: "incoming-security",
      traceId: "trace-1",
    });
    const startValue = findActionValue(
      mocks.updateSessionCard.mock.calls[0]?.[2],
      "start_session"
    )!;
    const wrongActor = actionPayload(startValue, "event-wrong-actor");
    wrongActor.event.operator.open_id = "another-user";
    const wrongMessage = actionPayload(startValue, "event-wrong-message");
    wrongMessage.event.context.open_message_id = "another-card";

    await expect(handleFeishuLaunchCardAction(wrongActor, env, "trace-security")).resolves.toEqual({
      ok: false,
      content: "该卡片已过期或无权操作。",
    });
    await expect(
      handleFeishuLaunchCardAction(
        actionPayload(
          { ...startValue, selectionRevision: Number(startValue.selectionRevision) - 1 },
          "event-old-revision"
        ),
        env,
        "trace-security"
      )
    ).resolves.toEqual({ ok: false, content: "该操作基于旧状态，请使用当前卡片重试。" });
    await expect(
      handleFeishuLaunchCardAction(wrongMessage, env, "trace-security")
    ).resolves.toEqual({ ok: false, content: "该卡片已过期或无权操作。" });

    expect(mocks.claimCardActionOnce).not.toHaveBeenCalled();
  });

  it("re-resolves at Start and never creates a VM when the capability digest changed", async () => {
    const env = testEnv();
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "修复 background-agents",
      incomingMessageId: "incoming-2",
      traceId: "trace-1",
    });
    const startValue = findActionValue(mocks.updateSessionCard.mock.calls[0]?.[2], "start_session");
    mocks.resolveFeishuRuntimeDraft.mockResolvedValueOnce({
      ok: true,
      data: runtimeDraft("b".repeat(64)),
    });

    await expect(
      handleFeishuLaunchCardAction(actionPayload(startValue!), env, "trace-start")
    ).resolves.toEqual({ ok: false, content: "运行时能力已变化，请重新确认。" });

    expect(mocks.createResolvedSession).not.toHaveBeenCalled();
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
  });

  it("applies a Harness, routed model, and Effort as one authoritative Runtime fragment", async () => {
    const env = testEnv();
    const claudeRouteId = "claude:anthropic:api";
    const claudeModelName = "anthropic/claude-sonnet-4-6";
    mocks.resolveFeishuRuntimeDraft.mockImplementation(
      async (input: { runtime?: { harness?: string; effort?: string } }) => {
        const selectedClaude = input.runtime?.harness === "claude";
        const data = runtimeDraft(selectedClaude ? "c".repeat(64) : "a".repeat(64));
        const high = data.options.efforts[0]!;
        const max = { value: "max", label: "Max", nativeValue: "max", isDefault: false };
        const claudeModel = {
          ...data.options.models[0]!,
          model: claudeModelName,
          displayName: "Claude Sonnet 4.6",
          routeId: claudeRouteId,
          provider: "anthropic",
          efforts: [high, max],
        };
        const claudeRoute = {
          ...data.options.harnesses[0]!.routes[0]!,
          routeId: claudeRouteId,
          harness: "claude" as const,
          provider: "anthropic",
          displayName: "Anthropic API",
          models: [claudeModel],
        };
        data.options.harnesses.push({
          ...data.options.harnesses[0]!,
          harness: "claude",
          displayName: "Claude Code",
          routes: [claudeRoute],
        });
        data.options.models.push(claudeModel);
        if (selectedClaude) {
          data.effective.harness = { ...data.effective.harness!, value: "claude" };
          data.effective.routeId = { ...data.effective.routeId!, value: claudeRouteId };
          data.effective.model = { ...data.effective.model!, value: claudeModelName };
          data.effective.effort = {
            ...data.effective.effort!,
            value: input.runtime?.effort ?? "high",
          };
        }
        return { ok: true as const, data };
      }
    );
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root-runtime",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "用 Claude 检查项目",
      incomingMessageId: "incoming-runtime",
      traceId: "trace-runtime",
    });

    const openRuntime = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "open_runtime"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(openRuntime, "event-open-runtime"),
      env,
      "trace-runtime"
    );
    const selectHarness = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "set_runtime_field",
      "claude"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(selectHarness, "event-select-harness"),
      env,
      "trace-runtime"
    );
    const selectModel = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "set_runtime_field",
      JSON.stringify([claudeRouteId, claudeModelName])
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(selectModel, "event-select-model"),
      env,
      "trace-runtime"
    );
    const selectEffort = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "set_runtime_field",
      "max"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(selectEffort, "event-select-effort"),
      env,
      "trace-runtime"
    );
    const applyRuntime = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "apply_editor"
    )!;
    await handleFeishuLaunchCardAction(
      actionPayload(applyRuntime, "event-apply-runtime"),
      env,
      "trace-runtime"
    );
    const readyCard = mocks.updateSessionCard.mock.calls.at(-1)?.[2];
    expect(JSON.stringify(readyCard)).toContain(claudeRouteId);
    const start = findActionValue(readyCard, "start_session")!;
    await handleFeishuLaunchCardAction(
      actionPayload(start, "event-start-runtime"),
      env,
      "trace-runtime"
    );

    expect(mocks.createResolvedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: {
          harness: "claude",
          routeId: claudeRouteId,
          model: claudeModelName,
          effort: "max",
        },
        runtimeDraftDigest: "c".repeat(64),
      })
    );
  });

  it("posts one stable recovery link when the active card cannot be patched", async () => {
    const env = testEnv();
    await initializeSingleCardLaunch({
      env,
      coordinates: {
        tenantKey: "tenant",
        chatId: "chat",
        chatType: "p2p",
        rootMessageId: "root",
        replyMode: "flat",
      },
      actorId: "feishu:tenant:user",
      content: "修复 background-agents",
      incomingMessageId: "incoming-active-fallback",
      traceId: "trace-initialize",
    });
    const startValue = findActionValue(
      mocks.updateSessionCard.mock.calls.at(-1)?.[2],
      "start_session"
    );
    mocks.updateSessionCard
      .mockResolvedValueOnce({ messageId: "working-card-1" })
      .mockRejectedValueOnce(new Error("card expired"));

    await expect(
      handleFeishuLaunchCardAction(actionPayload(startValue!), env, "trace-start")
    ).resolves.toEqual({ ok: true, content: "任务已开始。" });

    expect(mocks.replySessionText).toHaveBeenCalledOnce();
    expect(mocks.replySessionText).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ rootMessageId: "root" }),
      expect.stringContaining("/session/session-1"),
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
  });

  it("pins the lifecycle delivery contract on every follow-up turn", async () => {
    const env = testEnv();

    await expect(
      deliverSingleCardFollowUp({
        env,
        coordinates: {
          tenantKey: "tenant",
          chatId: "chat",
          chatType: "p2p",
          rootMessageId: "root",
          replyMode: "flat",
        },
        existing: {
          version: 3,
          sessionId: "session-1",
          target: { kind: "none" },
          targetLabel: "临时工作区",
          model: "openai/gpt-5.6-luna",
          harness: "codex",
          routeId: "codex:openai:subscription",
          actorId: "feishu:tenant:user",
          chatType: "p2p",
          rootMessageId: "root",
          replyMode: "flat",
          state: "active",
          createdAt: 1,
          updatedAt: 1,
          lastMessageId: "prompt-0",
        },
        actorId: "feishu:tenant:user",
        incomingMessageId: "incoming-follow-up",
        content: "继续检查",
        traceId: "trace-follow-up",
      })
    ).resolves.toBe(true);

    expect(mocks.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        clientRequestId: "feishu-followup:incoming-follow-up",
        callbackContext: expect.objectContaining({
          workingMessageId: "working-card-1",
          cardLifecycle: "single-card-v2",
          routeId: "codex:openai:subscription",
        }),
      })
    );
  });
});
