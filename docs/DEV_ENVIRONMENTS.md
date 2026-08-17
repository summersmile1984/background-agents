# Per-Sandbox Development Environments

Every sandbox image includes PostgreSQL, Redis, a browser desktop, screenshot tooling, code-server,
and a web terminal. Repository-owned services are opt-in through `.openinspect/environment.yaml` in
the primary repository:

```yaml
version: 1

services:
  postgres:
    enabled: true
    port: 5432
    database: app
    user: openinspect

  redis:
    enabled: true
    port: 6379

  processes:
    - name: web
      command: npm run dev
      cwd: .
      ports: [3000]
      ready_timeout_seconds: 60
      env:
        NODE_ENV: development
      # Optional application-specific flush/checkpoint before a snapshot.
      snapshot_command: npm run snapshot
```

The manifest is strict: unknown fields, invalid names, duplicate service names, duplicate ports, and
paths outside `/workspace` are rejected. A manifest or secondary-service failure degrades the
session and appears as a timeline warning; repository checkout and the coding harness remain usable.

## Runtime values

When enabled, built-in services export:

- PostgreSQL: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`
- Redis: `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`
- A process's first declared port: `OPENINSPECT_SERVICE_<NAME>_PORT` and
  `OPENINSPECT_SERVICE_<NAME>_URL`

Process environment values support ordinary `$VARIABLE` expansion after the built-in database
services are ready. Tunnel ports, CPU, memory, sandbox timeout, and scoped secrets remain host-owned
settings so a repository cannot silently broaden its own network or credential access.

## Persistence and snapshots

Database state lives under `/workspace/.openinspect/state`, separately inside each sandbox. Before a
filesystem snapshot, Open-Inspect:

1. removes native harness login material;
2. stops PostgreSQL with a fast checkpoint;
3. asks Redis to save and shut down;
4. runs each process's optional `snapshot_command` and terminates its process group;
5. reports snapshot readiness to the control plane.

On restore, the same manifest restarts services against the persisted state. Repository prebuilds
run setup hooks but do not start development services and never receive native harness subscription
credentials.
