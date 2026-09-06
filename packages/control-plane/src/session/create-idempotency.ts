import type { CreateSessionInput } from "@open-inspect/shared/types/session-api";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildSessionCreateIdempotency(input: {
  service: string;
  participantUserId: string;
  body: CreateSessionInput;
}): Promise<{ callerKey: string; clientRequestId: string; requestFingerprint: string } | null> {
  const clientRequestId = input.body.clientRequestId;
  if (!clientRequestId) return null;
  const requestBody = { ...input.body, clientRequestId: undefined };
  const [callerKey, requestFingerprint] = await Promise.all([
    sha256(`${input.service}\0${input.participantUserId}`),
    sha256(JSON.stringify(stableValue(requestBody))),
  ]);
  return { callerKey, clientRequestId, requestFingerprint };
}
