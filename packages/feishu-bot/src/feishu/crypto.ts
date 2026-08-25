import { bytesToHex, timingSafeEqual } from "@open-inspect/shared/auth";

export interface FeishuRequestHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

export interface FeishuSecurityConfig {
  verificationToken: string;
  encryptKey?: string;
}

export type VerifiedFeishuPayload =
  | { ok: true; payload: Record<string, unknown>; encrypted: boolean }
  | {
      ok: false;
      reason:
        | "invalid_json"
        | "invalid_payload"
        | "invalid_signature"
        | "invalid_token"
        | "decrypt_failed"
        | "missing_encrypt_key";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

/**
 * Feishu encrypted event payloads use AES-256-CBC.  The first 16 bytes of the
 * base64-decoded payload are the IV and the SHA-256 of the Encrypt Key is the
 * AES key, matching the maintained Feishu SDK implementation.
 */
export async function decryptFeishuPayload(encrypted: string, encryptKey: string): Promise<string> {
  const bytes = decodeBase64(encrypted);
  if (bytes.byteLength <= 16) throw new Error("Encrypted payload is too short");
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256Bytes(encryptKey),
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: bytes.slice(0, 16) },
    key,
    bytes.slice(16)
  );
  return new TextDecoder().decode(plaintext);
}

function tokenFromPayload(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.token === "string") return payload.token;
  const header = payload.header;
  return isRecord(header) && typeof header.token === "string" ? header.token : undefined;
}

/**
 * Validate and, when configured, decrypt a Feishu event/card request.  The
 * signature is verified before decryption when Feishu supplied its signed
 * headers; a plaintext event must still carry the configured verification
 * token.  This rejects permissive SDK defaults that accept unsigned traffic
 * when an Encrypt Key is absent.
 */
export async function verifyFeishuPayload(
  rawBody: string,
  headers: FeishuRequestHeaders,
  config: FeishuSecurityConfig
): Promise<VerifiedFeishuPayload> {
  let outer: unknown;
  try {
    outer = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(outer)) return { ok: false, reason: "invalid_payload" };

  const encryptValue = outer.encrypt;
  const encrypted = typeof encryptValue === "string";
  if (encrypted) {
    if (!config.encryptKey) return { ok: false, reason: "missing_encrypt_key" };
    if (!headers.timestamp || !headers.nonce || !headers.signature) {
      return { ok: false, reason: "invalid_signature" };
    }
    const expectedSignature = await sha256Hex(
      `${headers.timestamp}${headers.nonce}${config.encryptKey}${JSON.stringify(outer)}`
    );
    if (!timingSafeEqual(headers.signature, expectedSignature)) {
      return { ok: false, reason: "invalid_signature" };
    }
    try {
      const decrypted = JSON.parse(await decryptFeishuPayload(encryptValue, config.encryptKey));
      if (!isRecord(decrypted)) return { ok: false, reason: "invalid_payload" };
      const payload = { ...outer, ...decrypted };
      if (!timingSafeEqual(tokenFromPayload(payload) ?? "", config.verificationToken)) {
        return { ok: false, reason: "invalid_token" };
      }
      return { ok: true, payload, encrypted: true };
    } catch {
      return { ok: false, reason: "decrypt_failed" };
    }
  }

  if (!timingSafeEqual(tokenFromPayload(outer) ?? "", config.verificationToken)) {
    return { ok: false, reason: "invalid_token" };
  }
  return { ok: true, payload: outer, encrypted: false };
}
