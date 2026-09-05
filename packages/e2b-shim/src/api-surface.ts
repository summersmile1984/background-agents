/**
 * E2B-facing API surface: request routing plus the per-route semantic
 * alignment between official E2B SaaS and CubeSandbox v0.6.0.
 *
 * Alignments implemented here:
 *  - create: top-level `autoPause`/`autoResume` map onto Cube's nested
 *    `lifecycle{onTimeout,autoResume}` object (Cube silently ignores the
 *    top-level fields and would otherwise kill on TTL expiry);
 *    `secure:true` mints a shim-side envdAccessToken; the response gains
 *    startedAt/endAt (merged from Cube's GET) and the rewritten domain.
 *  - connect: E2B answers 200 when already running, 201 after a paused
 *    sandbox resumes; Cube always answers 200, so the shim tracks state.
 *  - list (v1 + v2): state/metadata filtering and cursor pagination done
 *    in memory (Cube v2 lacks metadata filtering and its nextToken is
 *    parsed but unimplemented); Cube-internal metadata keys are stripped.
 *  - get/kill/pause/timeout/logs/templates: passthrough with domain and
 *    metadata normalization.
 */

import { get as httpGet } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ShimConfig } from "./config.js";
import type { ShimStore } from "./store.js";
import type { CubeClient } from "./cube-client.js";
import { generateEnvdToken } from "./auth.js";

export interface ApiContext {
  config: ShimConfig;
  store: ShimStore;
  cube: CubeClient;
}

/** Metadata keys Cube injects that must not leak to E2B clients. */
const CUBE_INTERNAL_METADATA = /^cube\./;
const EXTRA_INTERNAL_METADATA_KEYS = new Set(["X-Caller"]);

