import { ScmConnectionCredentialStore, ScmConnectionStore } from "./db/scm-connections";
import { ScmRepositoryStore } from "./db/scm-repositories";
import { SessionInternalPaths } from "./session/contracts";
import {
  SourceControlConnectionRegistry,
  ScmConnectionDisabledError,
  ScmConnectionNotFoundError,
} from "./source-control/connection-registry";
import { supportsServerSideGitAuth } from "./source-control/types";
import type { Env } from "./types";
import { ScmGitCapabilityStore } from "./db/scm-git-capabilities";
import type { SqlDatabase } from "./db/sql-database";

const GIT_ROUTE =
  /^\/git\/session\/([A-Za-z0-9_-]{1,128})\/(repo_[A-Za-z0-9_-]{1,128})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const BUILD_GIT_ROUTE =
  /^\/git\/build\/([A-Za-z0-9_-]{1,128})\/(repo_[A-Za-z0-9_-]{1,128})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

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

function noStore(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", ...extra },
  });
}

function authenticationRequired(): Response {
  return noStore("Authentication required", 401, {
    "WWW-Authenticate": 'Basic realm="Open Inspect SCM proxy"',
  });
}

function decodeCapability(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username && username === password ? username : null;
  } catch {
    return null;
  }
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
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

async function sessionAuthorizesRepository(
  db: SqlDatabase,
  sessionId: string,
  repositoryId: string
): Promise<{ connectionId: string } | null> {
  const row = await db
    .prepare(
      `SELECT scm_connection_id
     FROM session_repositories
     WHERE session_id = ? AND repository_id = ?
     LIMIT 1`
    )
    .bind(sessionId, repositoryId)
    .first<{ scm_connection_id: string | null }>();
  return row?.scm_connection_id ? { connectionId: row.scm_connection_id } : null;
}

function upstreamRepositoryUrl(cloneUrl: string, cloneBaseUrl: string, operation: string): URL {
  const upstream = new URL(cloneUrl);
  const base = new URL(cloneBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    upstream.protocol !== "https:" ||
    upstream.username ||
    upstream.password ||
    upstream.origin !== base.origin ||
    (basePath && upstream.pathname !== basePath && !upstream.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("Repository clone URL is outside its pinned SCM connection");
  }
  upstream.pathname = `${upstream.pathname.replace(/\/+$/, "")}/${operation}`;
  upstream.search = "";
  upstream.hash = "";
  return upstream;
}

/**
 * Session/repository-authorized smart-HTTP proxy. Forge credentials are
 * resolved after authorization and never returned to the sandbox.
 */
export async function handleScmGitProxy(
  request: Request,
  url: URL,
  env: Env,
  db: SqlDatabase
): Promise<Response | null> {
  const match = GIT_ROUTE.exec(url.pathname) ?? BUILD_GIT_ROUTE.exec(url.pathname);
  if (!match) return null;
  const isBuild = url.pathname.startsWith("/git/build/");
  const [, subjectId, repositoryId, endpoint] = match;
  const advertisedService = url.searchParams.get("service");
  const operation: "read" | "write" =
    endpoint === "git-receive-pack" || advertisedService === "git-receive-pack" ? "write" : "read";
  const validService =
    endpoint !== "info/refs" ||
    advertisedService === "git-upload-pack" ||
    advertisedService === "git-receive-pack";
  const methodAllowed =
    (endpoint === "info/refs" && (request.method === "GET" || request.method === "HEAD")) ||
    (endpoint !== "info/refs" && request.method === "POST");
  if (!methodAllowed || !validService) return noStore("Method or service not allowed", 405);

  const capability = decodeCapability(request.headers.get("Authorization"));
  if (!capability) {
    return authenticationRequired();
  }
  const buildAuthorization = isBuild
    ? await new ScmGitCapabilityStore(db).verify(capability, {
        audience: "image_build_git",
        subjectId,
        repositoryId,
        operation,
      })
    : null;
  if (
    (isBuild && !buildAuthorization) ||
    (!isBuild && !(await verifySandboxToken(env, subjectId, capability)))
  ) {
    return authenticationRequired();
  }
  const authorization = isBuild
    ? { connectionId: buildAuthorization!.connectionId }
    : await sessionAuthorizesRepository(db, subjectId, repositoryId);
  if (!authorization) return noStore("Repository is not authorized for this session", 403);

  const repository = await new ScmRepositoryStore(db).get(repositoryId);
  if (
    !repository ||
    repository.connectionId !== authorization.connectionId ||
    repository.resolutionStatus !== "resolved" ||
    repository.removedAt != null ||
    !repository.cloneUrl
  ) {
    return noStore("Repository is unavailable", 404);
  }

  try {
    const registry = new SourceControlConnectionRegistry(env, {
      db,
      connections: new ScmConnectionStore(db),
      credentials: new ScmConnectionCredentialStore(db, env.TOKEN_ENCRYPTION_KEY),
    });
    const { connection, provider } = await registry.getConnection(authorization.connectionId);
    if (!supportsServerSideGitAuth(provider)) {
      return noStore("SCM connection does not support server-side Git authorization", 501);
    }
    const upstreamUrl = upstreamRepositoryUrl(
      repository.cloneUrl,
      connection.cloneBaseUrl,
      endpoint
    );
    if (endpoint === "info/refs" && advertisedService) {
      upstreamUrl.searchParams.set("service", advertisedService);
    }
    const auth = await provider.getUpstreamGitAuthorization(operation);
    const headers = new Headers(request.headers);
    for (const header of PRIVATE_REQUEST_HEADERS) headers.delete(header);
    headers.set("Authorization", basicAuthorization(auth.username, auth.password));
    headers.set("User-Agent", "Open-Inspect-SCM-Proxy/1.0");

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      return noStore("SCM upstream redirect refused", 502);
    }
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete("connection");
    responseHeaders.delete("set-cookie");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("location");
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (cause) {
    if (cause instanceof ScmConnectionNotFoundError)
      return noStore("SCM connection not found", 404);
    if (cause instanceof ScmConnectionDisabledError) return noStore("SCM connection disabled", 409);
    return noStore("SCM upstream unavailable", 502);
  }
}
