import { z } from "zod";
import type { Env } from "../types";

const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn";
const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const REPLY_MAX_ATTEMPTS = 2;
const REPLY_RETRY_DELAY_MS = 200;
const UPDATE_MAX_ATTEMPTS = 2;
const UPDATE_RETRY_DELAY_MS = 200;
const MAX_RETRY_AFTER_MS = 2_000;
const MAX_CARD_CONTENT_BYTES = 30 * 1024;
const MAX_CARD_COMPONENTS = 200;

const RATE_LIMITED_CODES = new Set([230020]);
const PERMISSION_CODES = new Set([230006, 230013, 230027]);
const UPDATE_NOT_EDITABLE_CODES = new Set([230011, 230031]);
const UPDATE_TARGET_MISSING_CODES = new Set([230110, 232009]);

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
  | "invalid_card"
  | "target_missing"
  | "not_editable"
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
      classifyFeishuFailure(
        response,
        "reply",
        parsed.success ? parsed.data.msg : undefined,
        parsed.success ? parsed.data.code : undefined
      ),
      "Feishu bot identity request failed",
      response.status
    );
  }
  cachedBotOpenId = openId;
  return openId;
}

function classifyFeishuFailure(
  response: Response,
  operation: "upload" | "reply" | "update",
  apiMessage = "",
  apiCode?: number
): FeishuApiFailure {
  if (response.status === 401 || response.status === 403) return "permission";
  if (response.status === 404 && operation !== "upload") return "target_missing";
  if (response.status === 429 || (apiCode !== undefined && RATE_LIMITED_CODES.has(apiCode))) {
    return "rate_limited";
  }
  if (response.status >= 500) return "transient";
  if (apiCode !== undefined && PERMISSION_CODES.has(apiCode)) return "permission";
  if (operation === "update") {
    if (apiCode !== undefined && UPDATE_TARGET_MISSING_CODES.has(apiCode)) return "target_missing";
    if (apiCode !== undefined && UPDATE_NOT_EDITABLE_CODES.has(apiCode)) return "not_editable";
    return /(expired|editable|update|撤回|过期|更新)/i.test(apiMessage)
      ? "not_editable"
      : "invalid_card";
  }
  return operation === "upload" ? "invalid_media" : "target_missing";
}

function retryDelayMs(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallbackMs;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000))
    : fallbackMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertUniqueCardName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string" || !value) {
    throw new FeishuApiError("invalid_card", "Named Card JSON 2.0 components require a name");
  }
  if (names.has(value)) {
    throw new FeishuApiError("invalid_card", "Card JSON 2.0 component names must be unique");
  }
  names.add(value);
}

/** Validate the Card JSON 2.0 subset emitted by the lifecycle renderer. */
function validateCardJson20(card: FeishuCard): void {
  if (card.schema !== "2.0") return;
  if (!isRecord(card.body) || !Array.isArray(card.body.elements)) {
    throw new FeishuApiError("invalid_card", "Card JSON 2.0 requires body.elements");
  }

  let componentCount = 0;
  const names = new Set<string>();
  const visit = (components: unknown[], form: { hasSubmit: boolean } | null = null): void => {
    for (const value of components) {
      if (!isRecord(value) || typeof value.tag !== "string") {
        throw new FeishuApiError("invalid_card", "Card elements require a tag");
      }
      componentCount += 1;
      if (componentCount > MAX_CARD_COMPONENTS) {
        throw new FeishuApiError("invalid_card", "Feishu cards support at most 200 components");
      }
      if (value.tag === "action") {
        throw new FeishuApiError(
          "invalid_card",
          "Card JSON 2.0 does not support the legacy action component"
        );
      }

      if (value.tag === "button") {
        if (!Array.isArray(value.behaviors) || value.behaviors.length === 0) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 buttons require behaviors");
        }
        for (const behavior of value.behaviors) {
          if (!isRecord(behavior)) {
            throw new FeishuApiError("invalid_card", "Invalid Card JSON 2.0 button behavior");
          }
          if (behavior.type === "callback") {
            if (!isRecord(behavior.value)) {
              throw new FeishuApiError("invalid_card", "Callback behaviors require object values");
            }
          } else if (
            behavior.type !== "open_url" ||
            typeof behavior.default_url !== "string" ||
            !behavior.default_url
          ) {
            throw new FeishuApiError("invalid_card", "Unsupported Card JSON 2.0 button behavior");
          }
        }
        if (form) {
          assertUniqueCardName(names, value.name);
          if (value.form_action_type !== "submit" && value.form_action_type !== "reset") {
            throw new FeishuApiError(
              "invalid_card",
              "Buttons inside a form require form_action_type"
            );
          }
          if (value.form_action_type === "submit") form.hasSubmit = true;
        }
      } else if (value.tag === "input" && form) {
        assertUniqueCardName(names, value.name);
      }

      if (value.tag === "form") {
        if (form) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 forms cannot be nested");
        }
        assertUniqueCardName(names, value.name);
        if (!Array.isArray(value.elements)) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 forms require elements");
        }
        const nestedForm = { hasSubmit: false };
        visit(value.elements, nestedForm);
        if (!nestedForm.hasSubmit) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 forms require a submit button");
        }
        continue;
      }

      if (value.tag === "column_set") {
        if (!Array.isArray(value.columns) || value.columns.length === 0) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 column sets require columns");
        }
        visit(value.columns, form);
        continue;
      }
      if (value.tag === "column") {
        if (!Array.isArray(value.elements)) {
          throw new FeishuApiError("invalid_card", "Card JSON 2.0 columns require elements");
        }
        visit(value.elements, form);
        continue;
      }
      if (Array.isArray(value.elements)) visit(value.elements, form);
    }
  };

  visit(card.body.elements);
}

