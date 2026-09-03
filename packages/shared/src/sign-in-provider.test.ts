import { describe, expect, it } from "vitest";
import {
  getSignInProviderIssuer,
  isSignInProvider,
  parseEnabledSignInProviders,
} from "./sign-in-provider";

describe("isSignInProvider", () => {
  it.each(["github", "google"])("recognizes %s", (provider) => {
    expect(isSignInProvider(provider)).toBe(true);
  });

  it.each(["slack", "linear"])("rejects %s", (provider) => {
    expect(isSignInProvider(provider)).toBe(false);
  });
});

describe("getSignInProviderIssuer", () => {
  it.each([
    ["github", "https://github.com"],
    ["google", "https://accounts.google.com"],
    ["slack", null],
    ["linear", null],
  ])("maps %s to its canonical issuer", (provider, expectedIssuer) => {
    expect(getSignInProviderIssuer(provider)).toBe(expectedIssuer);
  });
});

describe("parseEnabledSignInProviders", () => {
  it("accepts the compiled providers in canonical order", () => {
    expect(
      parseEnabledSignInProviders({ providers: ["github", "google"], emailPasswordEnabled: false })
    ).toEqual({
      providers: ["github", "google"],
      emailPasswordEnabled: false,
    });
  });

  it.each(["github", "google"] as const)("accepts the single enabled provider %s", (provider) => {
    expect(
      parseEnabledSignInProviders({ providers: [provider], emailPasswordEnabled: true })
    ).toEqual({
      providers: [provider],
      emailPasswordEnabled: true,
    });
  });

  it.each([
    [{ providers: [], emailPasswordEnabled: false }, "empty"],
    [{ providers: ["github", "github"], emailPasswordEnabled: false }, "duplicate"],
    [{ providers: ["google", "github"], emailPasswordEnabled: false }, "out of order"],
    [{ providers: ["github", "saml"], emailPasswordEnabled: false }, "unknown"],
    [{ providers: ["github"], emailPasswordEnabled: false, label: "GitHub" }, "extra metadata"],
  ])("rejects a non-canonical provider response: %s (%s)", (value) => {
    expect(() => parseEnabledSignInProviders(value)).toThrow();
  });
});
