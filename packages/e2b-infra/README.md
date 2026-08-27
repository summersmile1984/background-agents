# Open-Inspect E2B Template Tooling

Builds the E2B sandbox **template** that Open-Inspect E2B sandboxes are created from.

The control plane talks to the E2B REST API directly at runtime — these files are only for building
the template image, not runtime operations.

## What's here

- **`e2b.Dockerfile`** — the template image: the pinned sandbox toolchain (Python 3.12, Node 22,
  `opencode-ai`, `code-server`, `agent-browser`, bun) plus `packages/sandbox-runtime` copied to
  `/app/sandbox_runtime`. **Toolchain versions are pinned — keep them in sync with the other sandbox
  providers when bumping.**
- **`oi-launch.py`** — the template **start command**. E2B runs the start command once at build,
  snapshots it, and resumes it per create — so it cannot receive per-session env. This launcher
  waits for the control plane to drop `/tmp/oi-session.env` (via envd), loads it, and `exec`s the
  supervisor (`python -m sandbox_runtime.entrypoint`) with that env +
  `HOME=/home/user`/`PYTHONPATH`/`NODE_PATH`.
- **`build-template.py`** — stages `sandbox_runtime`, then builds the template programmatically via
  the **E2B Template SDK** (`Template().from_dockerfile(...).copy(...).set_start_cmd(...)`),
  authenticated with the runtime API key. Used both for manual builds and by the Terraform module.

## Auth: one credential

