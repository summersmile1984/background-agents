import { RUNTIME_COMMANDS } from "@open-inspect/shared/runtime-commands";
import { verifySlackSignature } from "@open-inspect/shared/slack";
import { Hono } from "hono";
import { z } from "zod";
import { signedControlPlaneFetch } from "../internal-auth";
import { createLogger } from "../logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";
import type { Env } from "../types";

const log = createLogger("slash-command");
const SLACK_INSPECT_COMMAND = "/inspect";
const SUPPORTED_SLASH_NAMES = ["help", "status", "stop", "review"] as const;
const SESSION_SLASH_NAMES = ["status", "stop", "review"] as const;

const slashCommandPayloadSchema = z.object({
  command: z.literal(SLACK_INSPECT_COMMAND),
  text: z.string().default(""),
  response_url: z.string().url(),
  user_id: z.string().trim().min(1),
  channel_id: z.string().trim().min(1),
  trigger_id: z.string().trim().min(1),
});

type SlackInspectCommand = (typeof SUPPORTED_SLASH_NAMES)[number];
type SlackSessionCommand = (typeof SESSION_SLASH_NAMES)[number];

interface ControlPlaneCommandResponse {
  error?: string;
  action?: string;
  runtime?: {
    target?: {
      provider?: string | null;
      repositories?: Array<{ owner: string; name: string; branch: string }>;
    };
    harness?: string;
    routeId?: string;
    model?: string;
    effort?: string | null;
    sandboxStatus?: string | null;
    sessionStatus?: string | null;
  };
}

function isAllowedSlackResponseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "hooks.slack.com" ||
        url.hostname.endsWith(".slack.com") ||
        url.hostname === "hooks.slack-gov.com" ||
        url.hostname.endsWith(".slack-gov.com"))
    );
  } catch {
    return false;
  }
}

function commandDefinition(slashName: SlackInspectCommand) {
  return RUNTIME_COMMANDS.find((command) => command.slashName === slashName);
}

function helpText(webAppUrl: string): string {
  const descriptions = SUPPORTED_SLASH_NAMES.filter((name) => name !== "help")
    .map((name) => {
      const definition = commandDefinition(name);
      return `\u2022 \`/inspect ${name} <session-id-or-url>\` \u2014 ${definition?.description ?? name}`;
    })
    .join("\n");
  return [
    "*Open-Inspect commands*",
    descriptions,
    `\u2022 \`/inspect help\` \u2014 Show this help`,
    "",
    `Create sessions and change runtime settings in <${webAppUrl}|Open-Inspect Web>.`,
    "The Web composer uses `/status`; Slack uses `/inspect status`, so the two inputs do not conflict.",
  ].join("\n");
}

