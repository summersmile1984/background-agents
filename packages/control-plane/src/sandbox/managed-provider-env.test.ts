import { describe, expect, it } from "vitest";
import {
  prepareManagedProviderEnv,
  stripHarnessCredentialsForImageBuild,
} from "./managed-provider-env";

describe("prepareManagedProviderEnv", () => {
  it("replaces durable OAuth credentials with provider markers", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          USER_VALUE: "visible",
          DEEPSEEK_API_KEY: "must-stay-on-host",
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          OPENAI_OAUTH_ACCESS_TOKEN: "openai-access",
          OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "123",
          OPENAI_OAUTH_ACCOUNT_ID: "account",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
          XAI_OAUTH_ACCESS_TOKEN: "xai-access",
          XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "456",
        },
        brokerSecrets: {
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
        },
      })
    ).toEqual({
      USER_VALUE: "visible",
      OPENAI_OAUTH_MANAGED: "1",
      XAI_OAUTH_MANAGED: "1",
    });
  });

  it("does not advertise a provider without a refresh token", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          XAI_OAUTH_ACCESS_TOKEN: "orphaned",
          XAI_OAUTH_MANAGED: "user-controlled",
        },
        brokerSecrets: {},
      })
    ).toEqual({});
  });

  it("uses broker-compatible scopes to choose managed markers", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: { XAI_OAUTH_REFRESH_TOKEN: "secondary", USER_VALUE: "visible" },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "primary" },
      })
    ).toEqual({ USER_VALUE: "visible", OPENAI_OAUTH_MANAGED: "1" });
  });
});

describe("stripHarnessCredentialsForImageBuild", () => {
  it("keeps ordinary build secrets but removes native harness login material", () => {
    expect(
      stripHarnessCredentialsForImageBuild({
        DATABASE_URL: "postgres://build",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
        CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT: "1893456000",
        CODEX_AUTH_JSON: "codex-auth",
        CODEX_ACCESS_TOKEN: "codex-access",
        CODEX_ACCESS_TOKEN_EXPIRES_AT: "1893456000",
        DEEPSEEK_API_KEY: "deepseek-secret",
      })
    ).toEqual({ DATABASE_URL: "postgres://build" });
  });
});
