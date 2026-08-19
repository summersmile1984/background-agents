import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";

const SERVICE_HEADER = "x-openinspect-service";
const SIGNATURE_HEADER = "x-openinspect-service-signature";
const ACTOR_HEADER = "x-openinspect-actor";
const SERVICE = "control-plane";
const SIGNATURE_PREFIX = "sig1";
const NONCE_PATTERN = /^[0-9a-f]{1,64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,16}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_VALIDITY_MS = 5 * 60 * 1000;

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function canonicalizeAdminQuery(search) {
  const entries = Array.from(new URLSearchParams(search).entries());
  entries.sort((a, b) => compareUtf8(`${a[0]}\0${a[1]}`, `${b[0]}\0${b[1]}`));
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function canonicalRequest({ timestampMs, nonce, method, rawUrl, bodySha256Hex }) {
  const url = new URL(rawUrl, "https://relay.invalid");
  return (
    `${SIGNATURE_PREFIX}\n${SERVICE}\n${timestampMs}\n${nonce}\n${method.toUpperCase()}\n` +
    `${url.pathname}\n${canonicalizeAdminQuery(url.search)}\n${bodySha256Hex}\n`
  );
}

function bodyHash(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function signatureFor({ secret, timestampMs, nonce, method, rawUrl, body }) {
  return crypto
    .createHmac("sha256", secret)
    .update(
      canonicalRequest({
        timestampMs,
        nonce,
        method,
        rawUrl,
        bodySha256Hex: bodyHash(body),
      })
    )
    .digest("hex");
}

/** Test/operations helper matching @open-inspect/shared's sig1 wire format. */
export function buildRelayAdminAuthHeaders({
  secret,
  method,
  rawUrl,
  body = Buffer.alloc(0),
  timestampMs = Date.now(),
  nonce = crypto.randomBytes(8).toString("hex"),
}) {
  const signature = signatureFor({ secret, timestampMs, nonce, method, rawUrl, body });
  return {
    "X-OpenInspect-Service": SERVICE,
    "X-OpenInspect-Service-Signature": `${SIGNATURE_PREFIX}.${timestampMs}.${nonce}.${signature}`,
  };
}

export function createRelayAdminAuthenticator({
  secret,
  now = () => Date.now(),
  validityMs = DEFAULT_VALIDITY_MS,
} = {}) {
  const usedNonces = new Map();

  return {
    verify({ method, rawUrl, headers, body = Buffer.alloc(0) }) {
      if (!secret || headers[SERVICE_HEADER] !== SERVICE || headers[ACTOR_HEADER]) {
        return { ok: false, reason: "identity" };
      }
      const parts = String(headers[SIGNATURE_HEADER] || "").split(".");
      if (
        parts.length !== 4 ||
        parts[0] !== SIGNATURE_PREFIX ||
        !TIMESTAMP_PATTERN.test(parts[1]) ||
        !NONCE_PATTERN.test(parts[2]) ||
        !SIGNATURE_PATTERN.test(parts[3])
      ) {
        return { ok: false, reason: "format" };
      }
      const timestampMs = Number(parts[1]);
      const nonce = parts[2];
      const currentTime = now();
      if (Math.abs(currentTime - timestampMs) > validityMs) {
        return { ok: false, reason: "expired" };
      }
      const expected = signatureFor({ secret, timestampMs, nonce, method, rawUrl, body });
      const expectedBytes = Buffer.from(expected, "hex");
      const actualBytes = Buffer.from(parts[3], "hex");
      if (
        expectedBytes.length !== actualBytes.length ||
        !crypto.timingSafeEqual(expectedBytes, actualBytes)
      ) {
        return { ok: false, reason: "mismatch" };
      }

      for (const [usedNonce, usedAt] of usedNonces) {
        if (currentTime - usedAt > validityMs) usedNonces.delete(usedNonce);
      }
      if (usedNonces.has(nonce)) return { ok: false, reason: "replay" };
      usedNonces.set(nonce, timestampMs);
      return { ok: true };
    },
  };
}