function extractSessionId(value: string): string | null {
  const slackLink = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  const candidate = slackLink.split("|", 1)[0]?.trim() ?? "";
  try {
    const url = new URL(candidate);
    const match = url.pathname.match(/\/session\/([^/]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {
    // A bare session id is also accepted.
  }
  return /^[A-Za-z0-9_-]{8,128}$/.test(candidate) ? candidate : null;
}

function parseInspectText(
  text: string
):
  | { command: "help"; sessionId: null }
  | { command: SlackSessionCommand; sessionId: string }
  | { error: string } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens[0] === "help") {
    if (tokens.length > 1) return { error: "Usage: `/inspect help`" };
    return { command: "help", sessionId: null };
  }
  const command = tokens[0] as SlackSessionCommand;
  if (!SESSION_SLASH_NAMES.includes(command)) {
    return { error: `Unknown command \`${tokens[0]}\`. Use \`/inspect help\`.` };
  }
  if (tokens.length !== 2) {
    return { error: `Usage: \`/inspect ${command} <session-id-or-url>\`` };
  }
  const sessionId = extractSessionId(tokens[1]);
  if (!sessionId) {
    return { error: "The session id or Open-Inspect session URL is invalid." };
  }
  return { command, sessionId };
}

function sessionUrl(webAppUrl: string, sessionId: string): string {
  return `${webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(sessionId)}`;
}

function formatResult(
  webAppUrl: string,
  sessionId: string,
  command: Exclude<SlackInspectCommand, "help">,
  response: Response,
  payload: ControlPlaneCommandResponse
): string {
  const link = `<${sessionUrl(webAppUrl, sessionId)}|View session>`;
  if (!response.ok) {
    return `:warning: ${payload.error ?? `Command failed (${response.status})`}\n${link}`;
  }
  if (command === "stop") return `:stop_sign: Stop requested.\n${link}`;
  if (command === "review") return `:mag: Review workflow queued.\n${link}`;

  const runtime = payload.runtime;
  const repositories = runtime?.target?.repositories ?? [];
  const target = repositories.length
    ? repositories.map((repo) => `${repo.owner}/${repo.name}@${repo.branch}`).join(", ")
    : "No repository";
  return [
    "*Open-Inspect runtime status*",
    `\u2022 Source: ${runtime?.target?.provider ?? "none"}`,
    `\u2022 Target: ${target}`,
    `\u2022 Harness: ${runtime?.harness ?? "unknown"}`,
    `\u2022 Route: ${runtime?.routeId ?? "unknown"}`,
    `\u2022 Model: ${runtime?.model ?? "unknown"}`,
    `\u2022 Effort: ${runtime?.effort ?? "default"}`,
    `\u2022 Session: ${runtime?.sessionStatus ?? "unknown"}; sandbox: ${runtime?.sandboxStatus ?? "unknown"}`,
    link,
  ].join("\n");
}

async function runInspectCommand(input: {
  env: Env;
  responseUrl: string;
  userId: string;
  triggerId: string;
  traceId: string;
  sessionId: string;
  command: SlackSessionCommand;
}): Promise<void> {
  const definition = commandDefinition(input.command);
  if (!definition) return;
  let text: string;
  try {
    const body = JSON.stringify({
      commandId: definition.id,
      arguments: {},
      clientInvocationId: `slack:${input.triggerId}`.slice(0, 128),
    });
    const response = await signedControlPlaneFetch(
      input.env,
      {
        method: "POST",
        url: `https://internal/sessions/${encodeURIComponent(input.sessionId)}/commands`,
        body,
        actor: `slack:${input.userId}`,
        traceId: input.traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    const payload = (await response.json().catch(() => ({}))) as ControlPlaneCommandResponse;
    text = formatResult(input.env.WEB_APP_URL, input.sessionId, input.command, response, payload);
  } catch (error) {
    log.error("slack.command.execute", {
      trace_id: input.traceId,
      command: input.command,
      session_id: input.sessionId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    text = `:warning: Open-Inspect could not run that command. Try again or open <${sessionUrl(input.env.WEB_APP_URL, input.sessionId)}|the session>.`;
  }
  await fetch(input.responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: true, text }),
  });
}

export const commandRoutes = new Hono<{ Bindings: Env }>();

commandRoutes.post("/commands", async (c) => {
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const isValid = await verifySlackSignature(
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
    c.env.SLACK_SIGNING_SECRET
  );
  if (!isValid) return c.json({ error: "Invalid signature" }, 401);

  const raw = Object.fromEntries(new URLSearchParams(body));
  const parsedPayload = slashCommandPayloadSchema.safeParse(raw);
  if (!parsedPayload.success || !isAllowedSlackResponseUrl(raw.response_url ?? "")) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const parsedCommand = parseInspectText(parsedPayload.data.text);
  if ("error" in parsedCommand) {
    return c.json({ response_type: "ephemeral", text: parsedCommand.error });
  }
  if (parsedCommand.command === "help") {
    return c.json({ response_type: "ephemeral", text: helpText(c.env.WEB_APP_URL) });
  }

  c.executionCtx.waitUntil(
    runInspectCommand({
      env: c.env,
      responseUrl: parsedPayload.data.response_url,
      userId: parsedPayload.data.user_id,
      triggerId: parsedPayload.data.trigger_id,
      traceId,
      sessionId: parsedCommand.sessionId,
      command: parsedCommand.command,
    })
  );
  return c.json({
    response_type: "ephemeral",
    text: `Running \`/inspect ${parsedCommand.command}\`\u2026`,
  });
});
