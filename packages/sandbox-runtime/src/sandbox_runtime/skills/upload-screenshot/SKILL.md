---
name: upload-screenshot
description: Upload an existing screenshot, chart, or generated image to the Open-Inspect session
---

# upload-screenshot

Use this skill when you already have an image file on disk and need to upload it to the Open-Inspect
session. The image may be a screenshot captured by Playwright MCP or `agent-browser`, a generated
chart or diagram, a manual file, or output from another tool.

For the full browser-open + capture + upload workflow, use `visual-verification` instead.

## Key Fact

Prefer the `open_inspect/upload_media` MCP tool when it is advertised. It can read the sandbox file
while keeping the session credential outside harness shell commands. If that MCP tool is not
available, `upload-media` is a **bash command** installed on PATH.

## When To Use It

- Upload a screenshot that was already captured (e.g. via Playwright MCP)
- Upload a generated chart, graph, diagram, or other review image
- Upload an image file the user points you to
- The user says "upload the screenshot", "upload this image", or asks for an image they can review

## Required Workflow

1. Confirm the image file exists on disk.
2. Call `open_inspect/upload_media` with the absolute file path and metadata. If it is unavailable,
   run `upload-media` via Bash with the same inputs.
3. Report the returned `artifactId` to the user.

## Command

```bash
upload-media <file-path> \
  --caption "Description of screenshot" \
  --source-url "https://example.com" \
  [--full-page] \
  [--annotated] \
  [--viewport '{"width":1512,"height":982}']
```

All flags except the file path are optional. Include whichever metadata you know:

- `--caption` — what the screenshot shows
- `--source-url` — the URL that was captured
- `--full-page` — set if the screenshot is a full-page capture
- `--annotated` — set if the screenshot has annotations
- `--viewport` — JSON object with width and height of the viewport used

For generated images that do not depict a browser page, omit browser-specific flags such as
`--source-url`, `--full-page`, and `--viewport`.

## Supported File Types

`.png`, `.jpg` / `.jpeg`, `.webp`

## Success Criteria

The task is not complete until:

1. `upload-media` returned a JSON response containing an `artifactId`.
2. The `artifactId` is reported to the user.
3. The response states what was uploaded and the source URL (if known).

## Example

```text
Uploaded screenshot of the homepage.
Source: https://example.com
Uploaded artifact: abc123def456
```

Generated chart:

```bash
upload-media /tmp/revenue-chart.png \
  --caption "Monthly recurring revenue by quarter"
```

## Guardrails

- Do not claim the image was uploaded unless `upload-media` returned an artifact ID.
- Writing an image into the repository does not make it available for review. Run `upload-media`
  whenever the user asks for a generated image or chart they can review.
- If the file does not exist or is not a supported type, report the error instead of retrying
  silently.
- If the user needs a full browser workflow (open page, set viewport, capture, upload), delegate to
  `visual-verification` instead.
