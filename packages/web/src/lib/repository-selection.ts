/** Selection key for a repository: the lowercase full name, as the API stores it. */
export function repositorySelectionKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

/** Stable picker value when the catalog has a forge-safe repository key. */
export function repoSelectionValue(repo: { repositoryKey?: string; fullName: string }): string {
  return repo.repositoryKey ? `repo:${repo.repositoryKey}` : repo.fullName.toLowerCase();
}
