import { z } from "zod";
import type { Env } from "../types";

const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn";
const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const REPLY_MAX_ATTEMPTS = 2;
const REPLY_RETRY_DELAY_MS = 200;

const tenantTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().finite().positive().optional(),
});

const createMessageResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      message_id: z.string().optional(),
      root_id: z.string().optional(),
      parent_id: z.string().optional(),
      thread_id: z.string().optional(),
    })
    .optional(),
});

const uploadImageResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ image_key: z.string().min(1).optional() }).optional(),
});

const botInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  bot: z.object({ open_id: z.string().min(1).optional() }).optional(),
});

const MESSAGE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export type FeishuApiFailure =
  | "permission"
  | "rate_limited"
  | "invalid_media"
  | "target_missing"
  | "transient"
  | "ambiguous";

export class FeishuApiError extends Error {
  constructor(
    readonly reason: FeishuApiFailure,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

interface CachedTenantToken {
  value: string;
  expiresAtMs: number;
}

let cachedTenantToken: CachedTenantToken | null = null;
let cachedBotOpenId: string | null = null;

function apiBase(env: Pick<Env, "FEISHU_API_BASE">): string {
  const value = (env.FEISHU_API_BASE || DEFAULT_FEISHU_API_BASE).replace(/\/$/, "");
  if (value !== DEFAULT_FEISHU_API_BASE) throw new Error("Unsupported FEISHU_API_BASE");
  return value;
}

async function tenantAccessToken(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">
): Promise<string> {
  if (cachedTenantToken && cachedTenantToken.expiresAtMs > Date.now())
    return cachedTenantToken.value;
  const response = await fetch(`${apiBase(env)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  const parsed = tenantTokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (
    !response.ok ||
    !parsed.success ||
    parsed.data.code !== 0 ||
    !parsed.data.tenant_access_token
  ) {
    throw new Error("Feishu tenant access token request failed");
  }
  const expiresAtMs =
    Date.now() + Math.max(0, (parsed.data.expire ?? 0) - TOKEN_REFRESH_SKEW_SECONDS) * 1000;
  cachedTenantToken = { value: parsed.data.tenant_access_token, expiresAtMs };
  return cachedTenantToken.value;
}

export type FeishuCard = Record<string, unknown>;

export interface FeishuSentMessage {
  messageId: string;
  rootMessageId?: string;
  parentMessageId?: string;
  threadId?: string;
}

export interface FeishuReplyOptions {
  replyInThread?: boolean;
  /** Feishu deduplicates identical UUIDs for one hour. */
  idempotencyKey?: string;
}

type FeishuAuthEnv = Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">;

/** Resolve the app bot identity without requiring a copied deployment value. */
export async function resolveFeishuBotOpenId(
  env: FeishuAuthEnv & Pick<Env, "FEISHU_BOT_OPEN_ID">
): Promise<string> {
  const configured = env.FEISHU_BOT_OPEN_ID?.trim();
  if (configured) return configured;
  if (cachedBotOpenId) return cachedBotOpenId;
  const token = await tenantAccessToken(env);
  const response = await fetch(`${apiBase(env)}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  const parsed = botInfoResponseSchema.safeParse(await response.json().catch(() => null));
  const openId = parsed.success ? parsed.data.bot?.open_id : undefined;
  if (!response.ok || !parsed.success || parsed.data.code !== 0 || !openId) {
    throw new FeishuApiError(
      classifyFeishuFailure(response, "reply"),
      "Feishu bot identity request failed",
      response.status
    );
  }
  cachedBotOpenId = openId;
  return openId;
}

function classifyFeishuFailure(
  response: Response,
  operation: "upload" | "reply"
): FeishuApiFailure {
  if (response.status === 401 || response.status === 403) return "permission";
  if (response.status === 404 && operation === "reply") return "target_missing";
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "transient";
  return operation === "upload" ? "invalid_media" : "target_missing";
}

async function replyFeishuMessage(
  env: FeishuAuthEnv,
  messageId: string,
  msgType: "image" | "interactive" | "text",
  content: Record<string, unknown>,
  options: FeishuReplyOptions = {}
): Promise<FeishuSentMessage | undefined> {
  let token: string;
  try {
    token = await tenantAccessToken(env);
  } catch (error) {
    if (error instanceof FeishuApiError) throw error;
    throw new FeishuApiError("transient", "Feishu tenant access token request failed");
  }

  const requestUrl = `${apiBase(env)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`;
  const requestBody = JSON.stringify({
    msg_type: msgType,
    content: JSON.stringify(content),
    ...(options.replyInThread !== undefined ? { reply_in_thread: options.replyInThread } : {}),
    ...(options.idempotencyKey ? { uuid: options.idempotencyKey } : {}),
  });

  for (let attempt = 1; attempt <= REPLY_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch {
      // A network timeout is ambiguous. Reusing a caller-provided idempotency
      // key makes one bounded retry safe; without a key, never risk creating
      // a duplicate message after an unknown outcome.
      if (!options.idempotencyKey || attempt >= REPLY_MAX_ATTEMPTS) {
        throw new FeishuApiError("ambiguous", "Feishu message reply outcome is unknown");
      }
      await new Promise((resolve) => setTimeout(resolve, REPLY_RETRY_DELAY_MS));
      continue;
    }

    const parsed = createMessageResponseSchema.safeParse(await response.json().catch(() => null));
    if (response.ok && parsed.success && parsed.data.code === 0) {
      return sentMessage(parsed.data.data);
    }

    const reason = classifyFeishuFailure(response, "reply");
    const apiDetail = parsed.success
      ? `code=${parsed.data.code}, msg=${(parsed.data.msg || "unknown").slice(0, 200)}`
      : "invalid_response";
    const failure = new FeishuApiError(
      reason,
      `Feishu message reply failed (http_status=${response.status}, ${apiDetail})`,
      response.status
    );
    const retryable = reason === "rate_limited" || reason === "transient";
    if (!options.idempotencyKey || !retryable || attempt >= REPLY_MAX_ATTEMPTS) throw failure;
    await new Promise((resolve) => setTimeout(resolve, REPLY_RETRY_DELAY_MS));
  }

  throw new FeishuApiError("transient", "Feishu message reply failed after retries");
}

function sentMessage(
  data: z.infer<typeof createMessageResponseSchema>["data"]
): FeishuSentMessage | undefined {
  if (!data?.message_id) return undefined;
  return {
    messageId: data.message_id,
    ...(data.root_id ? { rootMessageId: data.root_id } : {}),
    ...(data.parent_id ? { parentMessageId: data.parent_id } : {}),
    ...(data.thread_id ? { threadId: data.thread_id } : {}),
  };
}

async function sendAuthenticated(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  path: string,
  body: Record<string, unknown>
): Promise<FeishuSentMessage | undefined> {
  const token = await tenantAccessToken(env);
  const response = await fetch(`${apiBase(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  const parsed = createMessageResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success || parsed.data.code !== 0) {
    const apiDetail = parsed.success
      ? `code=${parsed.data.code}, msg=${(parsed.data.msg || "unknown").slice(0, 200)}`
      : "invalid_response";
    throw new Error(`Feishu message request failed (http_status=${response.status}, ${apiDetail})`);
  }
  return sentMessage(parsed.data.data);
}

export async function sendFeishuText(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  chatId: string,
  text: string
): Promise<FeishuSentMessage | undefined> {
  return sendAuthenticated(env, "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  });
}

export async function sendFeishuCard(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  chatId: string,
  card: FeishuCard
): Promise<FeishuSentMessage | undefined> {
  return sendAuthenticated(env, "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  });
}

export async function replyFeishuCard(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  messageId: string,
  card: FeishuCard,
  options: FeishuReplyOptions = {}
): Promise<FeishuSentMessage | undefined> {
  return replyFeishuMessage(env, messageId, "interactive", card, options);
}

export async function uploadFeishuMessageImage(
  env: FeishuAuthEnv,
  input: { bytes: ArrayBuffer; mimeType: string; filename: string }
): Promise<{ imageKey: string }> {
  if (!MESSAGE_IMAGE_MIME_TYPES.has(input.mimeType)) {
    throw new FeishuApiError("invalid_media", "Unsupported Feishu message image type");
  }

  let token: string;
  try {
    token = await tenantAccessToken(env);
  } catch (error) {
    if (error instanceof FeishuApiError) throw error;
    throw new FeishuApiError("transient", "Feishu tenant access token request failed");
  }

  const body = new FormData();
  body.set("image_type", "message");
  body.set("image", new Blob([input.bytes], { type: input.mimeType }), input.filename);

  let response: Response;
  try {
    response = await fetch(`${apiBase(env)}/open-apis/im/v1/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FeishuApiError("ambiguous", "Feishu image upload outcome is unknown");
  }

  const parsed = uploadImageResponseSchema.safeParse(await response.json().catch(() => null));
  const imageKey = parsed.success ? parsed.data.data?.image_key : undefined;
  if (!response.ok || !parsed.success || parsed.data.code !== 0 || !imageKey) {
    const apiDetail = parsed.success
      ? `code=${parsed.data.code}, msg=${(parsed.data.msg || "unknown").slice(0, 200)}`
      : "invalid_response";
    throw new FeishuApiError(
      classifyFeishuFailure(response, "upload"),
      `Feishu image upload failed (http_status=${response.status}, ${apiDetail})`,
      response.status
    );
  }
  return { imageKey };
}

export function replyFeishuImage(
  env: FeishuAuthEnv,
  messageId: string,
  imageKey: string,
  options: FeishuReplyOptions = {}
): Promise<FeishuSentMessage | undefined> {
  if (!imageKey.trim()) throw new FeishuApiError("invalid_media", "Image key is required");
  return replyFeishuMessage(env, messageId, "image", { image_key: imageKey }, options);
}

export function replyFeishuText(
  env: FeishuAuthEnv,
  messageId: string,
  text: string,
  options: FeishuReplyOptions = {}
): Promise<FeishuSentMessage | undefined> {
  return replyFeishuMessage(env, messageId, "text", { text }, options);
}

/** Reset only for deterministic tests; production caches remain isolate-local. */
export function clearTenantAccessTokenCache(): void {
  cachedTenantToken = null;
  cachedBotOpenId = null;
}
