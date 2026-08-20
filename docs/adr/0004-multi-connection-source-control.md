# ADR 0004: Multi-Connection Source Control and Repository Identity

## Status

Accepted. The expand/dual-read implementation is present; key cutover and final contract remain
rollout phases guarded by the migration preflight.

Supersedes the single-provider-per-deployment decision in ADR 0001. The boundary rules that keep
provider-specific API, URL, and authentication behavior inside provider adapters remain in force.

## Context

Open-Inspect must operate GitHub and self-hosted Gitea connections in the same installation. The
existing `SCM_PROVIDER` singleton, owner/name repository identity, numeric provider repository IDs,
and one-origin sandbox credential cache cannot safely distinguish two forges. A Gitea PAT is also a
long-lived machine credential and must not be released to arbitrary sandbox code.

The complete implementation and migration plan is documented in
`docs/plans/gitea-multi-provider.md`.

## Decision

1. **Provider and connection are different concepts.** A provider implements forge behavior. A
   connection identifies one configured forge instance and credential authority.
2. **Repositories receive stable internal IDs.** `scm_repositories.id` is canonical. The unique
   provider lookup is `(connection_id, external_id)`; owner/name are mutable location snapshots.
3. **Repository-backed aggregates use one connection.** Every repository in one session,
   environment, or automation belongs to the same connection. Repo-less aggregates keep a null
   connection and receive no SCM authority.
4. **Connections are pinned.** Existing sessions, environments, automations, runs, images, and pull
   requests never follow a later change to the installation default.
5. **Long-lived forge credentials remain server-side.** Production Gitea Git traffic uses a
   session/build- and repository-authorized smart-HTTP proxy. A sandbox receives only a short-lived,
   hashed-at-rest proxy capability.
6. **Migration is expand/backfill/cutover/contract.** SQL expansion is additive; an idempotent
   online job performs provider lookups; key cutover has an explicit rollback fence; legacy columns
   are removed only after fallback use reaches zero.
7. **Capabilities, not provider names, gate generic features.** Truly GitHub-specific login,
   signing, and webhook routes retain explicit provider boundaries.

## Consequences

### Positive

- GitHub and multiple self-hosted Gitea instances can coexist without cache, secret, image, or PR
  identity collisions.
- Repository rename and transfer preserve Open-Inspect history.
- Disabling or replacing one connection does not retarget durable work.
- Long-lived PATs are excluded from sandbox environments, Git remotes, snapshots, and event logs.
- The same seams support future self-hosted GitLab and additional forge providers.

### Negative

- Repository identity touches D1, session Durable Objects, APIs, UI, image builds, automations, and
  bot provenance, so rollout requires several compatible releases.
- Mixed-forge multi-repository sessions remain unsupported until a separate threat-model review.
- Proxying Git pack traffic adds an operational data path and must pass Cloudflare streaming/size
  feasibility tests or move to a dedicated data-plane relay.
- Old binaries are not safe after the key-cutover migration; deployment preflight must enforce the
  rollback fence.

## Invariants

- A resolved repository has a connection, external ID, credential-free clone URL, and web URL.
- An unresolved repository is historical/read-only and cannot start a sandbox or issue credentials.
- A repo-less session cannot call the SCM credential or Git proxy endpoints successfully.
- A Git proxy request identifies only an internal repository already authorized for its subject.
- Provider credentials never appear in browser responses, Queue payloads, Modal environment
  variables, sandbox Git config, clone URLs, or logs.
