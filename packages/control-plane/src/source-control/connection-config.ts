export class SourceControlUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceControlUrlValidationError";
  }
}

export class GiteaSecurityVersionError extends Error {
  constructor(readonly version: string) {
    super(
      `Gitea ${version} is not on the built-in safe release line and has no operator-confirmed security backport`
    );
    this.name = "GiteaSecurityVersionError";
  }
}

/**
 * Enforce the production release gate documented in the multi-connection ADR.
 * Community releases at or after 1.27.1 carry the required upstream fixes.
 * Enterprise builds use a different numbering scheme and are accepted only
 * when an operator has verified vendor backports and listed the exact version.
 */
export function assertGiteaSecurityVersion(
  version: string,
  confirmedVersions: string | undefined
): void {
  const normalized = version.trim();
  const confirmed = new Set(
    (confirmedVersions ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  if (confirmed.has(normalized)) return;

  const community = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(normalized);
  if (community) {
    const major = Number(community[1]);
    const minor = Number(community[2]);
    const patch = Number(community[3]);
    if (major === 1 && (minor > 27 || (minor === 27 && patch >= 1))) return;
  }
  throw new GiteaSecurityVersionError(normalized || "unknown");
}

export interface NormalizeSourceControlUrlOptions {
  /** Local development only. Production callers must keep this false. */
  allowHttpLoopback?: boolean;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Normalize a forge root URL while retaining an optional reverse-proxy path.
 * The result never contains credentials, query data, a fragment, or a trailing
 * slash. It is safe to use as the root for provider-owned URL construction.
 */
export function normalizeSourceControlBaseUrl(
  value: string,
  options: NormalizeSourceControlUrlOptions = {}
): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SourceControlUrlValidationError("Source-control URL is required");
  if (/\p{Cc}/u.test(trimmed)) {
    throw new SourceControlUrlValidationError("Source-control URL contains control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SourceControlUrlValidationError("Source-control URL must be absolute");
  }

  if (parsed.username || parsed.password) {
    throw new SourceControlUrlValidationError("Source-control URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new SourceControlUrlValidationError(
      "Source-control URL must not contain a query string or fragment"
    );
  }
  if (parsed.protocol !== "https:") {
    const allowedLoopback =
      options.allowHttpLoopback === true &&
      parsed.protocol === "http:" &&
      isLoopback(parsed.hostname);
    if (!allowedLoopback) {
      throw new SourceControlUrlValidationError("Source-control URL must use HTTPS");
    }
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
}

export function deriveGiteaConnectionUrls(baseUrl: string): {
  baseUrl: string;
  apiBaseUrl: string;
  cloneBaseUrl: string;
} {
  const normalized = normalizeSourceControlBaseUrl(baseUrl);
  return {
    baseUrl: normalized,
    apiBaseUrl: `${normalized}/api/v1`,
    cloneBaseUrl: normalized,
  };
}

export function assertSameSourceControlOrigin(baseUrl: string, candidateUrl: string): string {
  const normalizedBase = normalizeSourceControlBaseUrl(baseUrl);
  const normalizedCandidate = normalizeSourceControlBaseUrl(candidateUrl);
  if (new URL(normalizedBase).origin !== new URL(normalizedCandidate).origin) {
    throw new SourceControlUrlValidationError(
      "Source-control endpoint must use the connection origin"
    );
  }
  return normalizedCandidate;
}

/**
 * Require a self-hosted forge endpoint to be explicitly trusted by the
 * deployment. Entries are host[:port] values; GITEA_BASE_URL is also treated
 * as an allowlisted bootstrap endpoint. Explicit trust is the DNS-rebinding
 * boundary for connection probes and the Git proxy.
 */
export function assertAllowedSourceControlUrl(
  value: string,
  configuredHosts: string | undefined,
  bootstrapUrl?: string
): string {
  const normalized = normalizeSourceControlBaseUrl(value);
  const target = new URL(normalized);
  const allowed = new Set(
    (configuredHosts ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  if (bootstrapUrl?.trim()) {
    const bootstrap = new URL(normalizeSourceControlBaseUrl(bootstrapUrl));
    allowed.add(bootstrap.host.toLowerCase());
  }
  if (!allowed.has(target.host.toLowerCase())) {
    throw new SourceControlUrlValidationError(
      "Source-control host is not in the deployment allowlist"
    );
  }
  return normalized;
}
