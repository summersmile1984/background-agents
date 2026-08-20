/**
 * Source control manager URL utilities.
 *
 * Generates provider-appropriate URLs for repos and branches.
 * The active provider is read from NEXT_PUBLIC_SCM_PROVIDER (build-time env var),
 * defaulting to "github" for upstream compatibility.
 */

type ScmProvider = "github" | "gitea" | "gitlab" | "bitbucket";

const BASE_URLS: Record<ScmProvider, string> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  bitbucket: "https://bitbucket.org",
  gitea: "https://gitea.com",
};

function getProvider(): ScmProvider {
  const val = process.env.NEXT_PUBLIC_SCM_PROVIDER?.toLowerCase().trim();
  if (val === "github" || val === "gitea" || val === "gitlab" || val === "bitbucket") return val;
  return "github";
}

function encodeOwner(provider: ScmProvider, owner: string): string {
  return provider === "gitlab"
    ? owner.split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(owner);
}

export function getScmRepoUrl(owner: string, name: string): string {
  const provider = getProvider();
  return `${BASE_URLS[provider]}/${encodeOwner(provider, owner)}/${encodeURIComponent(name)}`;
}

export function getScmBranchUrl(owner: string, name: string, branch: string): string {
  const provider = getProvider();
  const encodedOwner = encodeOwner(provider, owner);
  const encodedName = encodeURIComponent(name);
  const encodedBranch = encodeURIComponent(branch);
  if (provider === "gitlab") {
    return `${BASE_URLS[provider]}/${encodedOwner}/${encodedName}/-/tree/${encodedBranch}`;
  }
  if (provider === "bitbucket") {
    return `${BASE_URLS[provider]}/${encodedOwner}/${encodedName}/src/${encodedBranch}`;
  }
  // github (default)
  return `${BASE_URLS[provider]}/${encodedOwner}/${encodedName}/tree/${encodedBranch}`;
}

export function getRepositoryBranchUrl(
  repository: { webUrl?: string; provider?: string },
  branch: string
): string | null {
  if (!repository.webUrl) return null;
  const base = repository.webUrl.replace(/\/+$/, "");
  const encodedBranch = encodeURIComponent(branch);
  if (repository.provider === "gitlab") return `${base}/-/tree/${encodedBranch}`;
  if (repository.provider === "bitbucket") return `${base}/src/${encodedBranch}`;
  if (repository.provider === "gitea") return `${base}/src/branch/${encodedBranch}`;
  return `${base}/tree/${encodedBranch}`;
}
