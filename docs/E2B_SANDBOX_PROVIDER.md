# E2B Sandbox Provider

Open-Inspect's `e2b` provider targets the E2B REST contract. It can use managed
[E2B](https://e2b.dev) or a compatible self-hosted backend such as Tencent CubeSandbox. The control
plane talks to the configured API directly from Cloudflare Workers; the session WebSocket and
harness protocol do not change when the backend changes.

## When to Use It

Use `sandbox_provider = "e2b"` for either of these deployment shapes:

| Shape            | API and template path                                                           | Session environment delivery                     |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Managed E2B      | `api.e2b.app`; Terraform or the E2B Template SDK builds `e2b.Dockerfile`        | Secure envd file upload after create             |
| Self-hosted Cube | Cube's E2B-compatible API; `build-cube-template.sh` registers `cube.Dockerfile` | Create-time `envs`; Cube starts a fresh launcher |

Both shapes keep the same control plane, Web/bot clients, source-control connections, selected
harness, and session event stream. Managed E2B pause/resume behavior is described below. Cube's
exact lifecycle depends on its compatibility API and deployment policy but remains controlled by the
shared sandbox lifecycle manager.

## Required Configuration

Set these values in `terraform/environments/production/terraform.tfvars`:

```hcl
sandbox_provider = "e2b"

e2b_api_key     = "e2b_..."             # from the E2B dashboard → API Keys
e2b_template_id = "open-inspect-sandbox" # template name to build/use

# Optional
# e2b_api_url                 = "https://api.e2b.app" # REST API base URL
# e2b_sandbox_timeout_seconds = 7200                  # sandbox TTL (default 2h)
# e2b_preview_base_url = "https://preview.example.com" # optional trusted public preview gateway
# e2b_auto_pause              = true                   # pause (recoverable), not kill, on TTL lapse
# e2b_build_template          = true                   # false for a prebuilt self-hosted template
# e2b_use_create_time_env     = false                  # true for CubeSandbox
```

For GitHub Actions-based deployment, configure the matching repository secrets:

```text
SANDBOX_PROVIDER=e2b
E2B_API_KEY
E2B_TEMPLATE_ID
E2B_API_URL                 # optional
E2B_SANDBOX_TIMEOUT_SECONDS # optional
E2B_AUTO_PAUSE              # optional
E2B_PREVIEW_BASE_URL        # optional trusted HTTPS preview gateway
E2B_BUILD_TEMPLATE          # false for a prebuilt self-hosted template
E2B_USE_CREATE_TIME_ENV     # true for CubeSandbox
```

The provider also needs the normal Open-Inspect Cloudflare, authentication, source-control, harness,
model, and web configuration. See [GETTING_STARTED.md](./GETTING_STARTED.md) for the full deployment
flow.

> On the **Hobby** tier (~1h runtime cap), lower `e2b_sandbox_timeout_seconds` to `3300`.

## Template Build

E2B sandboxes boot from a **template** image that contains:

- the Open-Inspect sandbox runtime (`packages/sandbox-runtime`, staged into `/app`)
- OpenCode plus native Codex, Claude Code, and DeepSeek CodeWhale runtimes
- Python 3.12 and Node 22 runtimes
- `code-server`, `agent-browser`, browser/terminal tooling, PostgreSQL, and Redis
- GitHub CLI and a Git credential helper

Managed E2B templates are built programmatically with the E2B Template SDK and support the two paths
below. Self-hosted Cube uses the separate image-and-registration path described afterward.

### Terraform-Managed Template

This is the recommended path for a normal deployment. When `sandbox_provider = "e2b"`, the
`terraform/modules/e2b-infra` module hashes the relevant template and runtime source files under
`packages/e2b-infra` and `packages/sandbox-runtime/src`, and rebuilds the template on
`terraform apply` when they change.

```bash
cd terraform/environments/production
terraform init
terraform apply
```

### Manual Template

Use this path to build or test a template before wiring it into Terraform:

```bash
cd packages/e2b-infra
uv sync --frozen
export E2B_API_KEY=e2b_…
export E2B_TEMPLATE_ID=open-inspect-sandbox
uv run python build-template.py
```

Optional build knobs: `E2B_TEMPLATE_CPU` (default `2`), `E2B_TEMPLATE_MEM` MB (default `1024`) —
these apply to **manual** builds. Terraform-managed production templates use `e2b_template_cpu` and
`e2b_template_memory_mb`, which default to **4 vCPU / 8192 MB**. See
[`packages/e2b-infra/README.md`](../packages/e2b-infra/README.md) for details on the template
tooling and the launcher.

### Self-Hosted Cube Template

Cube uses a separate image and registration path:

```bash
cd packages/e2b-infra
CUBE_IMAGE_BUILD_LABEL=release-<unique> bash build-cube-template.sh
```

The script builds `cube.Dockerfile`, pushes the image, and registers a new immutable Cube template.
The production defaults are 4 vCPU and 8192 MB; override them with `CUBE_TEMPLATE_CPU_MILLICORES`
and `CUBE_TEMPLATE_MEMORY_MB`. Set the returned template ID as `e2b_template_id`, keep
`e2b_build_template = false`, and set `e2b_use_create_time_env = true`.

Cube's `sandbox-code` image remains the VM/envd/code-interpreter base. A multi-stage build copies
only Chromium and `@agent-infra/mcp-server-browser` from the pinned ByteDance Agent Infra AIO
Sandbox image. The supervisor exposes them only inside the VM at `127.0.0.1:9222` (CDP) and
`127.0.0.1:8100/mcp` (Browser MCP). See [ADR 0005](./adr/0005-cube-aio-browser-runtime.md).

## Runtime Behavior

The provider creates fresh sandboxes from the configured template. Managed E2B runs the template's
start command once at build and does not pass the later session environment to that process. The
launcher (`oi-launch`) works around this:

1. waits for the control plane to drop the per-session env file (`/tmp/oi-session.env`) over envd
2. `exec`s the supervisor (`python -m sandbox_runtime.entrypoint`) with that env
3. the supervisor clones or syncs the selected repositories, starts the selected agent harness and
   code-server, and connects the Open-Inspect bridge back to the control plane
4. agent events stream back through the control plane

Cube instead passes the session values as `envs` in `POST /sandboxes`; `cube-entry` and `oi-launch`
start the supervisor from that create-time environment. The control plane deliberately skips its
secure envd upload path in this mode because Cube does not return an E2B envd access token. The
session still receives a fresh `SANDBOX_AUTH_TOKEN` and the same normalized launch specification.

### Runtime-Owned Browser on Cube

When `AIO_BROWSER_ENABLED=1`, browser startup is part of supervisor readiness:

1. start Xvfb and Fluxbox at the fixed 1280×720 display;
2. start one Chromium process tree as the sandbox user and wait for CDP;
3. start Browser MCP against that CDP endpoint and wait for port `8100`;
4. reserve `aio_browser` in OpenCode, Codex, Claude, and DeepSeek MCP configuration;
5. let `agent-browser` reuse the same Chromium through automatic CDP connection.

CDP and MCP never cross the sandbox boundary. Screenshots cross it only through the `upload_media`
tool, which uses the session capability and stores the validated object in the control plane's media
storage.

## Managed E2B Lifecycle: Pause and Resume

Managed E2B's sandbox timeout is **not extended by in-sandbox agent activity** (Open-Inspect only
resets it when it resumes a sandbox), and E2B has no server-side idle-stop or auto-delete.
Open-Inspect therefore drives the lifecycle through the shared lifecycle manager, treating E2B stops
as a **resumable pause**:

