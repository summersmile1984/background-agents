import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startMockUpstream,
  startShim,
  TEST_API_KEY,
  type MockUpstream,
  type RunningShim,
} from "./test-helpers.js";
import { clearAliasCache } from "./api-surface.js";

const SANDBOX_ID = "abc123def456";

function cubeCreated(overrides: Record<string, unknown> = {}) {
  return {
    sandboxID: SANDBOX_ID,
    templateID: "tpl-x",
    clientID: "192.168.9.100",
    envdVersion: "0.2.0",
    domain: "cube.app",
    ...overrides,
  };
}

function cubeDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...cubeCreated(),
    state: "running",
    startedAt: "2026-09-04T00:00:00Z",
    endAt: "2026-09-04T01:00:00Z",
    metadata: { "cube.product": "cubebox", "X-Caller": "X-Caller", team: "blue" },
    ...overrides,
  };
}

describe("api surface auth", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    upstream = await startMockUpstream(() => ({ status: 200, body: [] }));
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("rejects missing API key with E2B-shaped 401", async () => {
    const res = await fetch(`${shim.url}/sandboxes`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 401 });
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects wrong API key", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, { headers: { "X-API-Key": "nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts configured key and forwards backend credential", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, { headers: { "X-API-Key": TEST_API_KEY } });
    expect(res.status).toBe(200);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("cube-backend-key");
  });

  it("exempts /health from auth", async () => {
    const res = await fetch(`${shim.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("create sandbox", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("maps autoPause/autoResume onto Cube's nested lifecycle object", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        timeout: 600,
        autoPause: true,
        autoResume: { enabled: true },
      }),
    });
    expect(res.status).toBe(201);
    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.lifecycle).toEqual({ onTimeout: "pause", autoResume: true });
    expect(forwarded.autoPause).toBeUndefined();
    expect(forwarded.autoResume).toBeUndefined();
  });

  it("does not clobber a caller-provided lifecycle object", async () => {
    await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        lifecycle: { onTimeout: "kill" },
        autoPause: true,
      }),
    });
    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.lifecycle).toEqual({ onTimeout: "kill" });
  });

  it("mints envdAccessToken when secure and records the sandbox", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x", secure: true, timeout: 600 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.envdAccessToken).toMatch(/^v1_/);
    expect(body.domain).toBe("sb.test");
    expect(body.startedAt).toBe("2026-09-04T00:00:00Z");
    expect(body.endAt).toBe("2026-09-04T01:00:00Z");

    const row = shim.store.getSandbox(SANDBOX_ID);
    expect(row).not.toBeNull();
    expect(row?.envdToken).toBe(body.envdAccessToken);
    expect(row?.timeoutSeconds).toBe(600);
  });

  it("omits envdAccessToken without secure", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x" }),
    });
    const body = await res.json();
    expect(body.envdAccessToken).toBeUndefined();
    expect(shim.store.getSandbox(SANDBOX_ID)?.envdToken).toBeNull();
  });

  it("relays upstream create errors unchanged", async () => {
    await upstream.close();
    await shim.close();
    upstream = await startMockUpstream(() => ({
      status: 500,
      body: { code: 500, message: "template not found" },
    }));
    shim = await startShim(upstream.url);
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-missing" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 500, message: "template not found" });
  });
});

describe("pause/connect status semantics", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    let state = "running";
    upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail({ state }) };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/pause`) {
        state = "paused";
        return { status: 204 };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/connect`) {
        state = "running";
        return { status: 200, body: cubeCreated() };
      }
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  async function createSecure(): Promise<string> {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x", secure: true }),
    });
    return (await res.json()).envdAccessToken;
  }

  it("answers 201 when connect resumed a paused sandbox, 200 when running", async () => {
    const token = await createSecure();

    const first = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 600 }),
    });
    expect(first.status).toBe(200);

    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    });

    const resumed = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 600 }),
    });
    expect(resumed.status).toBe(201);
    const body = await resumed.json();
    expect(body.envdAccessToken).toBe(token);
    expect(body.domain).toBe("sb.test");
  });
});

describe("list filtering and pagination", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  const entries = [
    { sandboxID: "s1", state: "running", metadata: { team: "blue", "cube.product": "cubebox" } },
    { sandboxID: "s2", state: "paused", metadata: { team: "blue" } },
    { sandboxID: "s3", state: "running", metadata: { team: "red" } },
  ];

  beforeEach(async () => {
    upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/v2/sandboxes")
        return { status: 200, body: entries };
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("v2 filters by state and strips cube-internal metadata", async () => {
    const res = await fetch(`${shim.url}/v2/sandboxes?state=running`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s1", "s3"]);
    expect(body[0].metadata).toEqual({ team: "blue" });
    expect(res.headers.get("X-Total-Running")).toBe("2");
  });

  it("v2 filters by embedded metadata query", async () => {
    const res = await fetch(
      `${shim.url}/v2/sandboxes?metadata=${encodeURIComponent("team=blue")}`,
      {
        headers: { "X-API-Key": TEST_API_KEY },
      }
    );
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s1", "s2"]);
  });

  it("v2 paginates with limit and nextToken cursor", async () => {
    const page1 = await fetch(`${shim.url}/v2/sandboxes?limit=2`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body1 = await page1.json();
    expect(body1).toHaveLength(2);
    const cursor = page1.headers.get("X-Next-Token");
    expect(cursor).toBeTruthy();

    const page2 = await fetch(`${shim.url}/v2/sandboxes?limit=2&nextToken=${cursor}`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body2 = await page2.json();
    expect(body2).toHaveLength(1);
    expect(page2.headers.get("X-Next-Token")).toBeNull();
  });

  it("v1 returns a bare filtered array", async () => {
    const res = await fetch(`${shim.url}/sandboxes?state=paused`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s2"]);
  });
});

describe("template alias resolution", () => {
  it("resolves an alias to its templateID before forwarding create", async () => {
    clearAliasCache();
    const upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/templates") {
        return { status: 200, body: [{ templateID: "tpl-real", aliases: ["my-alias"] }] };
      }
      if (req.method === "POST" && req.path === "/sandboxes") {
        const body = JSON.parse(req.body);
        if (body.templateID !== "tpl-real") {
          return { status: 404, body: { code: 404, message: "template not found" } };
        }
        return { status: 201, body: cubeCreated({ templateID: "tpl-real" }) };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      const res = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "my-alias" }),
      });
      expect(res.status).toBe(201);

      clearAliasCache();
      const missing = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "no-such-alias" }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 404 });
    } finally {
      await shim.close();
      await upstream.close();
    }
  });
});

describe("metrics transform", () => {
  it("maps envd single-point JSON onto E2B SandboxMetric[]", async () => {
    const { transformEnvdMetrics } = await import("./api-surface.js");
    const envd = JSON.stringify({
      ts: 1788578431,
      cpu_count: 4,
      cpu_used_pct: 2.41,
      mem_total: 8338272256,
      mem_used: 549847040,
      mem_cache: 17616896,
      disk_used: 217157632,
      disk_total: 3921543168,
    });
    expect(transformEnvdMetrics(envd)).toEqual([
      {
        timestampUnix: 1788578431,
        cpuCount: 4,
        cpuUsedPct: 2.41,
        memUsed: 549847040,
        memTotal: 8338272256,
        memCache: 17616896,
        diskUsed: 217157632,
        diskTotal: 3921543168,
      },
    ]);
  });

  it("degrades unknown payloads to an empty series", async () => {
    const { transformEnvdMetrics } = await import("./api-surface.js");
    expect(transformEnvdMetrics("not json")).toEqual([]);
    expect(transformEnvdMetrics('{"foo":1}')).toEqual([]);
  });
});

describe("kill and get", () => {
  it("get strips internal metadata and kill forgets the sandbox", async () => {
    let alive = true;
    const upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return alive
          ? { status: 200, body: cubeDetail() }
          : { status: 404, body: { code: 404, message: "not found" } };
      }
      if (req.method === "DELETE" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        alive = false;
        return { status: 204 };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x" }),
      });
      const get = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      const detail = await get.json();
      expect(detail.metadata).toEqual({ team: "blue" });
      expect(detail.domain).toBe("sb.test");

      const kill = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(kill.status).toBe(204);
      expect(shim.store.getSandbox(SANDBOX_ID)).toBeNull();
    } finally {
      await shim.close();
      await upstream.close();
    }
  });
});
