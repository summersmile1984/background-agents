# Session E2E Troubleshooting

Use this runbook when validating the complete path from a web or chat-channel request to a coding
session, sandbox work, source-control push, pull request, generated media, and completion callback.
It records failure modes found during the 2026-08-26 Gitea + Feishu + Codex production validation.

The unit of success is the whole workflow, not a repository picker, a connected WebSocket, a local
commit, or an agent's final message in isolation:

```text
channel/web request
  -> source + repository + branch + harness + model selection
  -> control-plane session and prompt
  -> fresh sandbox from the intended template
  -> authenticated clone and normal harness execution
  -> targeted runtime/browser verification
  -> authenticated push and idempotent pull-request creation
  -> media registration, when requested
  -> prompt.complete and channel completion callback
```

## Failure Matrix

| Symptom                                                                                  | Likely cause                                                                                                     | Correct response                                                                                                                                                        | Proof of recovery                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The channel stops after asking for a repository                                          | The channel flow selected a repository but did not submit a complete session specification and prompt            | Carry the SCM connection, repository identity, branch, harness, model, reasoning effort, skills, and user prompt into the same session-creation path used by the web UI | A session exists, the prompt is dispatched, and the channel receives the completion callback                                        |
| Feishu starts immediately with the deployment default Harness                            | The repository card bypassed the readiness-aware runtime catalog                                                 | Use the staged Harness → model/route → effort cards; only use the legacy default path while the catalog endpoint is unavailable                                         | The session launch spec and Feishu work card show the selected Harness, route, model, and effort                                    |
| A Gitea repository is missing or resolves as GitHub                                      | Repository identity was reduced to `owner/name` and lost its SCM connection                                      | Treat connection/provider plus repository identity as inseparable; never infer the provider from `owner/name`                                                           | Session metadata and repository links both point at the selected Gitea connection                                                   |
| `Model not found: openai/<model>` from a native harness                                  | A catalog identifier was passed directly to a harness that expects its native model name                         | Normalize at the harness adapter boundary; preserve provider/model metadata in Open-Inspect but pass the harness-native identifier to the runtime                       | The runtime starts with the selected model and the session sidebar reports the same effective model                                 |
| A new session still behaves like old code                                                | The deployment changed, but the sandbox restored an old image/template                                           | Build the runtime image, publish a new provider template, update the deployment's template ID, deploy the control plane, and create a genuinely new session             | Provider inventory reports the expected template ID on the new sandbox                                                              |
| Visual verification raises `FileNotFoundError` for `/tmp/open-inspect-dev-services.json` | A repository has no managed-service manifest, so the supervisor returned before writing its service registry     | Always persist an empty, sandbox-owned service registry; the verifier can then return a structured `config_missing` or `service_not_found` result                       | The metadata file exists even when `manifestPath` is null, and the verifier never leaks a raw missing-file exception                |
| A local commit exists but `git push` reports that `SANDBOX_AUTH_TOKEN` is missing        | A shell script tried to use the internal session credential directly, or the credential-helper path was bypassed | Keep the token out of the harness shell. Route Git authentication through the installed credential helper and control-plane credential broker                           | `SANDBOX_AUTH_TOKEN` is absent from shell commands while clone/fetch/push still work                                                |
| Screenshot upload fails because the shell has no sandbox token                           | A skill invoked a shell uploader that depended on the internal session credential                                | Use the trusted `open_inspect/upload_media` MCP tool; its broker owns the credential and accepts only a validated local media path and metadata                         | The tool returns an artifact ID and the session displays the item under **Media**                                                   |
| `open_inspect/upload_media` rejects `artifact_type=image`                                | The caller used a generic media label rather than the tool schema                                                | Use `screenshot` for PNG/JPEG/WebP and `video` for MP4                                                                                                                  | The upload returns an artifact ID and renders with the intended artifact type                                                       |
| A native harness is still processing, but the sandbox is stopped as idle                 | The lifecycle watchdog only observed tool/token activity; a slow model turn had no recent event                  | Keep the sandbox alive while the session has a processing message; let the execution timeout, not the idle timeout, terminate a genuinely stuck turn                    | A prompt that waits longer than the idle interval remains connected, and a later completion or execution-timeout event is delivered |
| Pull-request creation returns HTTP 409                                                   | A PR for the same head/base pair already exists                                                                  | Treat the operation as idempotent: resolve and return the existing open PR instead of failing the whole task or creating another branch                                 | The existing PR URL is returned and only one open PR represents the change                                                          |
| A full build or lint process exits 137                                                   | The sandbox exceeded its memory limit, commonly in a 2 GiB profile                                               | Record the resource failure separately. Run targeted application, HTTP, and browser checks for the changed behavior, or retry in a larger/prebuilt environment          | The functional acceptance checks pass; the resource-limited check remains explicitly reported, not silently marked successful       |
| Cleanup commands such as `rm` are rejected                                               | The harness safety wrapper blocks destructive shell operations                                                   | Prefer a patch-based deletion or another explicitly scoped, recoverable cleanup operation                                                                               | Temporary files are gone and `git status --short` is empty                                                                          |
| The agent finishes in the web UI but the channel receives nothing                        | Completion callback delivery failed after prompt completion                                                      | Trace `prompt.complete` and `callback.complete_delivery` with the same session/message/trace identifiers; retry only the callback when work already completed           | The channel shows the completion card/message once, without rerunning the coding task                                               |

