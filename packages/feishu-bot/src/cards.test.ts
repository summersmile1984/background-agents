import { describe, expect, it } from "vitest";
import {
  buildCompletionCard,
  buildConnectionPickerCard,
  buildRepositoryPickerCard,
  REPOSITORIES_PER_PAGE,
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
});
