import { z } from "zod";
import type { Env } from "../types";

const DEFAULT_FEISHU_API_BASE = "https://open.feishu.cn";
const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;

const tenantTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().finite().positive().optional(),
});

const createMessageResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ message_id: z.string().optional() }).optional(),
});

const uploadImageResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ image_key: z.string().min(1).optional() }).optional(),
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

type FeishuAuthEnv = Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">;

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
  msgType: "image" | "text",
  content: Record<string, unknown>
): Promise<string | undefined> {
  let token: string;
  try {
    token = await tenantAccessToken(env);
  } catch (error) {
    if (error instanceof FeishuApiError) throw error;
    throw new FeishuApiError("transient", "Feishu tenant access token request failed");
  }

  let response: Response;
  try {
    response = await fetch(
      `${apiBase(env)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ msg_type: msgType, content: JSON.stringify(content) }),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      }
    );
  } catch {
    throw new FeishuApiError("ambiguous", "Feishu message reply outcome is unknown");
  }

  const parsed = createMessageResponseSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success || parsed.data.code !== 0) {
    const apiDetail = parsed.success
      ? `code=${parsed.data.code}, msg=${(parsed.data.msg || "unknown").slice(0, 200)}`
      : "invalid_response";
    throw new FeishuApiError(
      classifyFeishuFailure(response, "reply"),
      `Feishu message reply failed (http_status=${response.status}, ${apiDetail})`,
      response.status
    );
  }
  return parsed.data.data?.message_id;
}

async function sendAuthenticated(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  path: string,
  body: Record<string, unknown>
): Promise<string | undefined> {
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
  return parsed.data.data?.message_id;
}

export async function sendFeishuText(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  chatId: string,
  text: string
): Promise<string | undefined> {
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
): Promise<string | undefined> {
  return sendAuthenticated(env, "/open-apis/im/v1/messages?receive_id_type=chat_id", {
    receive_id: chatId,
    msg_type: "interactive",
    content: JSON.stringify(card),
  });
}

export async function replyFeishuCard(
  env: Pick<Env, "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_API_BASE">,
  messageId: string,
  card: FeishuCard
): Promise<string | undefined> {
  return sendAuthenticated(
    env,
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    {
      msg_type: "interactive",
      content: JSON.stringify(card),
    }
  );
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
  imageKey: string
): Promise<string | undefined> {
  if (!imageKey.trim()) throw new FeishuApiError("invalid_media", "Image key is required");
  return replyFeishuMessage(env, messageId, "image", { image_key: imageKey });
}

export function replyFeishuText(
  env: FeishuAuthEnv,
  messageId: string,
  text: string
): Promise<string | undefined> {
  return replyFeishuMessage(env, messageId, "text", { text });
}

/** Reset only for deterministic tests; production token cache remains isolate-local. */
export function clearTenantAccessTokenCache(): void {
  cachedTenantToken = null;
}
