import {
  harnessCredentialKindSchema,
  type HarnessCredentialKind,
  type HarnessCredentialMetadata,
} from "@open-inspect/shared/types/agent-runtime";
import { GlobalSecretsStore } from "./global-secrets";
import { validateValue } from "./secrets-validation";
import type { SqlDatabase } from "./sql-database";

interface CredentialDescriptor {
  key: string;
  expiryKey?: string;
  conflictsWith?: HarnessCredentialKind;
}

const CREDENTIALS: Record<HarnessCredentialKind, CredentialDescriptor> = {
  "codex-auth-json": {
    key: "CODEX_AUTH_JSON",
    expiryKey: "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    conflictsWith: "codex-access-token",
  },
  "codex-access-token": {
    key: "CODEX_ACCESS_TOKEN",
    expiryKey: "CODEX_ACCESS_TOKEN_EXPIRES_AT",
    conflictsWith: "codex-auth-json",
  },
  "claude-setup-token": {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    expiryKey: "CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT",
  },
};

export class HarnessCredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessCredentialValidationError";
  }
}

function parseExpiry(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  let date: Date;
  if (/^[0-9]+$/.test(trimmed)) {
    let timestamp = Number(trimmed);
    if (!Number.isSafeInteger(timestamp))
      throw new HarnessCredentialValidationError("Invalid expiry");
    if (timestamp < 10_000_000_000) timestamp *= 1000;
    date = new Date(timestamp);
  } else {
    date = new Date(trimmed);
  }
  if (Number.isNaN(date.getTime())) throw new HarnessCredentialValidationError("Invalid expiry");
  return date.toISOString();
}

function decodeCodexAuth(value: string): Record<string, unknown> | null {
  const candidates = [value];
  try {
    candidates.push(atob(value));
  } catch {
    // Plain JSON is the primary form.
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next representation.
    }
  }
  return null;
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${prefix}`;
}

export class HarnessCredentialStore {
  private readonly secrets: GlobalSecretsStore;

  constructor(db: SqlDatabase, encryptionKey: string) {
    this.secrets = new GlobalSecretsStore(db, encryptionKey);
  }

  async listMetadata(): Promise<HarnessCredentialMetadata[]> {
    const [metadata, values] = await Promise.all([
      this.secrets.listSecretKeys(),
      this.secrets.getDecryptedSecrets(),
    ]);
    const updatedAt = new Map(metadata.map((entry) => [entry.key, entry.updatedAt]));
    return Promise.all(
      harnessCredentialKindSchema.options.map(async (kind) => {
        const descriptor = CREDENTIALS[kind];
        const value = values[descriptor.key]?.trim() ?? "";
        let expiresAt: string | null = null;
        try {
          expiresAt = parseExpiry(descriptor.expiryKey ? values[descriptor.expiryKey] : undefined);
        } catch {
          // Invalid legacy metadata must not make the settings page unavailable.
        }
        return {
          kind,
          configured: Boolean(value),
          updatedAt: updatedAt.get(descriptor.key) ?? null,
          expiresAt,
          fingerprint: value ? await fingerprint(value) : null,
        };
      })
    );
  }

  async set(
    kind: HarnessCredentialKind,
    value: string,
    expiresAt?: string | null
  ): Promise<HarnessCredentialMetadata> {
    const descriptor = CREDENTIALS[kind];
    const trimmed = value.trim();
    if (!trimmed) throw new HarnessCredentialValidationError("Credential value is required");
    validateValue(trimmed);
    let normalizedValue = trimmed;
    if (kind === "codex-auth-json") {
      const decoded = decodeCodexAuth(trimmed);
      if (!decoded) {
        throw new HarnessCredentialValidationError(
          "Codex auth must be a JSON object or its base64 encoding"
        );
      }
      // E2B rejects environment values containing control characters. Auth files
      // loaded from disk are commonly pretty-printed, so store a compact JSON
      // representation regardless of whether the user pasted JSON or base64.
      normalizedValue = JSON.stringify(decoded);
    }
    const normalizedExpiry = parseExpiry(expiresAt ?? undefined);
    const write: Record<string, string> = { [descriptor.key]: normalizedValue };
    if (descriptor.expiryKey && normalizedExpiry) write[descriptor.expiryKey] = normalizedExpiry;
    await this.secrets.setSecrets(write);

    if (descriptor.expiryKey && !normalizedExpiry) {
      await this.secrets.deleteSecret(descriptor.expiryKey);
    }
    if (descriptor.conflictsWith) {
      await this.secrets.deleteSecret(CREDENTIALS[descriptor.conflictsWith].key);
    }
    const metadata = await this.listMetadata();
    return metadata.find((entry) => entry.kind === kind)!;
  }

  async delete(kind: HarnessCredentialKind): Promise<boolean> {
    const descriptor = CREDENTIALS[kind];
    const deleted = await this.secrets.deleteSecret(descriptor.key);
    if (descriptor.expiryKey) {
      const siblingUsesExpiry = harnessCredentialKindSchema.options.some(
        (candidate) =>
          candidate !== kind &&
          CREDENTIALS[candidate].expiryKey === descriptor.expiryKey &&
          CREDENTIALS[candidate].key !== descriptor.key
      );
      if (!siblingUsesExpiry || !(await this.isConfiguredSibling(kind))) {
        await this.secrets.deleteSecret(descriptor.expiryKey);
      }
    }
    return deleted;
  }

  private async isConfiguredSibling(kind: HarnessCredentialKind): Promise<boolean> {
    const descriptor = CREDENTIALS[kind];
    if (!descriptor.expiryKey) return false;
    const metadata = await this.listMetadata();
    return metadata.some(
      (entry) =>
        entry.kind !== kind &&
        CREDENTIALS[entry.kind].expiryKey === descriptor.expiryKey &&
        entry.configured
    );
  }
}
