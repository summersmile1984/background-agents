#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import tls from "node:tls";
import { setTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

const CHATGPT_UPSTREAM_HOST = "chatgpt.com";
const CHATGPT_UPSTREAM_PREFIX = "/backend-api/codex";
const DEEPSEEK_UPSTREAM_HOST = "api.deepseek.com";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const forwardedClientHeaders = new Set([
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

function canonicalDeepSeekPath(protocol, pathname) {
  const path = pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
  if (protocol === "openai") {
    const allowed =
      path === "/models" ||
      path === "/responses" ||
      path.startsWith("/responses/") ||
      path === "/chat/completions";
    return allowed ? path : null;
  }
  if (protocol === "anthropic") {
    const allowed = path === "/messages" || path === "/messages/count_tokens";
    return allowed ? `/anthropic/v1${path}` : null;
  }
  return null;
}

export function routeForRequest(rawUrl) {
  const url = new URL(rawUrl || "/", "http://relay.invalid");
  const chatGptAllowed =
    url.pathname === "/models" ||
    url.pathname === "/responses" ||
    url.pathname.startsWith("/responses/");
  if (chatGptAllowed) {
    return {
      kind: "chatgpt",
      upstreamHost: CHATGPT_UPSTREAM_HOST,
      upstreamPath: `${CHATGPT_UPSTREAM_PREFIX}${url.pathname}${url.search}`,
    };
  }

  const match = url.pathname.match(/^\/sessions\/([^/]+)\/deepseek\/(openai|anthropic)(\/.*)$/);
  if (!match || !SESSION_ID_PATTERN.test(match[1])) return null;
  const upstreamPath = canonicalDeepSeekPath(match[2], match[3]);
  if (!upstreamPath) return null;
  return {
    kind: "deepseek",
    protocol: match[2],
    sessionId: match[1],
    upstreamHost: DEEPSEEK_UPSTREAM_HOST,
    upstreamPath: `${upstreamPath}${url.search}`,
  };
}

function clientToken(headers) {
  const authorization = headers.authorization;
  const bearer =
    typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
  const rawApiKey = headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey || "";
  if (bearer && apiKey && bearer !== apiKey) return null;
  return bearer || apiKey || null;
}

export function upstreamHeaders(
  incoming,
  { upstreamHost, protocol, providerApiKey, upgrade = false }
) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lowerName = name.toLowerCase();
    if (
      hopByHopHeaders.has(lowerName) ||
      forwardedClientHeaders.has(lowerName) ||
      lowerName === "host" ||
      (providerApiKey && (lowerName === "authorization" || lowerName === "x-api-key")) ||
      lowerName.startsWith("cf-") ||
      lowerName.startsWith("x-forwarded-")
    ) {
      continue;
    }
    if (value !== undefined) headers[lowerName] = value;
  }
  headers.host = upstreamHost;
  if (providerApiKey) {
    if (protocol === "anthropic") headers["x-api-key"] = providerApiKey;
    else headers.authorization = `Bearer ${providerApiKey}`;
  }
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function responseHeaders(incoming) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  return headers;
}

function jsonError(response, statusCode, message) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { message } }));
}

function readDeepSeekApiKey(path) {
  if (!path) return null;
  try {
    const key = fs.readFileSync(path, "utf8").trim();
    return key || null;
  } catch {
    return null;
  }
}

function validateControlPlaneUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("MODEL_RELAY_CONTROL_PLANE_URL must be an HTTPS URL without userinfo");
  }
  return url;
}

function verifySandboxToken(controlPlaneUrl, sessionId, token, agent) {
  return new Promise((resolve) => {
    if (!controlPlaneUrl || !token) {
      resolve({ ok: false, unavailable: !controlPlaneUrl });
      return;
    }
    const basePath = controlPlaneUrl.pathname.replace(/\/$/, "");
    const request = https.request(
      {
        protocol: "https:",
        hostname: controlPlaneUrl.hostname,
        port: controlPlaneUrl.port || 443,
        method: "POST",
        path: `${basePath}/sessions/${encodeURIComponent(sessionId)}/model-relay-auth`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": "0",
        },
        agent,
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        resolve({ ok: response.statusCode === 204, unavailable: false });
      }
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve({ ok: false, unavailable: true }));
    request.end();
  });
}

