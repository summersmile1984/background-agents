import { verifyCallbackFromControlPlane } from "@open-inspect/shared/auth";
import { feishuCallbackContextSchema } from "@open-inspect/shared/types/session-api";
import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "./logger";
import { createFeishuCompletionJob } from "./completion/job";
import type { Env } from "./types";

const log = createLogger("callbacks");
const completionCallbackSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  timestamp: z.number().finite(),
  signature: z.string().min(1),
  context: feishuCallbackContextSchema,
});

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json().catch(() => null);
  const parsed = completionCallbackSchema.safeParse(payload);
  if (!parsed.success || !(await verifyCallbackFromControlPlane(parsed.data, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const context = parsed.data.context;
  const job = createFeishuCompletionJob({
    sessionId: parsed.data.sessionId,
    messageId: parsed.data.messageId,
    success: parsed.data.success,
    error: parsed.data.error,
    tenantKey: context.tenantKey,
    chatId: context.chatId,
    rootMessageId: context.rootMessageId,
    targetLabel: context.targetLabel,
    model: context.model,
    traceId,
  });
  try {
    await c.env.FEISHU_COMPLETION_QUEUE.send(job, { contentType: "json" });
    return c.json({ ok: true, deliveryId: job.deliveryId });
  } catch (error) {
    log.error("completion.enqueue", {
      trace_id: traceId,
      delivery_id: job.deliveryId,
      session_id: job.sessionId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return c.json({ error: "completion enqueue failed" }, 503);
  }
});
