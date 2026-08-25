import { describe, expect, it } from "vitest";
import {
  buildConnectionPickerCard,
  buildRepositoryPickerCard,
  REPOSITORIES_PER_PAGE,
} from "./cards";
import type { FeishuRepositoryTarget } from "./targets";

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
        { id: "github", label: "GitHub", provider: "github", repositoryCount: 24 },
        { id: "gitea", label: "Gitea", provider: "gitea", repositoryCount: 64 },
      ],
    });

    expect(JSON.stringify(card)).toContain("select_connection");
    expect(JSON.stringify(card)).toContain("Gitea · gitea (64 个仓库)");
  });

  it("paginates a single SCM connection without dropping repositories", () => {
    const repositories = Array.from({ length: REPOSITORIES_PER_PAGE + 1 }, (_, index) =>
      target(index)
    );
    const card = buildRepositoryPickerCard({
      pendingId: "1cd968ae-f012-4a12-898e-f320808f1af7",
      connection: { id: "gitea-main", label: "Gitea", provider: "gitea", repositoryCount: 51 },
      repositories,
      page: 1,
    });

    const serialized = JSON.stringify(card);
    expect(serialized).toContain(`huangdong/project-${REPOSITORIES_PER_PAGE}`);
    expect(serialized).not.toContain("huangdong/project-0");
    expect(serialized).toContain("repository_page");
  });
});
