"""SCM credential environment shared by interactive and build sandboxes."""

import os


def inject_vcs_env_vars(
    env_vars: dict[str, str],
    clone_token: str | None,
    *,
    clone_host: str | None = None,
    clone_username: str | None = None,
    clone_base_url: str | None = None,
    include_github_cli_aliases: bool = False,
) -> None:
    """Inject provider metadata and optional one-shot clone credentials."""
    scm_provider = os.environ.get("SCM_PROVIDER", "github")
    if clone_host and clone_username:
        env_vars["VCS_HOST"] = clone_host
        env_vars["VCS_CLONE_USERNAME"] = clone_username
    elif scm_provider == "bitbucket":
        env_vars["VCS_HOST"] = "bitbucket.org"
        env_vars["VCS_CLONE_USERNAME"] = "x-token-auth"
    elif scm_provider == "gitlab":
        env_vars["VCS_HOST"] = "gitlab.com"
        env_vars["VCS_CLONE_USERNAME"] = "oauth2"
    else:
        env_vars["VCS_HOST"] = "github.com"
        env_vars["VCS_CLONE_USERNAME"] = "x-access-token"

    # A clone base URL is the server-side SCM proxy contract.  In this mode
    # the sandbox authenticates with the short-lived capability injected by
    # the caller; never forward a legacy/provider token alongside it.
    if not clone_token or clone_base_url:
        if clone_base_url:
            env_vars["VCS_CLONE_BASE_URL"] = clone_base_url.rstrip("/")
            env_vars["OI_SCM_PROXY_MODE"] = "1"
        return

    env_vars["VCS_CLONE_TOKEN"] = clone_token
    if clone_base_url:
        env_vars["VCS_CLONE_BASE_URL"] = clone_base_url.rstrip("/")
        env_vars["OI_SCM_PROXY_MODE"] = "1"
    if include_github_cli_aliases and scm_provider == "github":
        has_user_github_cli_token = any(
            env_vars.get(key) for key in ("GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN")
        )
        if not has_user_github_cli_token:
            env_vars["GITHUB_TOKEN"] = clone_token
            env_vars["GITHUB_APP_TOKEN"] = clone_token
            env_vars["OI_GITHUB_TOKEN_IS_FALLBACK"] = "1"
