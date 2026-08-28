"""Resolve VCS clone tokens for Modal sandbox git operations."""

import os

from .log_config import get_logger

log = get_logger("clone_token")


def resolve_clone_token() -> str | None:
    """Return a legacy direct-clone token for providers that explicitly allow it.

    Gitea credentials are intentionally not resolved here. Production Gitea
    sessions use the control-plane Git proxy and a short-lived capability;
    falling through to the deployment's GitHub App would otherwise inject a
    token for the wrong forge into a restored sandbox.
    """
    scm_provider = os.environ.get("SCM_PROVIDER", "github")

    if scm_provider == "gitlab":
        token = os.environ.get("GITLAB_ACCESS_TOKEN")
        if not token:
            log.warn("gitlab.token_missing")
        return token

    if scm_provider == "gitea":
        log.warn("gitea.proxy_required")
        return None

    if scm_provider != "github":
        log.warn("scm.provider_unsupported", provider=scm_provider)
        return None

    from sandbox_runtime.auth import generate_installation_token

    try:
        app_id = os.environ.get("GITHUB_APP_ID")
        private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
        installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

        if app_id and private_key and installation_id:
            return generate_installation_token(
                app_id=app_id,
                private_key=private_key,
                installation_id=installation_id,
            )
    except Exception as e:
        log.warn("github.token_error", exc=e)

    return None
