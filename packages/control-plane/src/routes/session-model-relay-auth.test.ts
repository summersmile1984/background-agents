import { describe, expect, it } from "vitest";
import { sessionModelRelayAuthRoutes } from "./session-model-relay-auth";

describe("session model relay authorization route", () => {
  it("is sandbox-authenticated and binds the session id from the path", async () => {
    const route = sessionModelRelayAuthRoutes[0];
    const match = "/sessions/session-1/model-relay-auth".match(route.pattern);

    expect(route.method).toBe("POST");
    expect(route.authentication.kind).toBe("sandbox");
    expect(match?.groups?.id).toBe("session-1");
    if (route.authentication.kind !== "sandbox" || !match) throw new Error("invalid route");
    expect(route.authentication.getSessionId(match)).toBe("session-1");

    const response = await route.handler(
      new Request("https://control.example/sessions/session-1/model-relay-auth", {
        method: "POST",
      }),
      {} as never,
      match,
      {} as never
    );
    expect(response.status).toBe(204);
  });
});
