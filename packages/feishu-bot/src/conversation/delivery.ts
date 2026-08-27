import type { FeishuCard, FeishuSentMessage } from "../feishu/client";
import { replyFeishuCard, replyFeishuImage, replyFeishuText } from "../feishu/client";
import type { Env } from "../types";
import type { FeishuConversationCoordinates } from "./store";

type FeishuDeliveryEnv = Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">;

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
  coordinates: Pick<FeishuConversationCoordinates, "rootMessageId" | "replyMode">,
  text: string,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return replyFeishuText(
    env,
    coordinates.rootMessageId,
    text,
    replyOptions(coordinates, idempotencyKey)
  );
}

/** Reply with a card without allowing callers to accidentally escape to the main timeline. */
export function replySessionCard(
  env: FeishuDeliveryEnv,
  coordinates: Pick<FeishuConversationCoordinates, "rootMessageId" | "replyMode">,
  card: FeishuCard,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return replyFeishuCard(
    env,
    coordinates.rootMessageId,
    card,
    replyOptions(coordinates, idempotencyKey)
  );
}

/** Reply with an uploaded image on the same flat/thread surface as the session. */
export function replySessionImage(
  env: FeishuDeliveryEnv,
  coordinates: Pick<FeishuConversationCoordinates, "rootMessageId" | "replyMode">,
  imageKey: string,
  idempotencyKey?: string
): Promise<FeishuSentMessage | undefined> {
  return replyFeishuImage(
    env,
    coordinates.rootMessageId,
    imageKey,
    replyOptions(coordinates, idempotencyKey)
  );
}
