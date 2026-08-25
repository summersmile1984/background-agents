import { Hono } from "hono";
import { claimEventOnce } from "../conversation/store";
import { verifyFeishuPayload } from "../feishu/crypto";
import { handleFeishuEvent } from "../events/dispatcher";
import { feishuEventEnvelopeSchema, isUrlVerification } from "../events/payload";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("events-route");
export const eventRoutes = new Hono<{ Bindings: Env }>();

function headers(request: Request) {
  return {
    timestamp: request.headers.get("x-lark-request-timestamp"),
    nonce: request.headers.get("x-lark-request-nonce"),
    signature: request.headers.get("x-lark-signature"),
  };
}

eventRoutes.post("/events", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const rawBody = await c.req.text();
  const verified = await verifyFeishuPayload(rawBody, headers(c.req.raw), {
    verificationToken: c.env.FEISHU_VERIFICATION_TOKEN,
    encryptKey: c.env.FEISHU_ENCRYPT_KEY,
  });
  if (!verified.ok) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/events",
      http_status: 401,
      outcome: "rejected",
      reject_reason: verified.reason,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }
  const parsed = feishuEventEnvelopeSchema.safeParse(verified.payload);
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  if (isUrlVerification(parsed.data)) return c.json({ challenge: parsed.data.challenge });

  const eventId = parsed.data.header?.event_id;
  if (eventId) {
    try {
      if (!(await claimEventOnce(c.env, eventId))) return c.json({ ok: true });
    } catch (error) {
      // The event parser is still idempotent at session-create boundaries; do
      // not force a Feishu retry that can multiply otherwise valid work.
      log.error("event.dedupe", {
        trace_id: traceId,
        event_id: eventId,
        outcome: "degraded",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  c.executionCtx.waitUntil(handleFeishuEvent(parsed.data, c.env, traceId));
  return c.json({ ok: true });
});
