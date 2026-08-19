import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRelayServer,
  resolveAdminAuthSecret,
  routeForRequest,
  upstreamHeaders,
} from "./codex-relay.mjs";
import {
  createFileBackedDeepSeekKeyManager,
  createMemoryDeepSeekKeyManager,
} from "./deepseek-key-manager.mjs";
import { buildRelayAdminAuthHeaders, createRelayAdminAuthenticator } from "./relay-admin-auth.mjs";

test("keeps the existing ChatGPT Responses route", () => {
  assert.deepEqual(routeForRequest("/responses?stream=true"), {
    kind: "chatgpt",
    upstreamHost: "chatgpt.com",
    upstreamPath: "/backend-api/codex/responses?stream=true",
  });
});

test("maps authenticated DeepSeek OpenAI and Anthropic routes", () => {
  assert.deepEqual(routeForRequest("/sessions/session_1/deepseek/openai/v1/chat/completions"), {
    kind: "deepseek",
    protocol: "openai",
    sessionId: "session_1",
    upstreamHost: "api.deepseek.com",
    upstreamPath: "/chat/completions",
  });
  assert.deepEqual(routeForRequest("/sessions/session-1/deepseek/anthropic/v1/messages"), {
    kind: "deepseek",
    protocol: "anthropic",
    sessionId: "session-1",
    upstreamHost: "api.deepseek.com",
    upstreamPath: "/anthropic/v1/messages",
  });
});

test("rejects unrecognized paths and unsafe session ids", () => {
  assert.equal(routeForRequest("/sessions/../deepseek/openai/responses"), null);
  assert.equal(routeForRequest("/sessions/session-1/deepseek/openai/embeddings"), null);
  assert.equal(routeForRequest("/sessions/session-1/deepseek/anthropic/v1/files"), null);
});

test("replaces sandbox credentials instead of forwarding them upstream", () => {
  const openai = upstreamHeaders(
    {
      authorization: "Bearer sandbox-token",
      "x-api-key": "sandbox-token",
      "content-type": "application/json",
      "cf-ray": "edge-data",
    },
    {
      upstreamHost: "api.deepseek.com",
      protocol: "openai",
      providerApiKey: "host-only-provider-key",
    }
  );
  assert.equal(openai.authorization, "Bearer host-only-provider-key");
  assert.equal(openai["x-api-key"], undefined);
  assert.equal(openai["cf-ray"], undefined);

  const anthropic = upstreamHeaders(
    { authorization: "Bearer sandbox-token", "anthropic-version": "2023-06-01" },
    {
      upstreamHost: "api.deepseek.com",
      protocol: "anthropic",
      providerApiKey: "host-only-provider-key",
    }
  );
  assert.equal(anthropic.authorization, undefined);
  assert.equal(anthropic["x-api-key"], "host-only-provider-key");
});

test("verifies signed Host administration requests and rejects replay/tampering", () => {
  const secret = "relay-admin-test-secret";
  const now = 1_800_000_000_000;
  const body = Buffer.from('{"apiKey":"redacted"}');
  const headers = buildRelayAdminAuthHeaders({
    secret,
    method: "PUT",
    rawUrl: "/admin/v1/providers/deepseek/key?b=2&a=1",
    body,
    timestampMs: now,
    nonce: "abcdef01",
  });
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  const authenticator = createRelayAdminAuthenticator({ secret, now: () => now });
  assert.deepEqual(
    authenticator.verify({
      method: "PUT",
      rawUrl: "/admin/v1/providers/deepseek/key?a=1&b=2",
      headers: lowerHeaders,
      body,
    }),
    { ok: true }
  );
  assert.equal(
    authenticator.verify({
      method: "PUT",
      rawUrl: "/admin/v1/providers/deepseek/key?a=1&b=2",
      headers: lowerHeaders,
      body,
    }).reason,
    "replay"
  );
  const freshAuthenticator = createRelayAdminAuthenticator({ secret, now: () => now });
  assert.equal(
    freshAuthenticator.verify({
      method: "PUT",
      rawUrl: "/admin/v1/providers/deepseek/key?a=1&b=2",
      headers: lowerHeaders,
      body: Buffer.from('{"apiKey":"tampered"}'),
    }).reason,
    "mismatch"
  );
});

test("atomically rotates a file-backed key with restrictive permissions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-inspect-relay-test-"));
  try {
    const keyPath = path.join(directory, "deepseek-key");
    const manager = createFileBackedDeepSeekKeyManager(keyPath);
    assert.deepEqual(manager.status(), { configured: false, fingerprint: null });
    const first = manager.replace("first-key");
    assert.equal(first.configured, true);
    assert.equal(fs.readFileSync(keyPath, "utf8"), "first-key\n");
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    const second = manager.replace("second-key");
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(manager.get(), "second-key");
    manager.remove();
    assert.equal(fs.existsSync(keyPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("loads the relay administration secret from a protected file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-inspect-relay-auth-"));
  const secretPath = path.join(tempDir, "admin-secret");
  fs.writeFileSync(secretPath, "file-secret\n", { mode: 0o600 });
  try {
    assert.equal(
      resolveAdminAuthSecret({ MODEL_RELAY_ADMIN_AUTH_SECRET_FILE: secretPath }),
      "file-secret"
    );
    assert.equal(
      resolveAdminAuthSecret({
        MODEL_RELAY_ADMIN_AUTH_SECRET: "direct-secret",
        MODEL_RELAY_ADMIN_AUTH_SECRET_FILE: secretPath,
      }),
      "direct-secret"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rotates and tests DeepSeek through the authenticated admin API", async () => {
  const secret = "relay-admin-test-secret";
  const keyManager = createMemoryDeepSeekKeyManager();
  const relay = createRelayServer({
    deepSeekKeyManager: keyManager,
    adminAuthSecret: secret,
    validateProviderKey: async () => ({ ok: true, status: 200 }),
    testProviderKey: async () => ({ ok: true, status: 200 }),
  });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const address = relay.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const body = JSON.stringify({ apiKey: "new-host-key" });
    const pathName = "/admin/v1/providers/deepseek/key";
    const update = await globalThis.fetch(`${baseUrl}${pathName}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...buildRelayAdminAuthHeaders({ secret, method: "PUT", rawUrl: pathName, body }),
      },
      body,
    });
    assert.equal(update.status, 200);
    assert.equal(keyManager.get(), "new-host-key");

    const testPath = "/admin/v1/providers/deepseek/test";
    const tested = await globalThis.fetch(`${baseUrl}${testPath}`, {
      method: "POST",
      headers: buildRelayAdminAuthHeaders({ secret, method: "POST", rawUrl: testPath }),
    });
    assert.equal(tested.status, 200);

    const unauthorized = await globalThis.fetch(`${baseUrl}/admin/v1/status`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await relay.close();
  }
});

test("surfaces a paid-inference failure from the DeepSeek provider test", async () => {
  const secret = "relay-admin-test-secret";
  const relay = createRelayServer({
    deepSeekApiKey: "configured-host-key",
    adminAuthSecret: secret,
    testProviderKey: async () => ({ ok: false, status: 402 }),
  });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const address = relay.server.address();
  const pathName = "/admin/v1/providers/deepseek/test";
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${address.port}${pathName}`, {
      method: "POST",
      headers: buildRelayAdminAuthHeaders({ secret, method: "POST", rawUrl: pathName }),
    });
    assert.equal(response.status, 402);
    assert.match((await response.json()).error.message, /inference failed \(402\)/);
  } finally {
    await relay.close();
  }
});
