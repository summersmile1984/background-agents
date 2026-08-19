import assert from "node:assert/strict";
import test from "node:test";
import { routeForRequest, upstreamHeaders } from "./codex-relay.mjs";

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
