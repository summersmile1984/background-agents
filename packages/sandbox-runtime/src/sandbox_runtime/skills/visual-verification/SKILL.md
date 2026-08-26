---
name: visual-verification
description: Verify application UI changes with uploaded screenshot or video artifacts
---

# visual-verification

Use this skill when the goal is to verify UI changes inside the application and return visual
evidence in the Open-Inspect session.

`oi-visual-verify` is the canonical runtime-owned verifier for OpenCode, Codex, Claude Code, and
DeepSeek. It resolves supervised services, constrains browser networking, evaluates declared
assertions, captures a screenshot, uploads it in the active prompt, and returns one JSON report.
`agent-browser` remains available only for exploratory/manual work.

## Key Fact

Only say “visual verification passed” when `oi-visual-verify` returns exit code `0`, report status
`passed`, and at least one `artifactId`. `failed`, `blocked`, and `not_requested` are not passing
proof. For open-ended debugging or video capture, use the manual workflow later in this skill.

## When To Use It

- Verify a UI change after editing code
- Capture before/after screenshots for comparison
- Confirm responsive layout differences at a chosen viewport
- Produce an uploaded screenshot or short video artifact the user can review in-session

## Success Criteria

The task is not complete until all of these are true:

1. The changed UI is opened in the browser.
2. The capture mode is chosen explicitly: viewport screenshot, full-page screenshot, or video.
3. The viewport is set explicitly or reported as a deliberate default.
4. A screenshot or video is uploaded in the same prompt.
5. The returned `artifactId` is reported back to the user.
6. The response states what was verified and what dimensions/mode were used.

## Required Workflow

1. Ensure the repository service is declared in `.openinspect/environment.yaml` and is ready.
2. Prefer repository scenarios in `.openinspect/verification.yaml` when host policy allows them.
3. Build the request from the active prompt context and pipe it to `oi-visual-verify`.
4. Parse only the final JSON object; report its status, scenario, viewport, and artifact IDs.
5. If the command is disabled or blocked, say exactly what remains unverified.

Explicit one-page verification example:

```bash
jq -nc \
  --slurpfile prompt /tmp/open-inspect-current-prompt.json \
  '{version:1,sessionId:$prompt[0].sessionId,messageId:$prompt[0].messageId,
    adHoc:{service:"web",path:"/",viewport:{width:1440,height:900},capture:"viewport"},
    reason:"user_requested"}' \
  | oi-visual-verify
```

Repository-declared scenario example:

```bash
jq -nc \
  --slurpfile prompt /tmp/open-inspect-current-prompt.json \
  '{version:1,sessionId:$prompt[0].sessionId,messageId:$prompt[0].messageId,
    scenarioIds:["home-desktop"],reason:"repository_declared"}' \
  | oi-visual-verify
```

## Default Decision Rules

- Use a viewport screenshot when validating a specific visible state, modal, interaction, or
  desktop/mobile layout.
- Use a full-page screenshot when the user asks for the whole page or when vertical content is part
  of the verification.
- If the user names a device or screen size, set the viewport explicitly.
- If the user does not specify dimensions and layout matters, choose a reasonable viewport and
  report it.
- If the screenshot is intended to prove a fix, prefer stating exactly what was checked, not only
  that a screenshot was taken.
- Use a video when the proof depends on seeing interaction over time, such as opening a menu,
  dragging, typing, navigating between states, or watching an animation complete.

## Using Screenshots From Other Sources

If the screenshot already exists as a file — for example, captured via Playwright MCP
(`playwright_browser_take_screenshot`), a manual capture, or any other tool — skip the
`agent-browser` steps and upload the file directly:

```bash
upload-media /path/to/existing-screenshot.png \
  --caption "Description of what was captured" \
  --source-url "$URL"
```

Add `--full-page` or `--viewport '{"width":1512,"height":982}'` as appropriate. The same reporting
template and guardrails below still apply.

For a dedicated upload-only workflow, see the `upload-screenshot` skill.

## Recommended Commands

Viewport capture:

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
agent-browser wait 2000 && \
agent-browser screenshot --json /tmp/verify.png && \
upload-media /tmp/verify.png \
  --caption "UI verification screenshot" \
  --source-url "$URL" \
  --viewport '{"width":1512,"height":982}'