export function stripInternalMetadata(
  metadata: unknown,
  enabled: boolean
): Record<string, string> | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const entries = Object.entries(metadata as Record<string, unknown>).filter(
    ([key]) =>
      !(enabled && (CUBE_INTERNAL_METADATA.test(key) || EXTRA_INTERNAL_METADATA_KEYS.has(key)))
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

export function normalizeSandbox(
  sandbox: Record<string, unknown>,
  config: ShimConfig
): Record<string, unknown> {
  const out = { ...sandbox };
  if (config.shimDomain && "domain" in out) {
    out.domain = config.shimDomain;
  }
  const stripped = stripInternalMetadata(out.metadata, config.stripCubeMetadata);
  if ("metadata" in out) {
    if (stripped) out.metadata = stripped;
    else delete out.metadata;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function sendShimError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { code: status, message });
}

/** Relay Cube's response verbatim (status + body + content-type). */
function relay(
  res: ServerResponse,
  upstream: { status: number; body: string; contentType: string }
): void {
  res.writeHead(upstream.status, {
    "Content-Type": upstream.contentType || "application/json",
  });
  res.end(upstream.body);
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

interface CreateRequestBody {
  templateID?: string;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeout?: number;
  secure?: boolean;
  autoPause?: boolean;
  autoResume?: { enabled?: boolean };
  lifecycle?: { onTimeout?: string; autoResume?: boolean };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Template alias resolution (E2B accepts an alias wherever a templateID goes)
// ---------------------------------------------------------------------------

interface CubeTemplate {
  templateID: string;
  aliases?: string[];
}

const aliasCache = new Map<string, { templateId: string; expiresAtMs: number }>();
const ALIAS_CACHE_TTL_MS = 60_000;

/** Test hook: drop all cached alias resolutions. */
export function clearAliasCache(): void {
  aliasCache.clear();
}

async function resolveTemplateRef(ctx: ApiContext, ref: string): Promise<string> {
  if (ref.startsWith("tpl-")) return ref;
  const cached = aliasCache.get(ref);
  if (cached && cached.expiresAtMs > Date.now()) return cached.templateId;

  const { data } = await ctx.cube.requestJson<CubeTemplate[]>("GET", "/templates");
  for (const tpl of data) {
    for (const alias of tpl.aliases ?? []) {
      aliasCache.set(alias, {
        templateId: tpl.templateID,
        expiresAtMs: Date.now() + ALIAS_CACHE_TTL_MS,
      });
    }
  }
  const resolved = aliasCache.get(ref);
  if (!resolved) {
    throw new ShimHttpError(404, `Template not found: ${ref}`);
  }
  return resolved.templateId;
}

export class ShimHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimHttpError";
  }
}

async function handleCreate(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  let body: CreateRequestBody;
  try {
    body = raw.length ? (JSON.parse(raw.toString("utf8")) as CreateRequestBody) : {};
  } catch {
    return sendShimError(res, 400, "Invalid JSON body");
  }
  if (!body.templateID) {
    return sendShimError(res, 400, "templateID is required");
  }
  body.templateID = await resolveTemplateRef(ctx, body.templateID);

  // Map E2B's top-level convenience fields onto Cube's nested lifecycle object.
  const lifecycle: Record<string, unknown> = { ...(body.lifecycle ?? {}) };
  if (body.autoPause === true && lifecycle.onTimeout === undefined) {
    lifecycle.onTimeout = "pause";
  }
  if (
    body.autoResume &&
    typeof body.autoResume === "object" &&
    lifecycle.autoResume === undefined
  ) {
    lifecycle.autoResume = body.autoResume.enabled === true;
  }
  delete body.autoPause;
  delete body.autoResume;
  if (Object.keys(lifecycle).length > 0)
    body.lifecycle = lifecycle as CreateRequestBody["lifecycle"];

  const upstream = await ctx.cube.request("POST", "/sandboxes", body);
  if (upstream.status >= 400) return relay(res, upstream);

  const created = JSON.parse(upstream.body) as Record<string, unknown>;
  const sandboxId = String(created.sandboxID);

  let envdToken: string | null = null;
  if (body.secure === true) {
    envdToken = generateEnvdToken();
    created.envdAccessToken = envdToken;
  }

  // E2B's create response omits startedAt/endAt; Cube's does too, but its GET
  // has them. Merge best-effort so TTL-aware callers can schedule immediately.
  try {
    const detail = await ctx.cube.requestJson<Record<string, unknown>>(
      "GET",
      `/sandboxes/${sandboxId}`
    );
    if (detail.data.startedAt) created.startedAt = detail.data.startedAt;
    if (detail.data.endAt) created.endAt = detail.data.endAt;
  } catch {
    // Detail merge is best-effort; the create itself already succeeded.
  }

  ctx.store.recordSandbox({
    sandboxId,
    templateId: String(created.templateID ?? body.templateID),
    createdAtMs: Date.now(),
    timeoutSeconds: typeof body.timeout === "number" ? body.timeout : null,
    autoPause: lifecycle.onTimeout === "pause",
    lastKnownState: "running",
    envdToken,
  });

  sendJson(res, upstream.status, normalizeSandbox(created, ctx.config));
}

async function handleGet(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const upstream = await ctx.cube.request("GET", `/sandboxes/${id}`);
  if (upstream.status >= 400) return relay(res, upstream);
  const detail = JSON.parse(upstream.body) as Record<string, unknown>;
  const row = ctx.store.getSandbox(id);
  if (row?.envdToken) detail.envdAccessToken = row.envdToken;
  if (row) ctx.store.setState(id, String(detail.state ?? row.lastKnownState));
  sendJson(res, upstream.status, normalizeSandbox(detail, ctx.config));
}

async function handleKill(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const upstream = await ctx.cube.request("DELETE", `/sandboxes/${id}`);
  if (upstream.status < 400 || upstream.status === 404) {
    ctx.store.removeSandbox(id);
  }
  relay(res, upstream);
}

async function handlePause(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/pause`);
  if (upstream.status < 400) ctx.store.setState(id, "paused");
  relay(res, upstream);
}

async function handleConnect(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    return sendShimError(res, 400, "Invalid JSON body");
  }

  // E2B status semantics: 200 when already running, 201 when this call
  // resumed a paused sandbox. Cube returns 200 for both, so consult the
  // store first and fall back to Cube's advertised state.
  let wasPaused = ctx.store.getSandbox(id)?.lastKnownState === "paused";
  if (!wasPaused) {
    try {
      const detail = await ctx.cube.requestJson<{ state?: string }>("GET", `/sandboxes/${id}`);
      wasPaused = detail.data.state === "paused";
    } catch {
      // Unknown state: relay Cube's status code unchanged.
    }
  }

  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/connect`, body);
  if (upstream.status >= 400) return relay(res, upstream);

  ctx.store.setState(id, "running");
  const connected = upstream.body ? (JSON.parse(upstream.body) as Record<string, unknown>) : {};
  const row = ctx.store.getSandbox(id);
  if (row?.envdToken) connected.envdAccessToken = row.envdToken;
  sendJson(res, wasPaused ? 201 : 200, normalizeSandbox(connected, ctx.config));
}

