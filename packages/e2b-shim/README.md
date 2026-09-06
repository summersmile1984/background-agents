# @open-inspect/e2b-shim

E2B SaaS-compatible façade in front of a self-hosted
[CubeSandbox](https://cnb.cool/CubeSandbox/CubeSandbox) installation. It lets the Open-Inspect
control plane use the same E2B protocol for managed E2B and CubeSandbox. The common sandbox
lifecycle surface is compatible with official E2B SDK calls; the explicit matrix below documents the
remaining gaps instead of treating the entire E2B organization API as implemented.

## Why

CubeSandbox v0.7.0 implements most of the E2B API but differs in ways that previously forced
Cube-specific branches into the control plane:

| Capability                                     | CubeSandbox v0.7.0                               | Shim behaviour                                                 |
| ---------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `secure: true` envd access token               | accepted, silently ignored (envd is anonymous)   | shim mints `envdAccessToken`, enforces it on the edge surface  |
| `autoPause` / `autoResume` top-level fields    | supported in 0.7; older templates use nested     | normalized onto `lifecycle{onTimeout:"pause", autoResume}`     |
| `connect` status codes                         | always 200                                       | 200 running / 201 resumed-from-paused (E2B semantics)          |
| `GET /v2/sandboxes` metadata filter + cursor   | parsed but unimplemented                         | in-memory filter + `X-Next-Token`/`X-Total-Running` pagination |
| `GET /sandboxes/{id}/metrics` (+ batch)        | endpoint absent                                  | translated from envd `/metrics`                                |
| list/get metadata                              | leaks `cube.*` internals                         | stripped                                                       |
| envd internal endpoints (`/init`, `/upgrade`…) | reachable anonymously                            | refused with 403 on the edge surface                           |
| `domain` in responses                          | internal-only `cube.app`                         | rewritten to the shim's public domain                          |
| template alias in create                       | not resolved                                     | resolved via `/templates` aliases                              |
| create-time `envVars`                          | loader/path deny-list, 4 KiB/value, 16 KiB total | held by shim and injected through private envd after VM ready  |
| `POST /sandboxes/{id}/fork`                    | endpoint absent                                  | full-memory snapshot + independent Cube restores               |

The shim also exposes Cube 0.7's native E2B-compatible resume, network update, refresh, v1/v2 logs,
snapshot and volume routes. Snapshot-list pagination headers are preserved end to end. The
deprecated v1 sandbox list is constrained to running sandboxes; v2 additionally supports state,
metadata, template, start-time, sort-order and cursor filtering.

## E2B compatibility matrix

| Official E2B API family                | Status                 | Notes                                                                    |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| create/get/list/kill/timeout/connect   | compatible             | create-time `envVars`, secure envd token and connect 200/201 are aligned |
| pause/resume                           | partial                | full-memory pause works; `memory:false` fails closed with 501            |
| network/refresh/logs                   | compatible passthrough | Cube 0.7 native routes                                                   |
| sandbox and batch metrics              | degraded               | latest envd point only; no historical series                             |
| sandbox snapshots/list                 | compatible passthrough | Cube 0.7 native routes and pagination headers                            |
| fork                                   | compatible translation | one private full-memory snapshot, independent restore result per fork    |
| volumes                                | compatible passthrough | create/list/get/delete                                                   |
| templates v1 + aliases/build status    | partial                | native core plus translated status                                       |
| templates v2/v3 files/tags/build steps | partial                | v3 create is translated; full build protocol is not implemented          |
| teams/users/API keys/secrets/admin     | out of scope           | organization control APIs are not used by Open-Inspect                   |

Open-Inspect deliberately keeps snapshot restore/prebuilt-image capability disabled until Cube can
perform E2B's filesystem-only pause (`memory: false`) safely. Reporting that capability early would
risk snapshotting a live build process into the reusable image.

## Surfaces

One HTTP listener, dispatched by `Host` and the official stable-gateway headers:

- **API surface** (`api.<your-domain>`): E2B control-plane API. Auth: `X-API-Key` against
  `SHIM_API_KEYS`; the shim forwards to CubeAPI with its own backend key, so callers never hold it.
- **Edge surface** (`<port>-<sandboxID>.<your-domain>`, plus `sandbox.<your-domain>` with
  `E2b-Sandbox-Id`/`E2b-Sandbox-Port` headers): reverse-proxies cube-proxy with the Host rewritten
  onto Cube's internal domain. envd (49983) requires the shim-issued token (`X-Access-Token` header
  or a presigned-URL `signature`/`signature_expiration` query pair). WebSocket upgrades are
  tunnelled.

## Configuration

| Env                        | Default                   | Purpose                                                 |
| -------------------------- | ------------------------- | ------------------------------------------------------- |
| `SHIM_LISTEN_PORT`         | `3100`                    | listen port                                             |
| `SHIM_API_KEYS`            | — (required)              | comma-separated E2B-facing API keys                     |
| `CUBE_API_URL`             | `http://127.0.0.1:3000`   | CubeAPI base URL                                        |
| `CUBE_API_KEY`             | — (required)              | backend CubeAPI credential                              |
| `SHIM_DOMAIN`              | _(empty = edge disabled)_ | public domain advertised in `domain` responses          |
| `CUBE_PROXY_URL`           | `http://192.168.9.100`    | cube-proxy base URL for the edge surface                |
| `CUBE_DOMAIN`              | `cube.app`                | Cube's internal sandbox domain                          |
| `SHIM_DB_PATH`             | `:memory:`                | SQLite path for tokens/state (use a file in production) |
| `SHIM_STRIP_CUBE_METADATA` | `true`                    | strip `cube.*`/`X-Caller` metadata keys                 |

## Run

```sh
npm run build -w @open-inspect/e2b-shim
SHIM_API_KEYS=... CUBE_API_KEY=... SHIM_DOMAIN=example.org npm run start -w @open-inspect/e2b-shim
```

State (envd tokens, lifecycle state for connect 200/201) lives in SQLite; use a persistent
`SHIM_DB_PATH` so tokens survive restarts.

## Use with the official SDKs

Callers use the normal E2B SDK configuration; no Cube-specific client or request shape is needed:

```sh
export E2B_API_KEY=your-shim-api-key
export E2B_DOMAIN=example.com
```

With the 1:1 public layout, the official SDK derives `https://api.example.com` and
`https://sandbox.example.com` exactly as it derives E2B's own hosts. Deploy a wildcard DNS record
and edge route for `<port>-<sandboxID>.example.com`. If a caller needs explicit overrides, use:

```sh
export E2B_API_URL=https://api.example.com
export E2B_SANDBOX_URL=https://sandbox.example.com
```

The SDK still sends `POST /sandboxes` with `envVars`, `secure`, lifecycle, network and volume
fields. The shim translates only at the provider boundary and returns the same E2B-shaped sandbox
connection data. `CUBE_PROXY_URL` must remain a private HTTP endpoint because the shim uses its
internal envd `/init` path before returning a newly created sandbox.
