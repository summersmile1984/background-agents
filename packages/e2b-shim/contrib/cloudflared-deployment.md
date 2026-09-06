# Deploy oi-e2b-shim behind cloudflared

This is the deployment shape that mirrors the runbook's tunnel setup. With the shim in front of
CubeAPI, the cloudflared tunnel records must change:

- **API surface**: `cubeapi.89347589.org` → `http://127.0.0.1:3100` (was `127.0.0.1:3000`).
- **Edge surface (new)**: `*.sb.89347589.org` → `http://127.0.0.1:3100` (new wildcard hostname). The
  shim dispatches by Host header.
- **DNS**: add a wildcard CNAME `*.sb.89347589.org` → `<tunnel-id>.cfargot.<>` or the tunnel's own
  CNAME (Cloudflare API: `POST /zones/{id}/dns_records`, type CNAME, name `*.sb`, content
  `<tunnel>.cfargot.<account_hash>`, proxied).

The cloudflared configuration (`cloudflared tunnel ingress`) for the existing tunnel can be updated
either by the dashboard or via the API:

```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
{
  "config": {
    "ingress": [
      { "hostname": "cubeapi.89347589.org",   "service": "http://127.0.0.1:3100" },
      { "hostname": "*.sb.89347589.org",      "service": "http://127.0.0.1:3100" },
      { "service": "http_status:404" }
    ]
  }
}
```

The Wildcard Cert Service handles a `*.sb.89347589.org` cert via the tunnel automatically.

The shim's `SHIM_DOMAIN` env var must match (`sb.89347589.org`).

## Why two surfaces on one port

The shim runs on a single Node HTTP listener. `Host` decides which surface serves:

- API: anything not ending in `${SHIM_DOMAIN}` → E2B control-plane API (`/sandboxes`,
  `/v2/sandboxes`, `/templates`, etc.). Auth: `X-API-Key` against `SHIM_API_KEYS`.
- Edge: `<port>-<id>.${SHIM_DOMAIN}` or `sandbox.${SHIM_DOMAIN}` → reverse-proxy to cube-proxy with
  Host rewritten to `${port}-${id}.cube.app`, envd (49983) gated by
  `envdAccessToken`/`X-Access-Token`.

## Setting up a new shim host

```sh
# 1. Install systemd unit + env
sudo cp packages/e2b-shim/contrib/oi-e2b-shim.service /etc/systemd/system/
sudo cp packages/e2b-shim/contrib/oi-e2b-shim.env.example /etc/default/oi-e2b-shim
sudo install -d -m 0755 -o turing-agents -g turing-agents /var/lib/open-inspect
sudoedit /etc/default/oi-e2b-shim       # fill SHIM_API_KEYS, CUBE_API_KEY, SHIM_DOMAIN
sudo systemctl daemon-reload
sudo systemctl enable --now oi-e2b-shim

# 2. Update cloudflared tunnel ingress (see snippet above), then:
sudo systemctl reload cloudflared
```

## Verifying

```sh
# API surface
curl https://cubeapi.89347589.org/health    # -> {"status":"ok"}

# Edge surface: create a sandbox, write to envd via the shim
E2B_API_KEY=... E2B_API_URL=https://cubeapi.89347589.org \
  python -c "from e2b_code_interpreter import Sandbox; print(Sandbox.create())"
```
