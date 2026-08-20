import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_SOURCE_CONTROL_CAPABILITIES } from "@open-inspect/shared/types/source-control";
import { ScmConnectionCredentialStore, ScmConnectionStore } from "../../src/db/scm-connections";
import { ScmRepositoryStore } from "../../src/db/scm-repositories";
import { ScmRepositoryBackfillStore } from "../../src/db/scm-backfill";

const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

async function clean(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM mcp_server_repository_scopes; DELETE FROM mcp_servers; DELETE FROM scm_integration_repo_settings; DELETE FROM integration_repo_settings; DELETE FROM scm_repository_metadata; DELETE FROM repo_metadata; DELETE FROM session_repositories; DELETE FROM sessions; DELETE FROM scm_repository_backfill_state; DELETE FROM scm_git_capabilities; DELETE FROM scm_webhook_deliveries; DELETE FROM scm_connection_credentials; DELETE FROM scm_repositories; DELETE FROM scm_connections;"
  );
}

describe("multi-connection SCM expand schema", () => {
  beforeEach(clean);
  afterEach(clean);

  it("stores safe connection summaries, one default, and encrypted credentials", async () => {
    const connections = new ScmConnectionStore(env.DB);
    const credentials = new ScmConnectionCredentialStore(env.DB, ENCRYPTION_KEY);

    await connections.create({
      id: "scm_github_default",
      provider: "github",
      displayName: "GitHub",
      baseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      cloneBaseUrl: "https://github.com",
      authMode: "github_app",
      credentialSource: "worker_binding",
      credentialRef: "github_app",
      username: "x-access-token",
      capabilities: EMPTY_SOURCE_CONTROL_CAPABILITIES,
      enabled: true,
      isDefault: true,
      createdBy: "system",
    });
    await connections.create({
      id: "scm_gitea_aotsea",
      provider: "gitea",
      displayName: "Aotsea Gitea",
      baseUrl: "https://gitea.example.com",
      apiBaseUrl: "https://gitea.example.com/api/v1",
      cloneBaseUrl: "https://gitea.example.com",
      authMode: "pat",
      credentialSource: "encrypted_d1",
      username: "agent-bot",
      enabled: true,
      createdBy: "user_1",
    });

    expect((await connections.getDefault())?.id).toBe("scm_github_default");
    await connections.setDefault("scm_gitea_aotsea");
    expect((await connections.getDefault())?.id).toBe("scm_gitea_aotsea");
    expect((await connections.list()).map((connection) => connection.id)).toEqual([
      "scm_gitea_aotsea",
      "scm_github_default",
    ]);

    await credentials.set("scm_gitea_aotsea", "service_token", "test-secret-token");
    expect(await credentials.get("scm_gitea_aotsea", "service_token")).toMatchObject({
      secret: "test-secret-token",
      encryptionFormatVersion: 1,
      expiresAt: null,
    });
    const persisted = await env.DB.prepare(
      "SELECT ciphertext FROM scm_connection_credentials WHERE connection_id = ?"
    )
      .bind("scm_gitea_aotsea")
      .first<{ ciphertext: string }>();
    expect(persisted?.ciphertext).not.toContain("test-secret-token");
  });

  it("isolates equal external IDs and paths between connections and preserves rename identity", async () => {
    const connections = new ScmConnectionStore(env.DB);
    const repositories = new ScmRepositoryStore(env.DB);
    for (const [id, provider, displayName, baseUrl] of [
      ["scm_github_default", "github", "GitHub", "https://github.com"],
      ["scm_gitea_aotsea", "gitea", "Gitea", "https://gitea.example.com"],
    ] as const) {
      await connections.create({
        id,
        provider,
        displayName,
        baseUrl,
        apiBaseUrl: `${baseUrl}/api/v1`,
        cloneBaseUrl: baseUrl,
        authMode: provider === "github" ? "github_app" : "pat",
        credentialSource: "worker_binding",
        credentialRef: "test",
        createdBy: "system",
      });
    }

    const githubRepo = await repositories.upsertResolved({
      connectionId: "scm_github_default",
      externalId: "42",
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      webUrl: "https://github.com/acme/app",
      cloneUrl: "https://github.com/acme/app.git",
      private: true,
      archived: false,
    });
    const giteaRepo = await repositories.upsertResolved({
      connectionId: "scm_gitea_aotsea",
      externalId: "42",
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      webUrl: "https://gitea.example.com/acme/app",
      cloneUrl: "https://gitea.example.com/acme/app.git",
      private: true,
      archived: false,
    });

    expect(giteaRepo.id).not.toBe(githubRepo.id);
    const renamed = await repositories.upsertResolved({
      connectionId: "scm_gitea_aotsea",
      externalId: "42",
      owner: "platform",
      name: "renamed-app",
      defaultBranch: "trunk",
      webUrl: "https://gitea.example.com/platform/renamed-app",
      cloneUrl: "https://gitea.example.com/platform/renamed-app.git",
      private: true,
      archived: false,
    });
    expect(renamed.id).toBe(giteaRepo.id);
    expect(
      await repositories.getByPath("scm_gitea_aotsea", "platform", "renamed-app")
    ).toMatchObject({ id: giteaRepo.id, externalId: "42", defaultBranch: "trunk" });
  });

  it("keeps unresolved legacy identity read-only-shaped and upgrades it in place", async () => {
    const connections = new ScmConnectionStore(env.DB);
    const repositories = new ScmRepositoryStore(env.DB);
    await connections.create({
      id: "scm_github_default",
      provider: "github",
      displayName: "GitHub",
      baseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      cloneBaseUrl: "https://github.com",
      authMode: "github_app",
      credentialSource: "worker_binding",
      credentialRef: "github_app",
      createdBy: "system",
    });

    const unresolved = await repositories.createUnresolvedLegacy({
      connectionId: "scm_github_default",
      owner: "legacy",
      name: "repo",
    });
    expect(unresolved).toMatchObject({
      externalId: null,
      webUrl: null,
      cloneUrl: null,
      resolutionStatus: "unresolved",
    });

    const resolved = await repositories.upsertResolved({
      connectionId: "scm_github_default",
      externalId: "99",
      owner: "legacy",
      name: "repo",
      defaultBranch: "main",
      webUrl: "https://github.com/legacy/repo",
      cloneUrl: "https://github.com/legacy/repo.git",
      private: false,
      archived: false,
    });
    expect(resolved).toMatchObject({
      id: unresolved.id,
      externalId: "99",
      resolutionStatus: "resolved",
    });
  });

  it("adds nullable identity columns without granting repo-less rows a connection", async () => {
    const sessionColumns = await env.DB.prepare("PRAGMA table_info(sessions)").all<{
      name: string;
    }>();
    expect(sessionColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining(["scm_connection_id", "primary_repository_id"])
    );

    const capabilityColumns = await env.DB.prepare("PRAGMA table_info(scm_git_capabilities)").all<{
      name: string;
    }>();
    expect(capabilityColumns.results.map((column) => column.name)).toContain("token_hash");
  });

  it("backfills legacy repository authorities idempotently and clears preflight", async () => {
    const connections = new ScmConnectionStore(env.DB);
    const repositories = new ScmRepositoryStore(env.DB);
    await connections.create({
      id: "scm_github_default",
      provider: "github",
      displayName: "GitHub",
      baseUrl: "https://github.com",
      apiBaseUrl: "https://api.github.com",
      cloneBaseUrl: "https://github.com",
      authMode: "github_app",
      credentialSource: "worker_binding",
      credentialRef: "github_app",
      enabled: true,
      isDefault: true,
      createdBy: "system",
    });
    const repository = await repositories.upsertResolved({
      connectionId: "scm_github_default",
      externalId: "42",
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      webUrl: "https://github.com/acme/app",
      cloneUrl: "https://github.com/acme/app.git",
      private: true,
      archived: false,
    });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, repo_owner, repo_name, created_at, updated_at)
           VALUES ('session_legacy', 'acme', 'app', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO session_repositories
         (session_id, position, repo_owner, repo_name, repo_id, base_branch)
         VALUES ('session_legacy', 0, 'acme', 'app', 42, 'main')`
      ),
      env.DB.prepare(
        `INSERT INTO repo_metadata
           (repo_owner, repo_name, description, aliases, channel_associations,
            keywords, image_build_enabled, created_at, updated_at)
           VALUES ('acme', 'app', 'legacy metadata', '[]', '[]', '[]', 1, ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO integration_repo_settings
           (integration_id, repo, settings, created_at, updated_at)
           VALUES ('sandbox', 'acme/app', '{"tunnelPorts":[3000]}', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO mcp_servers
           (id, name, type, command, env, repo_scope, enabled, created_at, updated_at)
           VALUES ('mcp_legacy', 'legacy', 'local', '["echo"]', '{}',
                   '["acme/app"]', 1, ?, ?)`
      ).bind(now, now),
    ]);

    const backfill = new ScmRepositoryBackfillStore(env.DB);
    expect((await backfill.preflight("scm_github_default")).readyForSecondConnection).toBe(false);
    await backfill.applyRepositoryMapping({
      connectionId: "scm_github_default",
      repositoryId: repository.id,
      owner: "acme",
      name: "app",
    });
    await backfill.applyRepositoryMapping({
      connectionId: "scm_github_default",
      repositoryId: repository.id,
      owner: "acme",
      name: "app",
    });

    expect(
      await env.DB.prepare(
        "SELECT scm_connection_id, primary_repository_id FROM sessions WHERE id = 'session_legacy'"
      ).first()
    ).toEqual({
      scm_connection_id: "scm_github_default",
      primary_repository_id: repository.id,
    });
    expect(
      await env.DB.prepare(
        "SELECT description FROM scm_repository_metadata WHERE repository_id = ?"
      )
        .bind(repository.id)
        .first()
    ).toEqual({ description: "legacy metadata" });
    expect(
      await env.DB.prepare(
        "SELECT repository_id FROM mcp_server_repository_scopes WHERE mcp_server_id = 'mcp_legacy'"
      ).first()
    ).toEqual({ repository_id: repository.id });
    expect((await backfill.preflight("scm_github_default")).readyForSecondConnection).toBe(true);
  });

  it("rejects a stable child repository from another connection at the database boundary", async () => {
    const connections = new ScmConnectionStore(env.DB);
    const repositories = new ScmRepositoryStore(env.DB);
    for (const [id, provider, baseUrl, isDefault] of [
      ["scm_github_default", "github", "https://github.com", true],
      ["scm_gitea", "gitea", "https://gitea.example.com", false],
    ] as const) {
      await connections.create({
        id,
        provider,
        displayName: id,
        baseUrl,
        apiBaseUrl: `${baseUrl}/api/v1`,
        cloneBaseUrl: baseUrl,
        authMode: provider === "github" ? "github_app" : "pat",
        credentialSource: "worker_binding",
        credentialRef: "test",
        enabled: true,
        isDefault,
        createdBy: "system",
      });
    }
    const giteaRepository = await repositories.upsertResolved({
      connectionId: "scm_gitea",
      externalId: "42",
      owner: "acme",
      name: "app",
      defaultBranch: "main",
      webUrl: "https://gitea.example.com/acme/app",
      cloneUrl: "https://gitea.example.com/acme/app.git",
      private: true,
      archived: false,
    });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO sessions
       (id, repo_owner, repo_name, scm_connection_id, created_at, updated_at)
       VALUES ('session_guard', 'acme', 'app', 'scm_github_default', ?, ?)`
    )
      .bind(now, now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO session_repositories
         (session_id, position, repo_owner, repo_name, repo_id, base_branch,
          scm_connection_id, repository_id)
         VALUES ('session_guard', 0, 'acme', 'app', 42, 'main', 'scm_gitea', ?)`
      )
        .bind(giteaRepository.id)
        .run()
    ).rejects.toThrow(/connection mismatch/);
  });
});
