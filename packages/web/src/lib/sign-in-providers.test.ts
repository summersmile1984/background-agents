import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchWebServiceRequest: vi.fn(),
  getRequestCorrelation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("./control-plane-service", () => ({
  dispatchWebServiceRequest: mocks.dispatchWebServiceRequest,
}));

vi.mock("./request-context", () => ({
  getRequestCorrelation: mocks.getRequestCorrelation,
}));

vi.mock("./logger", () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import { AuthenticationUnavailableError } from "./authentication-unavailable-error";
import { getEnabledSignInOptions } from "./sign-in-providers";

describe("getEnabledSignInOptions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getRequestCorrelation.mockResolvedValue({
      traceId: "trace-1",
      requestId: "request-1",
    });
  });

  it("returns the validated provider set from an exact server-only request", async () => {
    mocks.dispatchWebServiceRequest.mockResolvedValue(
      Response.json({ providers: ["github", "google"], emailPasswordEnabled: true })
    );

    await expect(getEnabledSignInOptions()).resolves.toEqual({
      providers: ["github", "google"],
      emailPasswordEnabled: true,
    });
    expect(mocks.dispatchWebServiceRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/internal/auth/sign-in-providers",
      traceId: "trace-1",
      correlationFields: {
        trace_id: "trace-1",
        request_id: "request-1",
      },
      transportOptions: {
        redirect: "manual",
        cache: "no-store",
      },
    });
  });

  it("propagates request-context failures without logging, wrapping, or dispatching", async () => {
    const frameworkSignal = new Error("NEXT_REQUEST_CONTEXT_SIGNAL");
    mocks.getRequestCorrelation.mockRejectedValue(frameworkSignal);

    await expect(getEnabledSignInOptions()).rejects.toBe(frameworkSignal);
    expect(mocks.dispatchWebServiceRequest).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it.each([
    Response.json({ providers: [], emailPasswordEnabled: false }),
    Response.json({ providers: ["github", "github"], emailPasswordEnabled: false }),
    Response.json({ providers: ["saml"], emailPasswordEnabled: false }),
    Response.json({ providers: "github", emailPasswordEnabled: false }),
    Response.json({ error: "sensitive upstream detail" }, { status: 503 }),
  ])("fails closed on an invalid or unavailable provider response", async (response) => {
    mocks.dispatchWebServiceRequest.mockResolvedValue(response);

    await expect(getEnabledSignInOptions()).rejects.toBeInstanceOf(AuthenticationUnavailableError);
    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});