- Idle sessions are **paused** after the shared inactivity timeout (default 10 minutes).
- When the TTL lapses, the sandbox created with `E2B_AUTO_PAUSE=true` **auto-pauses** (recoverable)
  rather than being killed.
- The next prompt **resumes** the paused sandbox in place (workspace state preserved); if E2B has
  since dropped it, the control plane spawns a fresh sandbox.
- Only sandboxes that fail before becoming usable — a spawn that never connects, or one whose
  session-env write fails — are **killed**, to avoid orphaning them.

Paused E2B sandboxes are not billed and are retained indefinitely, so pausing is the default
recoverable stop. `E2B_AUTO_PAUSE` controls the **TTL action** (pause vs kill when the timeout
lapses); the ~10-minute inactivity pause above is driven by the shared lifecycle manager and applies
regardless of that flag. Resume is always control-plane-driven — the next prompt reconnects the
sandbox through the lifecycle manager. E2B's provider-side auto-resume is deliberately **disabled**
so stray inbound traffic to an old tunnel can't wake a paused sandbox outside that state machine.

## Required Secrets

Terraform passes these provider-level values to the control plane:

- `E2B_API_KEY` — used for the E2B REST API **and** the code-server password HMAC, and to
  authenticate the template build
- `E2B_TEMPLATE_ID`
- `E2B_API_URL` (optional)
- `E2B_PREVIEW_BASE_URL` (optional, HTTPS only)
- `E2B_USE_CREATE_TIME_ENV` (`true` only for compatible self-hosted backends such as Cube)

