import { Hono } from "hono";
import { verifyFeishuPayload } from "../feishu/crypto";
import { feishuEventEnvelopeSchema, isUrlVerification } from "../events/payload";
import {
  cardActionResponse,
  handleFeishuCardAction,
  parseFeishuCardAction,
} from "../interactions/card-actions";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("card-actions-route");
export const cardActionRoutes = new Hono<{ Bindings: Env }>();

cardActionRoutes.post("/card-actions", async (c) => {
  const traceId = crypto.randomUUID();
  const rawBody = await c.req.text();
  const verified = await verifyFeishuPayload(
    rawBody,
    {
      timestamp: c.req.header("x-lark-request-timestamp") ?? null,
      nonce: c.req.header("x-lark-request-nonce") ?? null,
      signature: c.req.header("x-lark-signature") ?? null,
    },
    { verificationToken: c.env.FEISHU_VERIFICATION_TOKEN, encryptKey: c.env.FEISHU_ENCRYPT_KEY }
  );
  if (!verified.ok) {
    log.warn("card_action.rejected", { trace_id: traceId, reason: verified.reason });
    return c.json(cardActionResponse({ ok: false, content: "验证失败，请重新操作。" }), 401);
  }

  // Feishu validates every server callback URL with the same URL-verification
  // handshake used for event subscriptions before it will persist the URL.
  const verificationPayload = feishuEventEnvelopeSchema.safeParse(verified.payload);
  if (verificationPayload.success && isUrlVerification(verificationPayload.data)) {
    return c.json({ challenge: verificationPayload.data.challenge });
  }

  if (!parseFeishuCardAction(verified.payload)) {
    return c.json(cardActionResponse({ ok: false, content: "请求无效，请重新发起。" }));
  }

  // The card callback has a short response deadline. Loading the catalog and
  // replying with the next card can take several seconds, so acknowledge the
  // interaction first and keep that work alive with the Worker execution
  // context. The background operation posts the repository card to the same
  // Feishu thread when it finishes.
  c.executionCtx.waitUntil(
    handleFeishuCardAction(verified.payload, c.env, traceId)
      .then((result) => {
        log[result.ok ? "info" : "warn"]("card_action.completed", {
          trace_id: traceId,
          outcome: result.ok ? "ok" : "error",
          result: result.content ?? "processed",
        });
      })
      .catch((error) => {
        log.error("card_action.completed", {
          trace_id: traceId,
          outcome: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      })
  );
  return c.json(cardActionResponse({ ok: true, content: "正在处理，请稍候。" }));
});