function proxyRequest(request, response, route, headers, agent) {
  const upstreamRequest = https.request(
    {
      protocol: "https:",
      hostname: route.upstreamHost,
      port: 443,
      method: request.method,
      path: route.upstreamPath,
      headers,
      agent,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        responseHeaders(upstreamResponse.headers)
      );
      upstreamResponse.pipe(response);
    }
  );
  upstreamRequest.on("error", () => {
    if (!response.headersSent) jsonError(response, 502, "model upstream unavailable");
    else response.destroy();
  });
  request.on("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

export function createRelayServer({
  deepSeekApiKey,
  controlPlaneUrl,
  agent = new https.Agent({ keepAlive: true, maxSockets: 64 }),
} = {}) {
  const downstreamSockets = new Set();
  const websocketUpstreamSockets = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", deepseek: Boolean(deepSeekApiKey) }));
      return;
    }

    const route = routeForRequest(request.url);
    if (!route) {
      request.resume();
      jsonError(response, 404, "unsupported model relay path");
      return;
    }

    if (route.kind === "deepseek") {
      if (!deepSeekApiKey) {
        request.resume();
        jsonError(response, 503, "DeepSeek relay is not configured");
        return;
      }
      const token = clientToken(request.headers);
      if (!token) {
        request.resume();
        jsonError(response, 401, "missing or ambiguous sandbox credential");
        return;
      }
      const verified = await verifySandboxToken(controlPlaneUrl, route.sessionId, token, agent);
      if (!verified.ok) {
        request.resume();
        jsonError(
          response,
          verified.unavailable ? 503 : 401,
          verified.unavailable ? "sandbox authorization unavailable" : "invalid sandbox credential"
        );
        return;
      }
      proxyRequest(
        request,
        response,
        route,
        upstreamHeaders(request.headers, {
          upstreamHost: route.upstreamHost,
          protocol: route.protocol,
          providerApiKey: deepSeekApiKey,
        }),
        agent
      );
      return;
    }

    proxyRequest(
      request,
      response,
      route,
      upstreamHeaders(request.headers, { upstreamHost: route.upstreamHost }),
      agent
    );
  });

  server.on("connection", (socket) => {
    downstreamSockets.add(socket);
    socket.once("close", () => downstreamSockets.delete(socket));
  });

  // ChatGPT subscription traffic can use the Responses WebSocket transport.
  // DeepSeek routes intentionally stay HTTP/SSE-only because the public API
  // does not advertise a compatible WebSocket endpoint.
  server.on("upgrade", (request, clientSocket, head) => {
    const route = routeForRequest(request.url);
    if (
      !route ||
      route.kind !== "chatgpt" ||
      !route.upstreamPath.startsWith(`${CHATGPT_UPSTREAM_PREFIX}/responses`)
    ) {
      clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    const upstreamSocket = tls.connect({
      host: route.upstreamHost,
      port: 443,
      servername: route.upstreamHost,
    });
    websocketUpstreamSockets.add(upstreamSocket);
    upstreamSocket.once("close", () => websocketUpstreamSockets.delete(upstreamSocket));
    upstreamSocket.once("secureConnect", () => {
      const headers = upstreamHeaders(request.headers, {
        upstreamHost: route.upstreamHost,
        upgrade: true,
      });
      const headerLines = Object.entries(headers).flatMap(([name, value]) => {
        const values = Array.isArray(value) ? value : [value];
        return values.map((item) => `${name}: ${item}`);
      });
      upstreamSocket.write(
        `${request.method || "GET"} ${route.upstreamPath} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`
      );
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    upstreamSocket.once("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
  });

  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of downstreamSockets) socket.destroy();
        for (const socket of websocketUpstreamSockets) socket.destroy();
        agent.destroy();
      }),
  };
}

function startFromEnvironment() {
  const listenHost = process.env.CODEX_RELAY_LISTEN_HOST || "127.0.0.1";
  const listenPort = Number.parseInt(process.env.CODEX_RELAY_LISTEN_PORT || "18767", 10);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("CODEX_RELAY_LISTEN_PORT must be a valid TCP port");
  }

  const controlPlaneUrl = validateControlPlaneUrl(process.env.MODEL_RELAY_CONTROL_PLANE_URL);
  const deepSeekApiKey = readDeepSeekApiKey(process.env.DEEPSEEK_API_KEY_FILE);
  const relay = createRelayServer({ deepSeekApiKey, controlPlaneUrl });
  relay.server.listen(listenPort, listenHost, () => {
    process.stdout.write(
      `Open-Inspect model relay listening on http://${listenHost}:${listenPort}\n`
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    relay.close().finally(() => process.exit(0));
    const forceExitTimer = setTimeout(() => process.exit(0), 10_000);
    forceExitTimer.unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment();
}
