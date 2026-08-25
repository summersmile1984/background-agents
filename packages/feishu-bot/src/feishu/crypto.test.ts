import { bytesToHex } from "@open-inspect/shared/auth";
import { describe, expect, it } from "vitest";
import { verifyFeishuPayload } from "./crypto";

const TOKEN = "test-verification-token";
const ENCRYPT_KEY = "test-encrypt-key";

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function encryptPayload(payload: object): Promise<string> {
  const keyBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ENCRYPT_KEY))
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      key,
      new TextEncoder().encode(JSON.stringify(payload))
    )
  );
  const value = new Uint8Array(iv.length + ciphertext.length);
  value.set(iv);
  value.set(ciphertext, iv.length);
  return toBase64(value);
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  );
}

describe("verifyFeishuPayload", () => {
  it("accepts a plaintext challenge with the configured verification token", async () => {
    const result = await verifyFeishuPayload(
      JSON.stringify({ type: "url_verification", token: TOKEN, challenge: "challenge-1" }),
      { timestamp: null, nonce: null, signature: null },
      { verificationToken: TOKEN }
    );

    expect(result).toMatchObject({ ok: true, encrypted: false });
  });

  it("rejects a plaintext request whose token does not match", async () => {
    const result = await verifyFeishuPayload(
      JSON.stringify({ type: "url_verification", token: "wrong", challenge: "challenge-1" }),
      { timestamp: null, nonce: null, signature: null },
      { verificationToken: TOKEN }
    );

    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("verifies the Feishu encrypted envelope before decrypting it", async () => {
    const encrypted = await encryptPayload({
      header: { token: TOKEN, event_type: "im.message.receive_v1" },
      event: { message: { chat_id: "oc_1" } },
    });
    const outer = { encrypt: encrypted };
    const timestamp = "1700000000";
    const nonce = "nonce-1";
    const signature = await sha256Hex(`${timestamp}${nonce}${ENCRYPT_KEY}${JSON.stringify(outer)}`);

    const result = await verifyFeishuPayload(
      JSON.stringify(outer),
      { timestamp, nonce, signature },
      { verificationToken: TOKEN, encryptKey: ENCRYPT_KEY }
    );

    expect(result).toMatchObject({ ok: true, encrypted: true });
  });

  it("rejects an encrypted envelope with a forged signature", async () => {
    const outer = { encrypt: await encryptPayload({ header: { token: TOKEN } }) };
    const result = await verifyFeishuPayload(
      JSON.stringify(outer),
      { timestamp: "1700000000", nonce: "nonce-1", signature: "0".repeat(64) },
      { verificationToken: TOKEN, encryptKey: ENCRYPT_KEY }
    );

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
