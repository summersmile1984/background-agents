import { describe, expect, it } from "vitest";
import {
  buildCompletionCard,
  buildConnectionPickerCard,
  buildRepositoryPickerCard,
  buildRuntimeEffortPickerCard,
  buildRuntimeHarnessPickerCard,
  buildRuntimeModelPickerCard,
  buildSessionListCard,
  buildWorkingCard,
  REPOSITORIES_PER_PAGE,
  sessionShortId,
} from "./cards";
import type { FeishuRepositoryTarget } from "./targets";
import type { VisualVerificationReport } from "@open-inspect/shared/types/visual-verification";

function visualReport(status: "passed" | "failed" | "blocked"): VisualVerificationReport {
  return {
    version: 1,
    messageId: "message-1",
    status,
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    scenarios:
      status === "passed"
        ? [
            {
              id: "home",
              status: "passed",
              source: "service:web/",
              viewport: { width: 800, height: 600 },
              assertions: [],
              artifactIds: ["capture-1"],
              durationMs: 1000,
            },
          ]
        : [],
    failure: status === "passed" ? null : { code: "browser_failed", message: "页面没有成功加载" },
  };
}

function target(index: number): FeishuRepositoryTarget {
  return {
    repositoryKey: `repo-${index}`,
    fullName: `huangdong/project-${index}`,
    displayName: `project-${index}`,
    provider: "gitea",
    connectionId: "gitea-main",
    connectionLabel: "Gitea",
    defaultBranch: "main",
  };
}

describe("Feishu repository cards", () => {
  it("lists SCM connections before their repositories", () => {
    const card = buildConnectionPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connections: [
        {
          id: "github",
          label: "GitHub",
          provider: "github",
          repositoryCount: 24,
          catalogStatus: "available",
        },
        {
          id: "gitea",
          label: "Gitea",
          provider: "gitea",
          repositoryCount: 64,
          catalogStatus: "available",
        },
      ],
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain("select_connection");
    expect(serialized).toContain("Gitea · gitea (64 个仓库)");
    expect(serialized).not.toContain("select_static");
    expect(serialized).toContain('"connectionId":"gitea"');
  });

  it("marks a slow connection as refreshing instead of hiding it", () => {
    const card = buildConnectionPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connections: [
        {
          id: "gitea",
          label: "Gitea",
          provider: "gitea",
          repositoryCount: 0,
          catalogStatus: "refreshing",
        },
      ],
    });

    expect(JSON.stringify(card)).toContain("Gitea · gitea（目录刷新中）");
  });

  it("paginates a single SCM connection without dropping repositories", () => {
    const repositories = Array.from({ length: REPOSITORIES_PER_PAGE + 1 }, (_, index) =>
      target(index)
    );
    const card = buildRepositoryPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connection: {
        id: "gitea-main",
        label: "Gitea",
        provider: "gitea",
        repositoryCount: 51,
        catalogStatus: "available",
      },
      repositories,
      page: 1,
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain(`huangdong/project-${REPOSITORIES_PER_PAGE}`);
    expect(serialized).not.toContain("huangdong/project-0");
    expect(serialized).toContain("repository_page");
    expect(serialized).toContain(`"repositoryKey":"repo-${REPOSITORIES_PER_PAGE}"`);
    expect(serialized).not.toContain("select_static");
  });

  it("uses direct repository buttons so the mobile keyboard never opens", () => {
    const card = buildRepositoryPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connection: {
        id: "gitea-main",
        label: "Gitea",
        provider: "gitea",
        repositoryCount: 2,
        catalogStatus: "available",
      },
      repositories: [target(0), target(1)],
      page: 0,
    });

    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("select_static");
    expect(serialized.match(/"action":"select_target"/g)).toHaveLength(2);
    expect(serialized).toContain("直接点选仓库，不会唤起手机输入法");
  });

  it("puts repository actions before explanatory copy for small mobile viewports", () => {
    const card = buildRepositoryPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connection: {
        id: "gitea-main",
        label: "Gitea",
        provider: "gitea",
        repositoryCount: 2,
        catalogStatus: "available",
      },
      repositories: [target(0), target(1)],
      page: 0,
    });

    expect((card.elements as Array<{ tag?: string }>)[0]?.tag).toBe("action");
  });
});

describe("Feishu completion cards", () => {
  it("shows the externally reachable preview URL", () => {
    const card = buildCompletionCard({
      sessionId: "session-1",
      targetLabel: "gitea · huangdong/chatbi",
      textContent: "Done",
      success: true,
      webAppUrl: "https://open-inspect.example",
      previewUrl: "https://preview.example/sandbox/sandbox-1/4173/",
    });

    expect(JSON.stringify(card)).toContain("预览：https://preview.example/sandbox/sandbox-1/4173/");
  });
});

