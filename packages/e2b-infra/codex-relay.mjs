#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import process from "node:process";
import tls from "node:tls";
import { setTimeout } from "node:timers";
import { URL } from "node:url";

const listenHost = process.env.CODEX_RELAY_LISTEN_HOST || "127.0.0.1";
const listenPort = Number.parseInt(process.env.CODEX_RELAY_LISTEN_PORT || "18767", 10);
const upstreamHost = "chatgpt.com";
const upstreamPrefix = "/backend-api/codex";

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error("CODEX_RELAY_LISTEN_PORT must be a valid TCP port");
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const downstreamSockets = new Set();
const websocketUpstreamSockets = new Set();
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

function mappedUpstreamPath(rawUrl) {
  const url = new URL(rawUrl || "/", "http://relay.invalid");
  const allowed =
    url.pathname === "/models" ||
    url.pathname === "/responses" ||
    url.pathname.startsWith("/responses/");
  return allowed ? `${upstreamPrefix}${url.pathname}${url.search}` : null;
}

function upstreamHeaders(incoming, { upgrade = false } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lowerName = name.toLowerCase();
    if (
      hopByHopHeaders.has(lowerName) ||
      forwardedClientHeaders.has(lowerName) ||
      lowerName.startsWith("cf-") ||
      lowerName.startsWith("x-forwarded-")
    ) {
      continue;
    }
    if (value !== undefined) headers[lowerName] = value;
  }
  headers.host = upstreamHost;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function jsonError(response, statusCode, message) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message } }));
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }

  const upstreamPath = mappedUpstreamPath(request.url);
  if (!upstreamPath) {
    request.resume();
    jsonError(response, 404, "unsupported Codex relay path");
    return;
  }

  const upstreamRequest = https.request(
    {
      protocol: "https:",
      hostname: upstreamHost,
      port: 443,
      method: request.method,
      path: upstreamPath,
      headers: upstreamHeaders(request.headers),
      agent,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    }
  );
  upstreamRequest.on("error", () => {
    if (!response.headersSent) jsonError(response, 502, "Codex upstream unavailable");
    else response.destroy();
  });
  request.on("aborted", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
});

server.on("connection", (socket) => {
  downstreamSockets.add(socket);
  socket.once("close", () => downstreamSockets.delete(socket));
});

server.on("upgrade", (request, clientSocket, head) => {
  const upstreamPath = mappedUpstreamPath(request.url);
  if (!upstreamPath || !upstreamPath.startsWith(`${upstreamPrefix}/responses`)) {
    clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstreamSocket = tls.connect({ host: upstreamHost, port: 443, servername: upstreamHost });
  websocketUpstreamSockets.add(upstreamSocket);
  upstreamSocket.once("close", () => websocketUpstreamSockets.delete(upstreamSocket));
  upstreamSocket.once("secureConnect", () => {
    const headers = upstreamHeaders(request.headers, { upgrade: true });
    const headerLines = Object.entries(headers).flatMap(([name, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return values.map((item) => `${name}: ${item}`);
    });
    upstreamSocket.write(
      `${request.method || "GET"} ${upstreamPath} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`
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
server.listen(listenPort, listenHost, () => {
  process.stdout.write(`Codex relay listening on http://${listenHost}:${listenPort}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));

  const forceCloseTimer = setTimeout(() => {
    for (const socket of downstreamSockets) socket.destroy();
    for (const socket of websocketUpstreamSockets) socket.destroy();
    agent.destroy();
  }, 5_000);
  forceCloseTimer.unref();

  const forceExitTimer = setTimeout(() => process.exit(0), 10_000);
  forceExitTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, shutdown);
}