- **`E2B_API_KEY`** — the runtime key the control-plane worker uses for the E2B REST API (and
  code-server password HMAC), **and** what the Template SDK uses to authenticate the build. Get it
  from the [E2B dashboard](https://e2b.dev) → API Keys.

## Manual build

```bash
cd packages/e2b-infra
uv sync --frozen
export E2B_API_KEY=e2b_…            # from the E2B dashboard → API Keys
export E2B_TEMPLATE_ID=open-inspect-sandbox
uv run python build-template.py
```

Optional: `E2B_TEMPLATE_CPU` (default 2), `E2B_TEMPLATE_MEM` (default 1024).

Rebuild whenever `packages/sandbox-runtime` or this directory changes.

> Builds are automated via Terraform when `sandbox_provider = "e2b"`. The
> `terraform/modules/e2b-infra` module hashes `packages/e2b-infra` + `packages/sandbox-runtime/src`
> and rebuilds the template on `terraform apply` when either changes. Manual runs are only for
> initial setup or debugging.
>
> E2B runs sandboxes as non-root `user` (HOME=`/home/user`) via a login shell and does not propagate
> Docker `ENV` — the Dockerfile and launcher account for this.

## Verification

Unit/integration tests and the template build are covered by CI; the bridge ↔ control-plane
WebSocket path can only be exercised against a running control plane.

Prerequisites: `packages/control-plane/.dev.vars` with `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY`,
`E2B_TEMPLATE_ID`, and GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` in PKCS#8,
`GITHUB_APP_INSTALLATION_ID`); the template built (`uv run python build-template.py`); a test repo
the App can clone.

1. Expose a public control-plane URL the sandbox bridge can reach: `wrangler dev --remote`, or
   `wrangler dev` + `cloudflared tunnel --url http://localhost:8787`.
2. Set `CONTROL_PLANE_URL` to that public URL.
3. Start a session against the test repo.

| Criterion                   | Test method                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| Fresh session works         | Bridge connects; agent responds to a prompt                                     |
| Pause → resume works        | Agent responds to a new prompt after resume; files from before the pause remain |
| Idle pauses (not kills)     | Idle timeout triggers `POST /sandboxes/{id}/pause`; session is resumable        |
| TTL lapse recovers          | Past the TTL the sandbox auto-pauses (not killed); the next prompt resumes it   |
| code-server survives resume | Same URL and password work after resume                                         |
| Stop pauses (resumable)     | Idle/heartbeat stop pauses; only a never-connected sandbox is killed (`DELETE`) |

## Self-hosted CubeSandbox

The fork also carries an additive CubeSandbox build path. It uses Cube's `sandbox-code` base image
so the E2B-compatible envd and code-interpreter services remain available, while installing the same
pinned harnesses and development services as the managed E2B image. The Cube image additionally
extracts the browser-only slice from the pinned ByteDance Agent Infra AIO Sandbox image: Chromium
and the official `@agent-infra/mcp-server-browser`. It deliberately does not copy AIO's duplicate
Jupyter, code-server, terminal, Node, or Python stacks.

At runtime the browser processes remain inside the Cube VM. Chromium CDP listens only on
`127.0.0.1:9222`, and the AIO Browser MCP endpoint listens only on `127.0.0.1:8100/mcp`. The sandbox
supervisor starts, monitors, and restarts both alongside the existing Xvfb/noVNC desktop. OpenCode,
Codex, Claude Code, and DeepSeek CodeWhale receive the loopback MCP endpoint automatically as
`aio_browser`; no AIO port or API key is exposed to the public internet. Platform visual
verification and media upload remain the authoritative path for returning screenshots to Web and bot
clients. `agent-browser` auto-connects to this managed Chromium instance, so canonical visual
verification does not launch a second browser process tree.

```bash
cd packages/e2b-infra
CUBE_IMAGE=localhost:5000/oi-e2b:latest \
  CUBE_TEMPLATE_ALIAS=oi-e2b-multi-harness \
  CUBE_TEMPLATE_CPU_MILLICORES=4000 \
  CUBE_TEMPLATE_MEMORY_MB=8192 \
  bash build-cube-template.sh
```

Set `CUBE_IMAGE_BUILD_LABEL` to a unique value when Cube must rebuild the image artifact instead of
reusing one cached for the same image digest. This is useful when recovering from a corrupted
artifact; the label changes only the image metadata and does not alter the sandbox runtime.

The command builds from a temporary context containing only this package and `sandbox-runtime`,
pushes the image, and registers a new Cube template. Point `e2b_template_id` at the returned
template only after it reaches `READY`.

New Cube templates default to 4 vCPU and 8192 MB of memory. Override `CUBE_TEMPLATE_CPU_MILLICORES`
and `CUBE_TEMPLATE_MEMORY_MB` when the host capacity or workload requires another size. Resource
changes apply only to sandboxes created from the new template; existing sandboxes keep their
original limits.

`build-cube-template.sh` sets the sandbox DNS server to `223.5.5.5` by default. Cube's AF_XDP
network path does not make a resolver bound to a host-local address reachable from the sandbox.
Override the resolver with `CUBE_DNS_SERVER` when the Cube network provides another
sandbox-reachable DNS service.

After creating a test session from a new template, verify both private browser endpoints inside the
sandbox: `/json/version` on port 9222 must include `webSocketDebuggerUrl`, and the Browser MCP
process must listen on loopback port 8100. Then run `oi-visual-verify` against a repository dev
service and confirm that its uploaded screenshot appears in the same Web session before promoting
the template to production.

## Host model relay for Cube

In networks where a Cube sandbox cannot connect directly to the Codex model endpoint, the Codex
app-server can use an HTTPS relay by adding a global Open-Inspect secret named
`CODEX_OPENAI_BASE_URL`. The value is passed to Codex as its `openai_base_url` configuration and is
excluded from the commands Codex runs inside the workspace.

`codex-relay.mjs` is the restricted host-side relay used by the self-hosted Cube deployment. It
keeps the existing ChatGPT subscription path and also exposes session-scoped DeepSeek OpenAI
Responses, Chat Completions, and Anthropic Messages paths. For DeepSeek, the sandbox sends its
existing `SANDBOX_AUTH_TOKEN`; the relay verifies that token with the control plane before replacing
it with the provider key read from `DEEPSEEK_API_KEY_FILE`. The provider key never enters a sandbox,
repository image, snapshot, or Cloudflare storage.

The relay binds to `127.0.0.1` by default. Publish it through a controlled HTTPS ingress and set
`model_relay_public_url` to that public URL. Publish `/admin/v1/*` through a separate restricted
hostname or route and set `model_relay_admin_url` to it. Set `MODEL_RELAY_CONTROL_PLANE_URL` to the
public control-plane HTTPS URL. Generate one long random value for `MODEL_RELAY_ADMIN_AUTH_SECRET`
and configure the same value as the sensitive Terraform `model_relay_admin_auth_secret`. For a Host
service, prefer writing it to a `0600` file and setting `MODEL_RELAY_ADMIN_AUTH_SECRET_FILE`; a
direct environment value remains supported. This bootstrap secret is intentionally not editable in
the web app. The example systemd service shows the non-secret file paths and URL setting; keep both
files outside the repository with mode `0600`, and replace the absolute `ExecStart` path before
installing the unit.

The control plane signs every Host management request, and the relay binds the signature to the
method, path, query, and body while enforcing timestamp and nonce replay limits. In **Settings >
Harnesses**, a deployment administrator can validate and atomically rotate the DeepSeek key, test
the provider connection, or remove the key. Candidate keys are checked before activation; a failed
check does not replace the current key.

The relay is a **host service**, not a sandbox service. Each session sandbox still runs its own
`sandbox_runtime`, Python WebSocket bridge, and selected harness. Cloudflare remains the control
plane and tunnel ingress; it does not run OpenCode, Codex, Claude Code, or CodeWhale.
