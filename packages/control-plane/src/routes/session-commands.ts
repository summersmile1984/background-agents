import { runtimeCommandInvocationSchema } from "@open-inspect/shared/types/runtime-launch";
import { buildRuntimeCommandOptions } from "../agent-runtime/commands";
import { SessionIndexStore } from "../db/session-index";
import { SessionLaunchSpecStore } from "../db/session-launch-specs";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import type { MessageSource } from "@open-inspect/shared/types/sessions";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

interface RuntimeState {
  status?: string;
  sandbox?: { status?: string } | null;
}

function actor(ctx: SessionRouteContext): { authorId: string; canonicalUserId?: string } {
  if (ctx.principal?.kind === "user") {
    return { authorId: ctx.principal.userId, canonicalUserId: ctx.principal.userId };
  }
  if (ctx.principal?.kind === "service" && ctx.principal.actor) {
    return {
      authorId: ctx.principal.actor.participantUserId,
      ...(ctx.principal.actor.canonicalUserId
        ? { canonicalUserId: ctx.principal.actor.canonicalUserId }
        : {}),
    };
  }
  return { authorId: "anonymous" };
}

function commandSource(ctx: SessionRouteContext): MessageSource {
  if (ctx.principal?.kind !== "service") return "web";
  if (ctx.principal.service === "slack-bot") return "slack";
  if (ctx.principal.service === "github-bot") return "github";
  if (ctx.principal.service === "linear-bot") return "linear";
  return "web";
}

async function sessionState(
  ctx: SessionRouteContext,
  sessionId: string
): Promise<RuntimeState | null> {
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.state);
  if (!response.ok) return null;
  return (await response.json()) as RuntimeState;
}

function isRunning(state: RuntimeState | null): boolean {
  return state?.sandbox?.status === "running";
}

async function recordCommand(input: {
  ctx: SessionRouteContext;
  sessionId: string;
  invocationId: string;
  commandId: string;
  slashName: string;
  status: "accepted" | "completed" | "rejected";
  summary: string;
  authorId: string;
}): Promise<void> {
  await input.ctx.sessionRuntime.fetch(input.sessionId, SessionInternalPaths.commandEvent, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "command_invoked",
      invocationId: input.invocationId,
      commandId: input.commandId,
      slashName: input.slashName,
      status: input.status,
      summary: input.summary,
      timestamp: Date.now() / 1000,
      authorId: input.authorId,
    }),
  });
}

async function handleCommand(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return error("Invalid command body", 400);
  }
  const parsed = runtimeCommandInvocationSchema.safeParse(raw);
  if (!parsed.success) return error("Invalid command body", 400);

  const [session, launchSpec, state] = await Promise.all([
    new SessionIndexStore(ctx.db).get(sessionId),
    new SessionLaunchSpecStore(ctx.db).get(sessionId),
    sessionState(ctx, sessionId),
  ]);
  if (!session) return error("Session not found", 404);
  if (!launchSpec) {
    return json(
      { error: "Structured commands require a session LaunchSpec", code: "COMMAND_UNAVAILABLE" },
      409
    );
  }
  const harness = launchSpec.runtime.harness.value;
  const liveMutation = {
    model: harness === "opencode",
    effort: harness === "opencode",
    settings: [],
  };
  const options = buildRuntimeCommandOptions({
    context: isRunning(state) ? "running-session" : "idle-session",
    harness,
    liveMutation,
  });
  const command = options.find((candidate) => candidate.id === parsed.data.commandId);
  if (!command || !command.available) {
    return json(
      {
        error: command?.unavailableReason ?? "Unknown command",
        code: "COMMAND_UNAVAILABLE",
        commands: options,
      },
      409
    );
  }
  if (Object.keys(parsed.data.arguments).length > 0 || command.arguments.length > 0) {
    return json(
      { error: "This command does not accept arguments", code: "COMMAND_UNAVAILABLE" },
      400
    );
  }

  const commandActor = actor(ctx);
  const eventBase = {
    ctx,
    sessionId,
    invocationId: parsed.data.clientInvocationId,
    commandId: command.id,
    slashName: command.slashName,
    authorId: commandActor.authorId,
  };

  if (command.id === "product.stop") {
    await recordCommand({ ...eventBase, status: "accepted", summary: "Stopping current turn" });
    const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.stop, {
      method: "POST",
    });
    if (response.ok) {
      await recordCommand({ ...eventBase, status: "completed", summary: "Stop requested" });
    }
    return response;
  }

  if (command.id === "product.review") {
    await recordCommand({ ...eventBase, status: "accepted", summary: "Review workflow queued" });
    const prompt: EnqueuePromptRequest = {
      content:
        "Review the current repository changes. Identify correctness, security, reliability, and test coverage issues; report findings by severity with file references.",
      source: commandSource(ctx),
      ...commandActor,
    };
    const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.prompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prompt),
    });
    if (response.ok) {
      await recordCommand({ ...eventBase, status: "completed", summary: "Review workflow queued" });
    }
    return response;
  }

  const action =
    command.id === "product.model"
      ? "open-model-selector"
      : command.id === "product.effort"
        ? "open-effort-selector"
        : command.id === "product.new"
          ? "start-new-session"
          : command.id === "product.status"
            ? "show-status"
            : "show-help";
  await recordCommand({
    ...eventBase,
    status: "completed",
    summary: command.id === "product.status" ? "Runtime status displayed" : command.title,
  });
  return json({
    invocationId: parsed.data.clientInvocationId,
    commandId: command.id,
    status: "completed",
    action,
    ...(command.id === "product.help" ? { commands: options } : {}),
    ...(command.id === "product.status"
      ? {
          runtime: {
            target: launchSpec.target,
            harness: launchSpec.runtime.harness.value,
            routeId: launchSpec.runtime.routeId.value,
            model: launchSpec.runtime.model.value,
            effort: launchSpec.runtime.effort.value,
            sandboxStatus: state?.sandbox?.status ?? null,
            sessionStatus: state?.status ?? session.status,
          },
        }
      : {}),
  });
}

export const sessionCommandRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/commands"),
    handler: handleCommand,
  }),
]);
