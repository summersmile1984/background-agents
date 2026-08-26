import { z } from "zod";

export const VISUAL_VERIFICATION_VERSION = 1 as const;
export const MAX_VISUAL_VERIFICATION_SCENARIOS = 5;
export const MAX_VISUAL_VERIFICATION_CAPTURES = 8;
export const MAX_VISUAL_VERIFICATION_TIMEOUT_MS = 300_000;
export const MAX_VISUAL_VERIFICATION_UPLOAD_BYTES = 10 * 1024 * 1024;

export const visualVerificationViewportSchema = z
  .object({
    width: z.number().int().min(320).max(2560),
    height: z.number().int().min(240).max(1600),
  })
  .strict();

function isSafeVerificationPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  // URL() normalizes dot segments before exposing pathname, so inspect the
  // caller's bytes first. Decode repeatedly to catch double-encoded traversal
  // that an application framework could decode in a later routing layer.
  let decoded = value;
  try {
    for (let depth = 0; depth < 3; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return false;
  }

  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.includes("?") ||
    decoded.includes("#") ||
    decoded.split("/").includes("..")
  ) {
    return false;
  }

  try {
    const url = new URL(value, "http://visual-verification.invalid");
    return url.origin === "http://visual-verification.invalid" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const verificationPathSchema = z.string().min(1).max(2048).refine(isSafeVerificationPath, {
  message: "must be a rooted HTTP path without authority, query, fragment, or traversal",
});

export const visualVerificationAdHocSchema = z
  .object({
    service: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    path: verificationPathSchema,
    viewport: visualVerificationViewportSchema,
    capture: z.enum(["viewport", "full_page"]).default("viewport"),
  })
  .strict();

export const visualVerificationRequestSchema = z
  .object({
    version: z.literal(VISUAL_VERIFICATION_VERSION),
    sessionId: z.string().min(1).max(128),
    messageId: z.string().min(1).max(128),
    scenarioIds: z
      .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
      .max(MAX_VISUAL_VERIFICATION_SCENARIOS)
      .refine((values) => new Set(values).size === values.length, {
        message: "scenarioIds must be unique",
      })
      .optional(),
    adHoc: visualVerificationAdHocSchema.optional(),
    reason: z.enum(["user_requested", "repository_declared", "host_required"]),
  })
  .strict()
  .refine((value) => !(value.adHoc && value.scenarioIds?.length), {
    message: "adHoc and scenarioIds are mutually exclusive",
  });

/** Prompt-facing selection. Session/message identity and reason are derived by the host. */
export const visualVerificationSelectionSchema = z
  .object({
    scenarioIds: z
      .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
      .max(MAX_VISUAL_VERIFICATION_SCENARIOS)
      .refine((values) => new Set(values).size === values.length, {
        message: "scenarioIds must be unique",
      })
      .optional(),
    adHoc: visualVerificationAdHocSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.adHoc && value.scenarioIds?.length), {
    message: "adHoc and scenarioIds are mutually exclusive",
  });

export const visualVerificationPolicySchema = z
  .object({
    enabled: z.boolean(),
    trigger: z.enum(["explicit_only", "declared_ui_changes", "always_after_success"]),
    maxScenarios: z.number().int().min(1).max(MAX_VISUAL_VERIFICATION_SCENARIOS),
    maxCaptures: z.number().int().min(1).max(MAX_VISUAL_VERIFICATION_CAPTURES),
    timeoutMs: z.number().int().min(1000).max(MAX_VISUAL_VERIFICATION_TIMEOUT_MS),
    maxUploadBytes: z.number().int().min(1024).max(MAX_VISUAL_VERIFICATION_UPLOAD_BYTES),
    allowedServiceNames: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/))
      .refine((values) => new Set(values).size === values.length, {
        message: "allowedServiceNames must be unique",
      }),
    allowRepositoryDeclaration: z.boolean(),
    allowVideo: z.boolean(),
    completionBehavior: z.enum(["report_only", "require_pass"]),
  })
  .strict();

export const DEFAULT_VISUAL_VERIFICATION_POLICY: VisualVerificationPolicy = {
  enabled: false,
  trigger: "explicit_only",
  maxScenarios: 3,
  maxCaptures: 4,
  timeoutMs: 120_000,
  maxUploadBytes: MAX_VISUAL_VERIFICATION_UPLOAD_BYTES,
  allowedServiceNames: [],
  allowRepositoryDeclaration: false,
  allowVideo: false,
  completionBehavior: "report_only",
};

export const visualVerificationAssertionResultSchema = z
  .object({
    kind: z.enum(["visible", "hidden", "text_contains", "url_path", "no_console_error"]),
    status: z.enum(["passed", "failed"]),
    selector: z.string().max(512).optional(),
    message: z.string().max(1024).optional(),
  })
  .strict();

export const visualVerificationScenarioReportSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: z.enum(["passed", "failed", "blocked"]),
    source: z.string().max(2048),
    viewport: visualVerificationViewportSchema,
    assertions: z.array(visualVerificationAssertionResultSchema).max(20),
    artifactIds: z.array(z.string().min(1).max(128)).max(MAX_VISUAL_VERIFICATION_CAPTURES),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const visualVerificationFailureSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9_]+$/),
    message: z.string().min(1).max(1024),
    scenarioId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict();

export const visualVerificationReportSchema = z
  .object({
    version: z.literal(VISUAL_VERIFICATION_VERSION),
    messageId: z.string().min(1).max(128),
    status: z.enum(["passed", "failed", "blocked", "not_requested"]),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    scenarios: z
      .array(visualVerificationScenarioReportSchema)
      .max(MAX_VISUAL_VERIFICATION_SCENARIOS),
    failure: visualVerificationFailureSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "passed") return;
    if (
      value.failure !== null ||
      value.scenarios.length === 0 ||
      value.scenarios.some(
        (scenario) => scenario.status !== "passed" || scenario.artifactIds.length === 0
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "passed reports require successful scenarios with persisted artifacts",
      });
    }
  });

export type VisualVerificationViewport = z.infer<typeof visualVerificationViewportSchema>;
export type VisualVerificationAdHoc = z.infer<typeof visualVerificationAdHocSchema>;
export type VisualVerificationRequest = z.infer<typeof visualVerificationRequestSchema>;
export type VisualVerificationSelection = z.infer<typeof visualVerificationSelectionSchema>;
export type VisualVerificationPolicy = z.infer<typeof visualVerificationPolicySchema>;
export type VisualVerificationAssertionResult = z.infer<
  typeof visualVerificationAssertionResultSchema
>;
export type VisualVerificationScenarioReport = z.infer<
  typeof visualVerificationScenarioReportSchema
>;
export type VisualVerificationFailure = z.infer<typeof visualVerificationFailureSchema>;
export type VisualVerificationReport = z.infer<typeof visualVerificationReportSchema>;
