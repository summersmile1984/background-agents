# @open-inspect/e2b-shim

E2B SaaS-compatible façade in front of a self-hosted
[CubeSandbox](https://cnb.cool/CubeSandbox/CubeSandbox) installation. It lets the control plane —
and official E2B SDKs — speak pure E2B semantics while the backend stays CubeSandbox.

## Why

CubeSandbox v0.6.0 implements most of the E2B API but differs in ways that previously forced
Cube-specific branches into the control plane:

| Capability                                     | CubeSandbox v0.6.0                             | Shim behaviour                                                 |
| ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `secure: true` envd access token               | accepted, silently ignored (envd is anonymous) | shim mints `envdAccessToken`, enforces it on the edge surface  |
| `autoPause` / `autoResume` top-level fields    | ignored (only nested `lifecycle{}` works)      | mapped onto `lifecycle{onTimeout:"pause", autoResume}`         |
| `connect` status codes                         | always 200                                     | 200 running / 201 resumed-from-paused (E2B semantics)          |
| `GET /v2/sandboxes` metadata filter + cursor   | parsed but unimplemented                       | in-memory filter + `X-Next-Token`/`X-Total-Running` pagination |
| `GET /sandboxes/{id}/metrics` (+ batch)        | endpoint absent                                | translated from envd `/metrics`                                |
| list/get metadata                              | leaks `cube.*` internals                       | stripped                                                       |
| envd `x-internal` endpoints (`/init`, freeze…) | reachable anonymously                          | refused with 403 on the edge surface                           |
| `domain` in responses                          | internal-only `cube.app`                       | rewritten to the shim's public domain                          |
| template alias in create                       | not resolved                                   | resolved via `/templates` aliases                              |

## Surfaces

One HTTP listener, dispatched by `Host`:

- **API surface** (`cubeapi.<your-domain>`): E2B control-plane API. Auth: `X-API-Key` against
  `SHIM_API_KEYS`; the shim forwards to CubeAPI with its own backend key, so callers never hold it.
- **Edge surface** (`<port>-<sandboxID>.<shimDomain>`, plus the stable `sandbox.<shimDomain>` entry
  with `E2b-Sandbox-Id`/`E2b-Sandbox-Port` headers): reverse-proxies cube-proxy with the Host
  rewritten onto Cube's internal domain. envd (49983) requires the shim-issued token
  (`X-Access-Token` header or a presigned-URL `signature`/`signature_expiration` query pair).
  WebSocket upgrades are tunnelled.

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
SHIM_API_KEYS=... CUBE_API_KEY=... SHIM_DOMAIN=sb.example.org npm run start -w @open-inspect/e2b-shim
```

State (envd tokens, lifecycle state for connect 200/201) lives in SQLite; use a persistent
`SHIM_DB_PATH` so tokens survive restarts.
