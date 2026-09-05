/**
 * HTTP server: splits the API surface from the edge surface by Host header.
 *
 * A single listener serves both because the cloudflared ingress records for
 * `cubeapi.<domain>` (API) and `*.<shimDomain>` (edge) point at the same local
 * port. Hostnames that match neither surface get 404.
 */

import http from "node:http";
import type { ShimConfig } from "./config.js";
import type { ShimStore } from "./store.js";
import type { CubeClient } from "./cube-client.js";
import { isValidApiKey } from "./auth.js";
import { handleApiRequest } from "./api-surface.js";
import { handleEdgeRequest, handleEdgeUpgrade, parseEdgeHost } from "./edge-surface.js";

export interface ServerDeps {
  config: ShimConfig;
  store: ShimStore;
  cube: CubeClient;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createShimServer(deps: ServerDeps): http.Server {
  const { config, store, cube } = deps;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://shim.invalid");

      if (url.pathname === "/health") {
        return json(res, 200, { status: "ok" });
      }

      const edgeTarget = parseEdgeHost(req.headers.host, config.shimDomain);
      if (edgeTarget) {
        return handleEdgeRequest({ config, store }, req, res, edgeTarget);
      }

      // API surface: X-API-Key against the shim's own key pool.
      const key = req.headers["x-api-key"];
      const provided = Array.isArray(key) ? key[0] : (key ?? null);
      if (!isValidApiKey(provided, config.apiKeys)) {
        return json(res, 401, {
          code: 401,
          message: "Missing authentication: provide 'X-API-Key: <key>'",
        });
      }

      await handleApiRequest({ config, store, cube }, req, res, url);
    })().catch((error) => {
      if (!res.headersSent) {
        json(res, 500, {
          code: 500,
          message: error instanceof Error ? error.message : "internal shim error",
        });
      } else {
        res.destroy();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const edgeTarget = parseEdgeHost(req.headers.host, config.shimDomain);
    if (!edgeTarget) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    handleEdgeUpgrade({ config, store }, req, socket, head, edgeTarget);
  });

  return server;
}