Repository credentials and model credentials have separate boundaries. GitHub uses minted App
credentials; connection-pinned Gitea Git operations use a server-side proxy so the PAT never enters
the sandbox. Native Codex/Claude credentials are materialized only for their selected harness, and
the Cube DeepSeek provider key stays on the Host relay. See [SECRETS.md](./SECRETS.md) and
[HARNESSES.md](./HARNESSES.md).

## Verify

After `terraform apply`, verify:

1. The control plane is healthy:

   ```bash
   curl https://open-inspect-control-plane-<deployment_name>.<workers-subdomain>.workers.dev/health
   ```

2. Managed E2B shows the template as built, or Cube reports the registered template as ready with
   the intended CPU/memory values.

3. Starting a session in the Web app creates a sandbox from the exact configured template ID and
   reaches `Connected`.

4. Verify the selected harness, repository connection, clone, commit, push, and PR path.

5. For a Cube template with AIO browser support, verify all browser data paths:

   - `http://127.0.0.1:9222/json/version` returns a Chromium version and `webSocketDebuggerUrl`;
   - `aio_browser` initializes and can navigate to a local application;
   - `agent-browser` creates a valid 1280×720 screenshot while reusing the same Chromium tree;
   - the screenshot appears in the production Web session;
   - a configured app port opens through the trusted HTTPS preview gateway.

6. Inside the session, ask a simple repository question such as:

   ```text
   tell me about this repository
   ```

If a session starts but never produces agent output, check the control-plane Worker logs and the
sandbox logs for supervisor startup, bridge connection, selected-harness readiness, browser
readiness, and model-relay events.

## Common Issues

### Template Was Not Built

When `sandbox_provider = "e2b"`, Terraform builds the template during `terraform apply`, keyed on a
hash of the template and runtime source. To force a rebuild, change a hashed source file under
`packages/e2b-infra` or `packages/sandbox-runtime/src`. For a manual build, confirm
`E2B_TEMPLATE_ID` matches the name set in Terraform.

### Sandbox Times Out Too Soon

On plans with a short maximum lifetime, lower `e2b_sandbox_timeout_seconds`. With `E2B_AUTO_PAUSE`
enabled the sandbox pauses (recoverable) at the TTL rather than being lost.

### Missing Repository Access

Repository access comes from the connection pinned to the session. For GitHub, check App
installation permissions. For Gitea, check the connection health, allowed host, repository catalog,
service-account permissions, and Git proxy authorization before debugging the sandbox provider.

### LLM/API Key Problems

Confirm that the chosen model is compatible with the session-pinned harness and that its credential
route is ready. Native Codex and Claude use their deployment credentials; DeepSeek on Cube uses the
Host relay; other OpenCode providers use their configured secret scope. A model-name or credential
failure occurs before browser or Cube functionality and should be diagnosed separately.

## References

- [E2B sandbox overview](https://e2b.dev/docs/sandbox)
- [E2B sandbox persistence (pause/resume)](https://e2b.dev/docs/sandbox/persistence)
- [E2B billing](https://e2b.dev/docs/billing)
- [E2B REST API](https://e2b.dev/docs/api-reference)
- [ByteDance Agent Infra AIO Sandbox](https://github.com/agent-infra/sandbox)
