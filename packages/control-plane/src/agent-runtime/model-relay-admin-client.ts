import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import type { HostModelRelayStatus } from "@open-inspect/shared/types/agent-runtime";

const MODEL_RELAY_ADMIN_TIMEOUT_MS = 10_000;

export class ModelRelayAdminError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ModelRelayAdminError";
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("MODEL_RELAY_ADMIN_URL must be an HTTPS URL without userinfo or query data");
  }
  return url.toString().replace(/\/$/, "");
}

function parseStatus(value: unknown): HostModelRelayStatus["deepseek"] | null {
  if (!value || typeof value !== "object" || !("deepseek" in value)) return null;
  const deepseek = value.deepseek;
  if (!deepseek || typeof deepseek !== "object" || !("configured" in deepseek)) return null;
  if (typeof deepseek.configured !== "boolean") return null;
  const fingerprint = "fingerprint" in deepseek ? deepseek.fingerprint : null;
  if (fingerprint !== null && typeof fingerprint !== "string") return null;
  return { configured: deepseek.configured, fingerprint };
}

async function relayErrorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Host model relay rejected the management credential";
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && "error" in value) {
      const error = value.error;
      if (error && typeof error === "object" && "message" in error) {
        const message = error.message;
        if (typeof message === "string" && message.trim()) return message;
      }
    }
  } catch {
    // Fall back to a stable message when the Host returns a malformed error.
  }
  return `Host model relay request failed (${response.status})`;
}

export class ModelRelayAdminClient {
  private readonly baseUrl: string;

  constructor(
    adminUrl: string,
    private readonly authSecret: string
  ) {
    this.baseUrl = normalizeBaseUrl(adminUrl);
    if (!authSecret) throw new Error("MODEL_RELAY_ADMIN_AUTH_SECRET is required");
  }

  async status(): Promise<HostModelRelayStatus> {
    const checkedAt = Date.now();
    try {
      const response = await this.request("GET", "/admin/v1/status");
      const data: unknown = await response.json();
      const deepseek = parseStatus(data);
      if (!deepseek) {
        return {
          connected: false,
          checkedAt,
          relay: "unavailable",
          deepseek: { configured: false, fingerprint: null },
          errorCode: "INVALID_RESPONSE",
        };
      }
      return { connected: true, checkedAt, relay: "online", deepseek };
    } catch (cause) {
      return {
        connected: false,
        checkedAt,
        relay: "unavailable",
        deepseek: { configured: false, fingerprint: null },
        errorCode:
          cause instanceof ModelRelayAdminError && cause.status === 401
            ? "UNAUTHORIZED"
            : "UNAVAILABLE",
      };
    }
  }

  async replaceDeepSeekKey(apiKey: string): Promise<HostModelRelayStatus> {
    const body = JSON.stringify({ apiKey });
    const response = await this.request("PUT", "/admin/v1/providers/deepseek/key", body);
    await response.arrayBuffer();
    return this.requireHealthyStatus();
  }

  async deleteDeepSeekKey(): Promise<HostModelRelayStatus> {
    const response = await this.request("DELETE", "/admin/v1/providers/deepseek/key");
    await response.arrayBuffer();
    return this.requireConnectedStatus();
  }

  async testDeepSeek(): Promise<HostModelRelayStatus> {
    const response = await this.request("POST", "/admin/v1/providers/deepseek/test");
    await response.arrayBuffer();
    return this.requireHealthyStatus();
  }

  private async requireConnectedStatus(): Promise<HostModelRelayStatus> {
    const status = await this.status();
    if (!status.connected) throw new ModelRelayAdminError("Host model relay is unavailable", 502);
    return status;
  }

  private async requireHealthyStatus(): Promise<HostModelRelayStatus> {
    const status = await this.requireConnectedStatus();
    if (!status.deepseek.configured) {
      throw new ModelRelayAdminError("DeepSeek is not configured on the Host", 409);
    }
    return status;
  }

  private async request(method: string, path: string, body?: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const authHeaders = await buildServiceAuthHeaders({
      service: "control-plane",
      secret: this.authSecret,
      method,
      url,
      body,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_RELAY_ADMIN_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        body,
        headers: {
          ...authHeaders,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelRelayAdminError(await relayErrorMessage(response), response.status);
      }
      return response;
    } catch (cause) {
      if (cause instanceof ModelRelayAdminError) throw cause;
      throw new ModelRelayAdminError("Host model relay is unavailable", 502);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function unavailableHostRelayStatus(
  errorCode: HostModelRelayStatus["errorCode"] = "NOT_CONFIGURED"
): HostModelRelayStatus {
  return {
    connected: false,
    checkedAt: Date.now(),
    relay: errorCode === "NOT_CONFIGURED" ? "not-configured" : "unavailable",
    deepseek: { configured: false, fingerprint: null },
    errorCode,
  };
}