async function handleSetTimeout(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    return sendShimError(res, 400, "Invalid JSON body");
  }
  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/timeout`, body);
  relay(res, upstream);
}

// ---------------------------------------------------------------------------
// List (v1 deprecated + v2) with in-memory filtering and pagination
// ---------------------------------------------------------------------------

interface ListedSandbox {
  sandboxID: string;
  state?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

/** E2B v2 metadata query: a single `metadata` param holding an embedded URL-encoded `k=v&k2=v2` string. */
function parseMetadataFilter(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(token: string | null): number {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const match = /^offset:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

async function fetchAllSandboxes(ctx: ApiContext): Promise<ListedSandbox[]> {
  // Cube's v2 supports state/limit but not metadata/cursor; pull unfiltered
  // (v1 shape, which includes paused sandboxes) and normalize in memory.
  const upstream = await ctx.cube.requestJson<ListedSandbox[]>("GET", "/v2/sandboxes");
  return upstream.data;
}

async function handleList(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  v2: boolean
): Promise<void> {
  let all: ListedSandbox[];
  try {
    all = await fetchAllSandboxes(ctx);
  } catch (error) {
    return sendShimError(res, 502, error instanceof Error ? error.message : "upstream list failed");
  }

  const stateFilter = (url.searchParams.get("state") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const metadataFilter = v2
    ? parseMetadataFilter(url.searchParams.get("metadata"))
    : parseMetadataFilter(url.searchParams.get("metadata"));

  let filtered = all.map((s) => normalizeSandbox(s, ctx.config) as ListedSandbox);
  if (stateFilter.length > 0) {
    filtered = filtered.filter(
      (s) => s.state !== undefined && stateFilter.includes(String(s.state))
    );
  }
  const metadataEntries = Object.entries(metadataFilter);
  if (metadataEntries.length > 0) {
    filtered = filtered.filter((s) => {
      const metadata: Record<string, string> = s.metadata ?? {};
      return metadataEntries.every(([k, v]) => metadata[k] === v);
    });
  }

  if (!v2) {
    // v1 (deprecated): bare array, no pagination.
    return sendJson(res, 200, filtered);
  }

  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(Number.parseInt(limitParam ?? "100", 10) || 100, 1), 100);
  const offset = decodeCursor(url.searchParams.get("nextToken"));
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const totalRunning = filtered.filter((s) => s.state === "running").length;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (nextOffset < filtered.length) headers["X-Next-Token"] = encodeCursor(nextOffset);
  headers["X-Total-Running"] = String(totalRunning);
  res.writeHead(200, headers);
  res.end(JSON.stringify(page));
}

// ---------------------------------------------------------------------------
// Metrics: Cube has no control-plane metrics endpoint; pull envd /metrics.
// ---------------------------------------------------------------------------

/**
 * Convert envd's single-point metrics JSON
 * ({ts, cpu_count, cpu_used_pct, mem_used, mem_total, mem_cache, disk_used, disk_total})
 * into E2B's SandboxMetric[] ({timestampUnix, cpuCount, cpuUsedPct, memUsed,
 * memTotal, memCache, diskUsed, diskTotal}; bytes). Unknown shapes degrade to
 * an empty series rather than an error so SDK polling never hard-fails.
 */
export function transformEnvdMetrics(payload: string): unknown[] {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== "object" || parsed === null) return [];
    if (typeof parsed.ts !== "number") return [];
    return [
      {
        timestampUnix: parsed.ts,
        cpuCount: parsed.cpu_count ?? 0,
        cpuUsedPct: parsed.cpu_used_pct ?? 0,
        memUsed: parsed.mem_used ?? 0,
        memTotal: parsed.mem_total ?? 0,
        memCache: parsed.mem_cache ?? 0,
        diskUsed: parsed.disk_used ?? 0,
        diskTotal: parsed.disk_total ?? 0,
      },
    ];
  } catch {
    return [];
  }
}

/** Latest-metric fan-in for `GET /sandboxes/metrics?sandbox_ids=a,b,c`. */
async function handleBatchMetrics(ctx: ApiContext, res: ServerResponse, url: URL): Promise<void> {
  const ids = (url.searchParams.get("sandbox_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (ids.length === 0) {
    return sendShimError(res, 400, "sandbox_ids query parameter is required");
  }
  const out: Record<string, unknown> = {};
  await Promise.all(
    ids.map(async (id) => {
      const series = await fetchMetricsSeries(ctx, id);
      if (series.length > 0) out[id] = series[series.length - 1];
    })
  );
  sendJson(res, 200, { sandboxes: out });
}

async function fetchMetricsSeries(ctx: ApiContext, id: string): Promise<unknown[]> {
  // node:http (not fetch): undici refuses to send a custom Host header, and
  // cube-proxy routes purely on Host.
  const proxyBase = new URL(ctx.config.cubeProxyUrl);
  return new Promise((resolve) => {
    const req = httpGet(
      {
        hostname: proxyBase.hostname,
        port: proxyBase.port || 80,
        path: "/metrics",
        headers: { Host: `49983-${id}.${ctx.config.cubeDomain}` },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) return resolve([]);
          resolve(transformEnvdMetrics(Buffer.concat(chunks).toString("utf8")));
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.on("error", () => resolve([]));
  });
}

async function handleMetrics(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const series = await fetchMetricsSeries(ctx, id);
  if (series.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Shim-Degraded": "metrics" });
    res.end("[]");
    return;
  }
  sendJson(res, 200, series);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SANDBOX_ID_RE = /^\/sandboxes\/([^/]+)(\/(pause|connect|timeout|metrics))?$/;

export async function handleApiRequest(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  try {
    if (method === "POST" && pathname === "/sandboxes") return await handleCreate(ctx, req, res);
    if (method === "GET" && pathname === "/sandboxes")
      return await handleList(ctx, req, res, url, false);
    if (method === "GET" && pathname === "/v2/sandboxes")
      return await handleList(ctx, req, res, url, true);
    if (method === "GET" && pathname === "/sandboxes/metrics")
      return await handleBatchMetrics(ctx, res, url);

    const sandboxMatch = SANDBOX_ID_RE.exec(pathname);
    if (sandboxMatch) {
      const [, id, , action] = sandboxMatch;
      if (!action) {
        if (method === "GET") return await handleGet(ctx, res, id);
        if (method === "DELETE") return await handleKill(ctx, res, id);
      }
      if (action === "pause" && method === "POST") return await handlePause(ctx, res, id);
      if (action === "connect" && method === "POST") return await handleConnect(ctx, req, res, id);
      if (action === "timeout" && method === "POST")
        return await handleSetTimeout(ctx, req, res, id);
      if (action === "metrics" && method === "GET") return await handleMetrics(ctx, res, id);
    }

    // Logs and templates: straight passthrough (Cube's shapes already match).
    if (method === "GET" && /^\/v2\/sandboxes\/[^/]+\/logs$/.test(pathname)) {
      return relay(res, await ctx.cube.request("GET", pathname + url.search));
    }
    if (
      (method === "GET" && (pathname === "/templates" || /^\/templates\/[^/]+$/.test(pathname))) ||
      (method === "POST" && pathname === "/templates") ||
      (method === "DELETE" && /^\/templates\/[^/]+$/.test(pathname))
    ) {
      const raw = method === "GET" ? undefined : await readBody(req);
      const body = raw && raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
      return relay(res, await ctx.cube.request(method, pathname + url.search, body));
    }

    sendShimError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? (error.status as number)
        : 502;
    sendShimError(res, status, message);
  }
}
