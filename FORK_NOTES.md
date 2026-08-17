# Fork notes

This repository is the `summersmile1984/background-agents` fork of `ColeMurray/background-agents`.
The fork is the writable production source; the upstream repository is treated as read-only.

## Production-specific extensions

- Cloudflare Workers host both the OpenNext web application and the control plane.
- The control plane uses a custom domain so CubeSandbox guests do not depend on `workers.dev`
  reachability.
- A self-hosted Tencent CubeSandbox installation is used through its E2B-compatible API.
- Cube session variables are injected at sandbox creation time with the Cube-compatible `envs`
  request field when `E2B_USE_CREATE_TIME_ENV=true`.
- Xiaomi MiMo is exposed to OpenCode as an OpenAI-compatible provider when `XIAOMI_API_KEY` is
  configured.
- Sandboxes clone and push GitHub repositories through a session-authenticated smart-HTTP proxy in
  the control plane when direct `github.com` access is unavailable.
- The sandbox bridge keeps the upstream WebSocket contract while selecting OpenCode (default),
  Codex, Claude Code, or DeepSeek CodeWhale through provider adapters.
- Repositories may declare isolated PostgreSQL, Redis, and development processes in
  `.openinspect/environment.yaml`; their state remains outside repository checkouts and participates
  in sandbox snapshot coordination.

The compatibility switches default to the upstream behavior unless explicitly enabled. Personal
domains, template IDs, account IDs, API keys, and other deployment values belong in ignored
Terraform variable files or operator-managed secret storage, never in committed source.

## Remote and branch policy

- `origin`: `https://github.com/summersmile1984/background-agents.git` (read/write)
- `upstream`: `https://github.com/ColeMurray/background-agents.git` (fetch-only)
- `main`: production branch in the fork
- Feature work: branch from `origin/main` and merge through a pull request in the fork
- Upstream sync: merge `upstream/main` on a `sync/upstream-YYYYMMDD` branch, run the complete test
  suite, and merge through a pull request into the fork's `main`

Do not force-push the published `main` branch and do not push to `upstream`.

## Local operations

Machine-specific runbooks, browser-registration helpers, migration backups, and secrets are kept
outside this checkout under `/home/turing-agents/Documents/Open-Inspect-Operations/` and
`/home/turing-agents/.config/open-inspect/`.
