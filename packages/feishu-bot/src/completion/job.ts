import { z } from "zod";

export const feishuCompletionJobSchema = z.object({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  rootMessageId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]).optional(),
  threadId: z.string().min(1).optional(),
  replyMode: z.enum(["thread", "flat"]).optional(),
  targetLabel: z.string().min(1),
  branch: z.string().min(1).optional(),
  harness: z.enum(["opencode", "codex", "claude", "deepseek", "inherit"]).optional(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  traceId: z.string().optional(),
});

export type FeishuCompletionJob = z.infer<typeof feishuCompletionJobSchema>;

export function createFeishuCompletionJob(
  input: Omit<FeishuCompletionJob, "version" | "deliveryId">
): FeishuCompletionJob {
  return { version: 1, deliveryId: crypto.randomUUID(), ...input };
}
