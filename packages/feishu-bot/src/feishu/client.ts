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
    throw new Error("Feishu message request failed");
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

/** Reset only for deterministic tests; production token cache remains isolate-local. */
export function clearTenantAccessTokenCache(): void {
  cachedTenantToken = null;
}
