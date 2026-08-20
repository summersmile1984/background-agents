import type { SourceControlProviderName } from "@open-inspect/shared/types/source-control";

export interface SourceControlConnectionPresentation {
  provider: SourceControlProviderName;
  displayName: string;
  baseUrl: string;
}

export function sourceControlProviderLabel(provider: SourceControlProviderName): string {
  if (provider === "github") return "GitHub";
  if (provider === "gitea") return "Gitea";
  if (provider === "gitlab") return "GitLab";
  return "Bitbucket";
}

export function sourceControlConnectionLabel(
  connection: SourceControlConnectionPresentation
): string {
  return `${sourceControlProviderLabel(connection.provider)} · ${connection.displayName}`;
}

export function sourceControlHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Cloudflare Quick Tunnels are disposable ingress for local test services. */
export function isEphemeralSourceControlUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}
