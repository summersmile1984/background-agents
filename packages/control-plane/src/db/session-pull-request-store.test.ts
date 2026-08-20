import { describe, expect, it } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "./session-pull-request-store";

function record(overrides: Partial<SessionPullRequestRecord> = {}): SessionPullRequestRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "session-1",
    repositoryExternalId: "42",
    repoOwner: "acme",
    repoName: "api",
    prNumber: 7,
    url: "https://forge.example/acme/api/pulls/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "agent/change",
    baseBranch: "main",
    headSha: null,
    providerCreatedAt: null,
    providerUpdatedAt: 100,
    mergedAt: null,
    closedAt: null,
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function recordingDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: SqlDatabase = {
    prepare(sql: string): SqlStatement {
      const call = { sql, params: [] as unknown[] };
      calls.push(call);
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          call.params = values;
          return statement;
        },
        async first<T>() {
          return null as T | null;
        },
        async run<T>() {
          return { results: [], meta: { changes: 1 } } as SqlResult<T>;
        },
        async all<T>() {
          return { results: [], meta: { changes: 0 } } as SqlResult<T>;
        },
      };
      return statement;
    },
    async batch<T>() {
      return [] as SqlResult<T>[];
    },
  };
  return { db, calls };
}

describe("SessionPullRequestStore stable identity", () => {
  it("writes connection-aware rows to the parallel stable table", async () => {
    const { db, calls } = recordingDb();
    const store = new SessionPullRequestStore(db);

    await store.upsert(record({ scmConnectionId: "scm_gitea", repositoryId: "repo_gitea_42" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO scm_session_pull_requests");
    expect(calls[0].params.slice(0, 5)).toEqual([
      "artifact-1",
      "session-1",
      "scm_gitea",
      "repo_gitea_42",
      "42",
    ]);
  });

  it("keeps legacy records on the compatibility table", async () => {
    const { db, calls } = recordingDb();
    const store = new SessionPullRequestStore(db);

    await store.upsert(record());

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO session_pull_requests");
    expect(calls[0].sql).not.toContain("scm_session_pull_requests");
  });

  it("rejects partial authority rather than falling back to a forge-unsafe key", async () => {
    const { db, calls } = recordingDb();
    const store = new SessionPullRequestStore(db);

    await expect(store.upsert(record({ scmConnectionId: "scm_gitea" }))).rejects.toThrow(
      /provided together/
    );
    expect(calls).toHaveLength(0);
  });
});
