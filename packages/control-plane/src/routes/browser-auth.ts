import { BROWSER_AUTH_PROXY_ROUTES } from "@open-inspect/shared/browser-auth-routes";
import { type BetterAuthRuntime, UserAuthConfigurationError } from "../auth/user/runtime";
import { parseAdmissionAllowlist, parseAdmissionBoolean } from "../auth/user/admission-policy";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  defineRoutes,
  error,
  parsePattern,
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  type Route,
} from "./shared";

const logger = createLogger("browser-auth");

/**
 * Local email/password sign-up is gated by the same provider-neutral admission
 * allowlists as OAuth: the registering email must match ALLOWED_EMAILS or an
 * ALLOWED_EMAIL_DOMAINS suffix, unless UNSAFE_ALLOW_ALL_USERS is set. This is
 * the only admission check for credentials — Better Auth's email/password flow
 * has no per-sign-in profile resolver, so the gate lives on sign-up.
 */
function isEmailPasswordSignUpAllowed(email: string, env: Env): boolean {
  if (parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS)) return true;
  const normalized = email.trim().toLowerCase();
  if (parseAdmissionAllowlist(env.ALLOWED_EMAILS).includes(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  if (at > 0) {
    const domain = normalized.slice(at + 1);
    if (parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS).includes(domain)) return true;
  }
  return false;
}

async function emailPasswordSignUpDenied(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/auth/sign-up/email") return false;

  let email: unknown;
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    email = body?.email;
  } catch {
    // Malformed JSON — defer to Better Auth's own validation for the error.
    return false;
  }

  if (typeof email !== "string" || email.length === 0) {
    // Defer to Better Auth's field validation.
    return false;
  }

  return !isEmailPasswordSignUpAllowed(email, env);
}

function copyBrowserAuthResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") {
      headers.append(name, value);
    }
  });
  const getSetCookie = (upstream as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookieValues = getSetCookie?.call(upstream) ?? [];
  if (setCookieValues.length === 0) {
    const value = upstream.get("Set-Cookie");
    if (value) setCookieValues.push(value);
  }
  for (const value of setCookieValues) {
    headers.append("Set-Cookie", value);
  }
  return headers;
}

/**
 * Better Auth's direct API establishes its request-state context explicitly.
 * Use it for session reads because Cloudflare Workers can lose the HTTP
 * handler's AsyncLocalStorage state before session-refresh policy is read.
 */
export async function forwardBrowserAuthRequest(
  auth: BetterAuthRuntime,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
    return auth.api.getSession({
      headers: request.headers,
      asResponse: true,
    });
  }
  return auth.handler(request);
}

const handleBrowserAuth: Route["handler"] = async (request, env, _match, ctx) => {
  try {
    if (!ctx.getUserAuth) {
      throw new UserAuthConfigurationError("User authentication runtime is unavailable");
    }
    if (await emailPasswordSignUpDenied(request, env)) {
      return error("Email is not admitted for sign-up", 403);
    }
    const response = await forwardBrowserAuthRequest(ctx.getUserAuth(), request);
    const headers = copyBrowserAuthResponseHeaders(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (cause) {
    if (cause instanceof UserAuthConfigurationError) {
      logger.error("Browser authentication is not configured", {
        event: "auth.browser.misconfigured",
        error: cause,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Browser authentication is not configured", 503);
    }
    throw cause;
  }
};

/**
 * The browser can reach only this positive Better Auth allowlist, and only
 * through a freshly signed service:web proxy request.
 */
export const browserAuthRoutes: Route[] = defineRoutes(
  SCM_AGNOSTIC_WEB_SERVICE_ROUTE,
  BROWSER_AUTH_PROXY_ROUTES.map(([method, path]) => ({
    method,
    pattern: parsePattern(path),
    handler: handleBrowserAuth,
  }))
);
