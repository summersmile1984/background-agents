import type { FeishuCard, FeishuSentMessage } from "../feishu/client";
import { replyFeishuCard, replyFeishuImage, replyFeishuText } from "../feishu/client";
import type { Env } from "../types";
import { storeThreadMessageAlias, type FeishuConversationCoordinates } from "./store";

type FeishuDeliveryEnv = Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE"> &
  Partial<Pick<Env, "FEISHU_KV">>;
type FeishuDeliveryCoordinates = Pick<
  FeishuConversationCoordinates,
  "rootMessageId" | "replyMode"
> &
  Partial<Pick<FeishuConversationCoordinates, "tenantKey" | "chatId" | "chatType" | "threadId">>;

async function rememberOutboundMessage(
  env: FeishuDeliveryEnv,
  coordinates: FeishuDeliveryCoordinates,
  sent: FeishuSentMessage | undefined
): Promise<FeishuSentMessage | undefined> {
  if (
    sent?.messageId &&
    env.FEISHU_KV &&
    coordinates.tenantKey &&
    coordinates.chatId &&
    coordinates.chatType
  ) {
    // A KV write must never turn a successful Feishu reply into a failed
    // delivery. The alias is only a convenience for quote/reply routing.
    const kv = env.FEISHU_KV;
    await storeThreadMessageAlias(
      { FEISHU_KV: kv },
      coordinates as FeishuConversationCoordinates,
      sent.messageId
    ).catch(() => undefined);
  }
  return sent;
}

function replyOptions(
  coordinates: Pick<FeishuConversationCoordinates, "replyMode">,
  idempotencyKey?: string
): { replyInThread: boolean; idempotencyKey?: string } {
  return {
    replyInThread: coordinates.replyMode === "thread",
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Reply to the stable root so all session messages are siblings on one surface. */
export function replySessionText(
  env: FeishuDeliveryEnv,
  coordinates: FeishuDeliveryCoordinates,
  text: string,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return Promise.resolve(
    replyFeishuText(env, coordinates.rootMessageId, text, replyOptions(coordinates, idempotencyKey))
  ).then((sent) => rememberOutboundMessage(env, coordinates, sent));
}

/** Reply with a card without allowing callers to accidentally escape to the main timeline. */
export function replySessionCard(
  env: FeishuDeliveryEnv,
  coordinates: FeishuDeliveryCoordinates,
  card: FeishuCard,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return Promise.resolve(
    replyFeishuCard(env, coordinates.rootMessageId, card, replyOptions(coordinates, idempotencyKey))
  ).then((sent) => rememberOutboundMessage(env, coordinates, sent));
}

/** Reply with an uploaded image on the same flat/thread surface as the session. */
export function replySessionImage(
  env: FeishuDeliveryEnv,
  coordinates: FeishuDeliveryCoordinates,
  imageKey: string,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return Promise.resolve(
    replyFeishuImage(
      env,
      coordinates.rootMessageId,
      imageKey,
      replyOptions(coordinates, idempotencyKey)
    )
  ).then((sent) => rememberOutboundMessage(env, coordinates, sent));
}