## 1. Preserve the Complete Launch Specification

A channel adapter must not invent a second, reduced version of session creation. Its final action
must supply the same effective inputs as the web UI:

- SCM connection/provider;
- repository owner, repository name, and branch;
- selected Environment or repository set, when applicable;
- harness;
- model and reasoning effort;
- managed skills;
- the actual task prompt and attachments;
- callback metadata for the originating channel/thread.

Selecting a repository is an intermediate state. Do not report the request as accepted or complete
until a prompt has been persisted and dispatched. For multi-provider deployments, `owner/name` is
not globally unique. The SCM connection is part of the repository identity and must survive every
channel, API, database, and sandbox boundary.

Harness choice is immutable after session creation. Model or Harness setting changes therefore
require a new session when validating a fix; a follow-up in an old session is not sufficient.

## 2. Normalize Model IDs Only at the Harness Boundary

Open-Inspect may use a provider-qualified catalog identifier such as `openai/gpt-5.6-luna`, while a
native Codex app-server expects `gpt-5.6-luna`. Keep the qualified form where it disambiguates the
catalog, but translate it in the selected harness adapter before launch.

Do not fix this by globally stripping prefixes. OpenCode and other gateways may require the
qualified form. A correct test asserts both:

1. the session records and displays the intended effective model; and
2. the harness receives the identifier required by its own protocol.

## 3. Keep Host, Broker, and Harness Credentials Separate

`SANDBOX_AUTH_TOKEN` is an internal, per-session credential used by trusted runtime components to
authenticate to the control plane. Its absence from an agent shell is intentional and is not proof
that the sandbox lacks Git access.

The intended path is:

```text
git command from harness
  -> Git credential helper
  -> session credential endpoint
  -> SCM provider credential generation
  -> credential returned only to Git for the requested operation
```

For generated media, the intended path is:

```text
harness calls open_inspect/upload_media with a local file path
  -> trusted native MCP broker validates path/type/metadata
  -> broker uses the internal session credential
  -> control plane stores the artifact
  -> web/channel renders the registered media
```

Never solve either problem by injecting a Gitea PAT, GitHub installation token, or
`SANDBOX_AUTH_TOKEN` into the harness command environment. A smoke test should use a boolean-only
check such as `test -z "$SANDBOX_AUTH_TOKEN"`; never print credential values.

## 4. Deploy Every Sandbox Layer

A source merge does not update already-published sandbox templates, and updating a template secret
does not update already-running sessions. For self-hosted Cube/E2B, use this order:

