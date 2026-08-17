import { SessionInternalPaths } from "./session/contracts";
import type { Env } from "./types";

const GIT_ROUTE =
  /^\/git\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const PRIVATE_REQUEST_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "connection",
  "cookie",
  "forwarded",
  "host",
  "origin",
  "x-forwarded-for",
  "x-forwarded-proto",
] as const;

function authenticationRequired(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="Open Inspect GitHub proxy"',
    },
  });
}

function decodeProxyCredentials(header: string | null): {
  sandboxToken: string;
  githubToken: string;
} | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator <= 0 || separator === decoded.length - 1) return null;
    return {
      sandboxToken: decoded.slice(0, separator),
      githubToken: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

async function verifySandboxToken(env: Env, sessionId: string, token: string): Promise<boolean> {
  const durableObjectId = env.SESSION.idFromName(sessionId);
  const response = await env.SESSION.get(durableObjectId).fetch(
    new Request(`http://internal${SessionInternalPaths.verifySandboxToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
  );
  return response.ok;
}

/**
 * Proxy GitHub's smart-HTTP Git endpoints for sandboxes that cannot reach
 * github.com directly. The session capability is carried in Basic's username
 * slot and verified locally; only the installation token is forwarded to
 * GitHub, reconstructed with the conventional x-access-token username.
 */
export async function handleGitHubGitProxy(
  request: Request,
  url: URL,
  env: Env
): Promise<Response | null> {
  const match = GIT_ROUTE.exec(url.pathname);
  if (!match) return null;

  const [, sessionId, owner, repo, operation] = match;
  const methodAllowed =
    (operation === "info/refs" && (request.method === "GET" || request.method === "HEAD")) ||
    (operation !== "info/refs" && request.method === "POST");
  if (!methodAllowed) {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        Allow: operation === "info/refs" ? "GET, HEAD" : "POST",
        "Cache-Control": "no-store",
      },
    });
  }

  const credentials = decodeProxyCredentials(request.headers.get("Authorization"));
  if (!credentials) return authenticationRequired();
  if (!(await verifySandboxToken(env, sessionId, credentials.sandboxToken))) {
    return authenticationRequired();
  }

  const upstreamUrl = new URL(`https://github.com/${owner}/${repo}.git/${operation}`);
  upstreamUrl.search = url.search;
  const headers = new Headers(request.headers);
  for (const header of PRIVATE_REQUEST_HEADERS) headers.delete(header);
  headers.set("Authorization", `Basic ${btoa(`x-access-token:${credentials.githubToken}`)}`);
  headers.set("User-Agent", "Open-Inspect-Git-Proxy/1.0");

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  } catch {
    return new Response("GitHub upstream unavailable", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("connection");
  responseHeaders.delete("set-cookie");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
