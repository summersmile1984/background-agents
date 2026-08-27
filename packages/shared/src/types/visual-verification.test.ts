import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISUAL_VERIFICATION_POLICY,
  visualVerificationPolicySchema,
  visualVerificationReportSchema,
  visualVerificationRequestSchema,
} from "./visual-verification";

describe("visual verification contracts", () => {
  it("accepts an explicit ad-hoc request", () => {
    expect(
      visualVerificationRequestSchema.parse({
        version: 1,
        sessionId: "session-1",
        messageId: "message-1",
        adHoc: {
          service: "web",
          path: "/dashboard",
          viewport: { width: 390, height: 844 },
          capture: "full_page",
        },
        reason: "user_requested",
      })
    ).toMatchObject({ messageId: "message-1", adHoc: { service: "web" } });
  });

  it.each(["https://example.com/", "//example.com/", "/../secret", "/%2e%2e/secret", "/x?q=1"])(
    "rejects an unsafe path: %s",
    (path) => {
      expect(
        visualVerificationRequestSchema.safeParse({
          version: 1,
          sessionId: "session-1",
          messageId: "message-1",
          adHoc: {
            service: "web",
            path,
            viewport: { width: 1280, height: 720 },
          },
          reason: "user_requested",
        }).success
      ).toBe(false);
    }
  );

  it("keeps the host policy disabled and bounded by default", () => {
    expect(visualVerificationPolicySchema.parse(DEFAULT_VISUAL_VERIFICATION_POLICY)).toEqual(
      DEFAULT_VISUAL_VERIFICATION_POLICY
    );
    expect(
      visualVerificationPolicySchema.safeParse({
        ...DEFAULT_VISUAL_VERIFICATION_POLICY,
        maxScenarios: 6,
      }).success
    ).toBe(false);
  });

  it("rejects passed reports without a persisted artifact", () => {
    const report = {
      version: 1,
      messageId: "message-1",
      status: "passed",
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:00:01.000Z",
      scenarios: [
        {
          id: "home",
          status: "passed",
          source: "web:/",
          viewport: { width: 1280, height: 720 },
          assertions: [],
          artifactIds: [],
          durationMs: 1000,
        },
      ],
      failure: null,
    };

    expect(visualVerificationReportSchema.safeParse(report).success).toBe(false);
  });

  it("accepts null optional fields emitted by the Python runtime", () => {
    expect(
      visualVerificationReportSchema.safeParse({
        version: 1,
        messageId: "message-1",
        status: "passed",
        startedAt: "2026-08-26T00:00:00.000Z",
        finishedAt: "2026-08-26T00:00:01.000Z",
        scenarios: [
          {
            id: "home",
            status: "passed",
            source: "web:/",
            viewport: { width: 1280, height: 720 },
            assertions: [
              { kind: "visible", status: "passed", selector: "main", message: null },
              { kind: "no_console_error", status: "passed", selector: null, message: null },
            ],
            artifactIds: ["artifact-1"],
            durationMs: 1000,
          },
        ],
        failure: null,
      }).success
    ).toBe(true);
  });
});