function serializeFeishuCard(card: FeishuCard, mutable = false): string {
  if (
    mutable &&
    (!card.config ||
      typeof card.config !== "object" ||
      (card.config as Record<string, unknown>).update_multi !== true)
  ) {
    throw new FeishuApiError(
      "invalid_card",
      "Mutable Feishu cards must set config.update_multi=true"
    );
  }
  validateCardJson20(card);
  const content = JSON.stringify(card);
  if (new TextEncoder().encode(content).byteLength > MAX_CARD_CONTENT_BYTES) {
    throw new FeishuApiError("invalid_card", "Feishu card content exceeds the 30 KB limit");
  }
  return content;
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

    const reason = classifyFeishuFailure(
      response,
      "reply",
      parsed.success ? parsed.data.msg : undefined,
      parsed.success ? parsed.data.code : undefined
    );
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
    content: serializeFeishuCard(card),
  });
}

export async function replyFeishuCard(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  messageId: string,
  card: FeishuCard,
  options: FeishuReplyOptions = {}
): Promise<FeishuSentMessage | undefined> {
  serializeFeishuCard(card);
  return replyFeishuMessage(env, messageId, "interactive", card, options);
}

/** Replace a bot-owned interactive card without creating another message. */
export async function updateFeishuCard(
  env: FeishuAuthEnv,
  messageId: string,
  card: FeishuCard
): Promise<FeishuSentMessage | undefined> {
  const cardContent = serializeFeishuCard(card, true);
  let token: string;
  try {
    token = await tenantAccessToken(env);
  } catch (error) {
    if (error instanceof FeishuApiError) throw error;
    throw new FeishuApiError("transient", "Feishu tenant access token request failed");
  }

  const requestUrl = `${apiBase(env)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`;
  const requestBody = JSON.stringify({ content: cardContent });
  for (let attempt = 1; attempt <= UPDATE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: requestBody,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch {
      if (attempt >= UPDATE_MAX_ATTEMPTS) {
        throw new FeishuApiError("ambiguous", "Feishu card update outcome is unknown");
      }
      await new Promise((resolve) => setTimeout(resolve, UPDATE_RETRY_DELAY_MS));
      continue;
    }

    const parsed = createMessageResponseSchema.safeParse(await response.json().catch(() => null));
    if (response.ok && parsed.success && parsed.data.code === 0) {
      return sentMessage(parsed.data.data) ?? { messageId };
    }

    const apiMessage = parsed.success ? parsed.data.msg || "" : "";
    const reason = classifyFeishuFailure(
      response,
      "update",
      apiMessage,
      parsed.success ? parsed.data.code : undefined
    );
    const detail = parsed.success
      ? `code=${parsed.data.code}, msg=${(apiMessage || "unknown").slice(0, 200)}`
      : "invalid_response";
    const failure = new FeishuApiError(
      reason,
      `Feishu card update failed (http_status=${response.status}, ${detail})`,
      response.status
    );
    if ((reason !== "rate_limited" && reason !== "transient") || attempt >= UPDATE_MAX_ATTEMPTS) {
      throw failure;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response, UPDATE_RETRY_DELAY_MS))
    );
  }
  throw new FeishuApiError("transient", "Feishu card update failed after retries");
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
      classifyFeishuFailure(
        response,
        "upload",
        parsed.success ? parsed.data.msg : undefined,
        parsed.success ? parsed.data.code : undefined
      ),
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