1. Merge and test the runtime change.
2. Build the sandbox runtime image.
3. Publish a new immutable Cube/E2B template and wait for `READY`.
4. Update the deployment template ID.
5. Run the production Terraform deployment.
6. Create a fresh session after the deployment completes.
7. Inspect provider inventory and match the new session to the expected template ID.

Record the code commit, image digest, template ID, deployment run, session ID, and provider sandbox
ID together. Without this chain, a successful UI test may still be exercising an old runtime.

## 5. Make Push and PR Creation Idempotent

Agent retries, channel retries, and resumed sessions can all reach PR creation more than once. The
operation should converge on one PR for a head/base pair:

1. push the intended branch through the credential broker;
2. try to create the PR;
3. if the provider reports an existing PR, resolve it and return its URL;
4. leave the PR open for human review unless the user explicitly authorized merging.

A 409 caused by an existing PR is not evidence that the preceding code, tests, or push failed.
Likewise, a local commit is not proof of delivery; verify the remote branch and open PR separately.

## 6. Separate Functional Failures from Capacity Failures

Exit code 137 normally means the process was killed by the runtime, often for exceeding memory. Do
not reinterpret it as a source-code failure, and do not hide it behind a narrower passing check.

For a small route or UI change in a constrained sandbox:

- start the real application when possible;
- request the changed endpoint and assert status, body, and important headers;
- use a browser to assert visible behavior;
- capture and register a screenshot when visual proof is required;
- report any skipped or killed full build/lint command explicitly.

Increase the sandbox memory class or prepare dependencies in a repository/Environment image when the
repository's normal validation genuinely requires more capacity.

## 7. Validate Completion, Not Just Execution

For a channel-triggered task, require all applicable evidence before declaring the E2E flow healthy:

- the channel message was accepted exactly once;
- the intended SCM connection and repository were selected;
- a fresh sandbox reached `Ready`;
- the repository was cloned inside that sandbox, not on the Host;
- the intended harness/model processed the prompt;
- functional checks ran in the sandbox;
- Git push succeeded without exposing raw credentials;
- the new or existing PR URL was returned;
- requested media has an artifact ID and appears in the session;
- `prompt.complete` was recorded;
- the originating channel received its completion callback;
- the repository worktree is clean at handoff.

The Host may be used for deployment and provider inventory checks. It must not substitute for the
session sandbox when claiming that repository code or the development server was validated.

## Observability Checklist

Correlate these events using `trace_id`, `session_id`, and `message_id`:

```text
prompt.enqueue
prompt.dispatch
sandbox.spawn / sandbox.restore
bridge.connect
prompt.start
git.clone_complete
git.push_complete
prompt.run
prompt.complete
callback.complete_delivery
```

When a channel appears stuck at repository selection, first determine whether `prompt.enqueue`
exists. When the web UI says the agent finished but the channel is silent, begin at
`prompt.complete` and inspect `callback.complete_delivery` rather than rerunning the agent.

See [Debugging Playbook](DEBUGGING_PLAYBOOK.md) for event fields and cross-service queries,
[Agent Harnesses](HARNESSES.md) for runtime readiness and credential boundaries, and
[Secrets Management](SECRETS.md) for the reserved-key policy.

## Regression Test Template

Use a disposable or harmless repository and ask the agent to perform a non-mutating smoke test:

1. Confirm, without printing secrets, that `SANDBOX_AUTH_TOKEN` is absent from the harness shell.
2. Create a temporary HTML page outside the repository.
3. Serve it on an available sandbox port.
4. Open it with the sandbox browser and assert an exact heading.
5. Capture a PNG under `/tmp`.
6. Upload it with `open_inspect/upload_media` using `artifact_type=screenshot`.
7. Report the artifact ID.
8. Stop the server and remove temporary files with an allowed scoped operation.
9. Confirm the repository worktree is clean.
10. Confirm the session reports completion and the media appears in the UI.

For a mutating Gitea/Feishu acceptance test, add a small reviewable change, targeted runtime checks,
a conventional commit, brokered push, idempotent PR creation, and verification that Feishu receives
the final PR link. Do not merge the PR as part of the smoke test.