```

Full-page capture:

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
agent-browser wait 2000 && \
agent-browser screenshot --full --json /tmp/verify-full.png && \
upload-media /tmp/verify-full.png \
  --caption "Full-page verification screenshot" \
  --source-url "$URL" \
  --viewport '{"width":1512,"height":982}' \
  --full-page
```

Annotated capture for review/debugging:

```bash
agent-browser open "$URL" && \
agent-browser wait 2000 && \
agent-browser screenshot --annotate --json /tmp/verify-annotated.png && \
upload-media /tmp/verify-annotated.png \
  --caption "Annotated UI verification screenshot" \
  --source-url "$URL" \
  --annotated
```

Video recording for interaction flows:

```bash
set -e
agent-browser open "$URL"
agent-browser set viewport 1512 982
agent-browser snapshot -i

STARTED_AT_MS=$(date +%s%3N)
agent-browser record start /tmp/opencode/menu-recording.mp4
recording_started=1
cleanup_recording() {
  if [ "${recording_started:-0}" = "1" ]; then
    agent-browser record stop || true
  fi
}
trap cleanup_recording EXIT

interaction_exit_code=0
agent-browser click "[data-testid=settings]" || interaction_exit_code=$?
agent-browser wait 1000 || interaction_exit_code=$?

agent-browser record stop
recording_started=0
trap - EXIT

ENDED_AT_MS=$(date +%s%3N)
PROBE_JSON=$(ffprobe -v error -print_format json -show_streams -show_format /tmp/opencode/menu-recording.mp4)
DURATION_MS=$(node -e 'const p=JSON.parse(process.argv[1]); const v=(p.streams||[]).find((s)=>s.codec_type==="video")||{}; const d=Number(v.duration ?? p.format?.duration); console.log(Math.max(1, Math.round(d * 1000)));' "$PROBE_JSON")
DIMENSIONS=$(node -e 'const p=JSON.parse(process.argv[1]); const v=(p.streams||[]).find((s)=>s.codec_type==="video")||{}; console.log(JSON.stringify({width:Number(v.width),height:Number(v.height)}));' "$PROBE_JSON")
upload-media /tmp/opencode/menu-recording.mp4 \
  --artifact-type video \
  --caption "Menu interaction recording" \
  --source-url "$URL" \
  --duration-ms "$DURATION_MS" \
  --recording-started-at "$STARTED_AT_MS" \
  --recording-ended-at "$ENDED_AT_MS" \
  --dimensions "$DIMENSIONS" \
  --truncated false \
  --has-audio false
exit "$interaction_exit_code"
```

## Reporting Template

Include the following in the final response:

- What UI change or state was verified
- Whether the capture was viewport, full-page, or video
- The viewport used
- The source URL
- The uploaded artifact ID
- Any limitation, such as auth gating, loading issues, or unverified states

Example:

```text
Verified the updated settings page header.
Capture mode: viewport
Viewport: 1512x982
Source: http://127.0.0.1:3000/settings
Uploaded artifact: abc123
```

## Guardrails

- Do not claim the screenshot or video was uploaded unless the upload command returned an artifact
  ID.
- Do not report viewport metadata you did not explicitly set or verify.
- Do not use `upload-media` in a later prompt; it is prompt-scoped.
- Do not leave an active recording open. Always run `agent-browser record stop` if a recording was
  started.
- If the user asked for a full-page screenshot, do not use viewport-only capture.
- If the UI requires interaction before it matches the expected state, perform that interaction
  before capturing.
- For video metadata, use the encoded MP4 dimensions and duration from `ffprobe`; do not reuse the
  requested viewport as video dimensions.
- Prefer stable selectors such as `[data-testid=...]`, `[data-clear-completed]`, or `#todo-title`.
  Run `agent-browser snapshot -i` before recording when selectors or accessible names are uncertain.

## Relationship To `agent-browser`

- Use `agent-browser` directly for open-ended browsing, debugging, auth flows, snapshots, and custom
  inspection.
- Use `visual-verification` when the deliverable is proof that a UI change works and the user should
  receive an uploaded screenshot or video artifact.
