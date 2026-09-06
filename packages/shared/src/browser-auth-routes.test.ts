import { describe, expect, it } from "vitest";
import { BROWSER_AUTH_PROXY_ROUTES, isBrowserAuthProxyRoute } from "./browser-auth-routes";

describe("browser auth proxy route contract", () => {
  it("keeps the cross-service allowlist exact and method-bound", () => {
    expect(BROWSER_AUTH_PROXY_ROUTES).toEqual([
      ["POST", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/callback/github"],
      ["GET", "/api/auth/callback/google"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-out"],
      ["GET", "/api/auth/error"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/sign-up/email"],
    ]);

    expect(isBrowserAuthProxyRoute("get", "/api/auth/get-session")).toBe(true);
    expect(isBrowserAuthProxyRoute("POST", "/api/auth/get-session")).toBe(false);
    expect(isBrowserAuthProxyRoute("GET", "/api/auth/get-session/extra")).toBe(false);
    expect(isBrowserAuthProxyRoute("GET", "/internal/auth/sign-in-providers")).toBe(false);
  });
});
