import { describe, expect, it } from "vitest";
import {
  SourceControlUrlValidationError,
  GiteaSecurityVersionError,
  assertGiteaSecurityVersion,
  assertSameSourceControlOrigin,
  deriveGiteaConnectionUrls,
  normalizeSourceControlBaseUrl,
} from "./connection-config";

describe("source-control connection URLs", () => {
  it("preserves ports and reverse-proxy paths while removing trailing slashes", () => {
    expect(normalizeSourceControlBaseUrl(" https://GITEA.example.com:8443/team/gitea/// ")).toBe(
      "https://gitea.example.com:8443/team/gitea"
    );
    expect(deriveGiteaConnectionUrls("https://gitea.example.com/team")).toEqual({
      baseUrl: "https://gitea.example.com/team",
      apiBaseUrl: "https://gitea.example.com/team/api/v1",
      cloneBaseUrl: "https://gitea.example.com/team",
    });
  });

  it.each([
    "https://user:secret@gitea.example.com",
    "https://gitea.example.com?token=secret",
    "https://gitea.example.com/#fragment",
    "ftp://gitea.example.com",
    "http://gitea.example.com",
  ])("rejects unsafe URL %s", (value) => {
    expect(() => normalizeSourceControlBaseUrl(value)).toThrow(SourceControlUrlValidationError);
  });

  it("allows HTTP only for explicit loopback development", () => {
    expect(
      normalizeSourceControlBaseUrl("http://127.0.0.1:3000/gitea", {
        allowHttpLoopback: true,
      })
    ).toBe("http://127.0.0.1:3000/gitea");
    expect(() =>
      normalizeSourceControlBaseUrl("http://10.0.0.1/gitea", { allowHttpLoopback: true })
    ).toThrow("must use HTTPS");
  });

  it("rejects an API override on another origin", () => {
    expect(() =>
      assertSameSourceControlOrigin(
        "https://gitea.example.com/root",
        "https://attacker.example/api/v1"
      )
    ).toThrow("must use the connection origin");
  });

  it("accepts the fixed community release line", () => {
    expect(() => assertGiteaSecurityVersion("1.27.1", undefined)).not.toThrow();
    expect(() => assertGiteaSecurityVersion("1.28.0-rc1", undefined)).not.toThrow();
  });

  it("requires exact operator confirmation for enterprise version numbers", () => {
    expect(() => assertGiteaSecurityVersion("23.8.0", undefined)).toThrow(
      GiteaSecurityVersionError
    );
    expect(() => assertGiteaSecurityVersion("23.8.0", "23.7.1, 23.8.0")).not.toThrow();
  });
});
