import { describe, expect, it } from "vitest";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import type { RequestContext } from "../routes/shared";
import { runtimeCallerChannel, runtimeConfigurationOwnersForRequest } from "./request-context";

function serviceContext(service: ServiceName, participantUserId: string | null): RequestContext {
  return {
    principal: {
      kind: "service",
      service,
      actor: participantUserId
        ? {
            provider: "feishu",
            providerUserId: "provider-user",
            canonicalUserId: null,
            participantUserId,
          }
        : null,
    },
  } as RequestContext;
}

describe("runtime request context", () => {
  it.each([
    ["slack-bot", "slack", "slack:U1"],
    ["feishu-bot", "feishu", "feishu:tenant:ou_1"],
    ["linear-bot", "linear", "linear:user-1"],
    ["github-bot", "github", "github:123"],
  ] as const)(
    "gives %s an explicit %s integration layer plus its verified actor layer",
    (service, channel, participantUserId) => {
      const context = serviceContext(service, participantUserId);

      expect(runtimeCallerChannel(context)).toBe(channel);
      expect(runtimeConfigurationOwnersForRequest(context)).toEqual([
        { scope: "integration", id: channel },
        { scope: "user", id: participantUserId },
      ]);
    }
  );

  it("uses the Gitea integration layer for a GitHub bot request targeting Gitea", () => {
    const context = serviceContext("github-bot", "gitea:42");

    expect(runtimeCallerChannel(context, "gitea")).toBe("gitea");
    expect(runtimeConfigurationOwnersForRequest(context, "gitea")).toEqual([
      { scope: "integration", id: "gitea" },
      { scope: "user", id: "gitea:42" },
    ]);
  });

  it("does not grant actor-scoped Runtime access to an actorless service", () => {
    expect(runtimeConfigurationOwnersForRequest(serviceContext("feishu-bot", null))).toBeNull();
  });

  it("keeps the signed web service on the user layer without inventing an integration layer", () => {
    const context = serviceContext("web", "github:123");

    expect(runtimeCallerChannel(context)).toBe("web");
    expect(runtimeConfigurationOwnersForRequest(context)).toEqual([
      { scope: "user", id: "github:123" },
    ]);
  });
});