describe("Feishu runtime launch cards", () => {
  const repository = target(1);
  const harness = {
    harness: "codex" as const,
    displayName: "Codex",
    description: "Native Codex",
    enabled: true,
    runtimeAvailable: true,
    ready: true,
    settingsSchemaVersion: "1",
    settings: [],
    liveMutation: { model: false, effort: false, settings: [] },
    routes: [
      {
        routeId: "codex:openai:subscription",
        harness: "codex" as const,
        provider: "openai",
        transport: "native" as const,
        displayName: "OpenAI subscription",
        ready: true,
        code: "READY" as const,
        models: [
          {
            model: "openai/gpt-5.6-luna",
            displayName: "GPT 5.6 Luna",
            description: "Fast",
            category: "OpenAI",
            routeId: "codex:openai:subscription",
            provider: "openai",
            enabled: true,
            ready: true,
            efforts: [{ value: "high", label: "high", nativeValue: "high", isDefault: true }],
            supportsAttachments: true,
            supportsToolEvents: true,
            supportsLiveModelSwitch: false,
          },
        ],
      },
    ],
  };

  it("stages harness, model, and effort selection with opaque action values", () => {
    const harnessCard = JSON.stringify(
      buildRuntimeHarnessPickerCard({
        pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
        target: repository,
        harnesses: [harness],
        commands: [
          {
            id: "product.help",
            slashName: "help",
            title: "Help",
            description: "help",
            group: "session",
            owner: "product",
            harnesses: "all",
            contexts: ["draft"],
            execution: "control-plane",
            arguments: [],
            mutates: [],
            available: true,
          },
        ],
      })
    );
    expect(harnessCard).toContain("select_harness");
    expect(harnessCard).toContain("/help");

    const modelCard = JSON.stringify(
      buildRuntimeModelPickerCard({
        pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
        target: repository,
        harness,
      })
    );
    expect(modelCard).toContain("select_model");
    expect(modelCard).toContain("openai/gpt-5.6-luna");

    const effortCard = JSON.stringify(
      buildRuntimeEffortPickerCard({
        pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
        target: repository,
        harness,
        model: harness.routes[0]!.models[0]!,
        routeId: "codex:openai:subscription",
        commands: [],
      })
    );
    expect(effortCard).toContain("select_effort");
    expect(effortCard).toContain("使用模型默认");
  });
});

describe("Feishu completion cards", () => {
  it("shows passed visual verification and screenshot count", () => {
    const card = buildCompletionCard({
      sessionId: "session-1",
      targetLabel: "Gitea · huangdong/chatbi",
      textContent: "完成",
      success: true,
      webAppUrl: "https://inspect.example.com",
      visualVerification: visualReport("passed"),
    });

    expect(JSON.stringify(card)).toContain("视觉验证已通过：1 个场景，1 张截图");
  });

  it("links to the live sandbox preview when one is available", () => {
    const serialized = JSON.stringify(
      buildCompletionCard({
        sessionId: "session-1",
        targetLabel: "GitHub · summersmile1984/background-agents",
        textContent: "完成",
        success: true,
        webAppUrl: "https://inspect.example.com",
        previewUrl: "https://4173-sandbox.example/",
      })
    );

    expect(serialized).toContain("打开预览");
    expect(serialized).toContain("https://4173-sandbox.example/");
  });

  it.each(["failed", "blocked"] as const)(
    "does not claim verification passed when the result is %s",
    (status) => {
      const serialized = JSON.stringify(
        buildCompletionCard({
          sessionId: "session-1",
          targetLabel: "GitHub · summersmile1984/n9n",
          textContent: "完成",
          success: true,
          webAppUrl: "https://inspect.example.com",
          visualVerification: visualReport(status),
        })
      );

      expect(serialized).toContain("页面没有成功加载");
      expect(serialized).not.toContain("视觉验证已通过");
    }
  );

  it("shows the pinned branch, harness, model, effort, and stable short id", () => {
    const sessionId = "session-runtime-metadata";
    const serialized = JSON.stringify(
      buildWorkingCard({
        sessionId,
        targetLabel: "Gitea · huangdong/chatbi",
        branch: "codex/topic-a",
        harness: "codex",
        model: "openai/gpt-5.6-luna",
        reasoningEffort: "high",
        chatType: "group",
        replyMode: "thread",
        webAppUrl: "https://inspect.example.com",
      })
    );

    expect(serialized).toContain(`#${sessionShortId(sessionId)}`);
    expect(serialized).toContain("codex/topic-a");
    expect(serialized).toContain("codex");
    expect(serialized).toContain("openai/gpt-5.6-luna");
    expect(serialized).toContain("high");
    expect(serialized).toContain("请在本话题继续发送消息");
  });

  it("makes multiple sessions distinguishable in the chat-level session list", () => {
    const serialized = JSON.stringify(
      buildSessionListCard({
        sessions: [
          {
            sessionId: "session-a",
            targetLabel: "GitHub · owner/repo-a",
            branch: "codex/a",
            harness: "codex",
            model: "openai/gpt-5.6-luna",
            state: "active",
            createdAt: 1,
          },
          {
            sessionId: "session-b",
            targetLabel: "Gitea · owner/repo-b",
            branch: "codex/b",
            harness: "claude",
            model: "anthropic/claude-sonnet-4-5",
            state: "completed",
            createdAt: 2,
          },
        ],
        webAppUrl: "https://inspect.example.com",
      })
    );

    expect(serialized).toContain(`#${sessionShortId("session-a")}`);
    expect(serialized).toContain(`#${sessionShortId("session-b")}`);
    expect(serialized).toContain("codex/a");
    expect(serialized).toContain("codex/b");
    expect(serialized).toContain("工作中");
    expect(serialized).toContain("已完成");
    expect(serialized).toContain("#短编号 请求");
  });
});
