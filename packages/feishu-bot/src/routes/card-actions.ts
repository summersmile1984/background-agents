import { Hono } from "hono";
import { verifyFeishuPayload } from "../feishu/crypto";
import { cardActionResponse, handleFeishuCardAction } from "../interactions/card-actions";
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
  const result = await handleFeishuCardAction(verified.payload, c.env, traceId);
  return c.json(cardActionResponse(result));
});
