import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  resolvedRuntimeLaunchDraftSchema,
  runtimeConfigFragmentSchema,
  runtimeLaunchTargetSchema,
  runtimeSelectionIssueSchema,
  type ResolvedRuntimeLaunchDraft,
  type ResolveRuntimeLaunchDraftResponse,
  type RuntimeConfigFragment,
  type RuntimeLaunchTarget,
  type RuntimeSelectionIssue,
} from "@open-inspect/shared/types/runtime-launch";
import { z } from "zod";
import type { Env } from "../types";
import type { FeishuConversationCoordinates } from "./store";

const LAUNCH_PENDING_IDLE_TTL_MS = 60 * 60 * 1_000;
const LAUNCH_PENDING_MAX_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

export type FeishuLaunchPhase =
  | "resolving"
  | "configuring"
  | "starting"
  | "active"
  | "failed"
  | "delivery_failed"
  | "stale"
  | "expired";

export type FeishuLaunchView = "summary" | "workspace" | "runtime";

export interface FeishuLaunchIntent {
  target: RuntimeLaunchTarget | null;
  runtime?: RuntimeConfigFragment;
}

export interface FeishuLaunchDraftSnapshot {
  resolverVersion: string;
  capabilityCatalogVersion: string;
  checkedAt: number;
  draftDigest: string;
  launchable: boolean;
  effective: ResolvedRuntimeLaunchDraft;
  issues: RuntimeSelectionIssue[];
}

export interface FeishuLaunchEditor {
  kind: "workspace" | "runtime";
  base: FeishuLaunchIntent;
  draft: FeishuLaunchIntent;
  connectionId?: string;
  connectionPage?: number;
  repositoryPage?: number;
  environmentPage?: number;
  runtimeModelPage?: number;
  multiSelect?: boolean;
}

export interface FeishuLaunchPending extends FeishuConversationCoordinates {
  version: 2;
  pendingId: string;
  incomingMessageId: string;
  actorId: string;
  content: string;
  cardMessageId?: string;
  sessionId?: string;
  phase: FeishuLaunchPhase;
  view: FeishuLaunchView;
  intent: FeishuLaunchIntent;
  editor?: FeishuLaunchEditor;
  draft?: FeishuLaunchDraftSnapshot;
  error?: string;
  selectionRevision: number;
  createdAt: number;
  updatedAt: number;
}

const coordinatesSchema = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  rootMessageId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  replyMode: z.enum(["thread", "flat"]),
});

const intentSchema = z.object({
  target: runtimeLaunchTargetSchema.nullable(),
  runtime: runtimeConfigFragmentSchema.optional(),
});

const launchDraftSnapshotSchema = z.object({
  resolverVersion: z.string().min(1),
  capabilityCatalogVersion: z.string().min(1),
  checkedAt: z.number().finite().nonnegative(),
  draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
  launchable: z.boolean(),
  effective: resolvedRuntimeLaunchDraftSchema,
  issues: z.array(runtimeSelectionIssueSchema),
});

const editorSchema = z.object({
  kind: z.enum(["workspace", "runtime"]),
  base: intentSchema,
  draft: intentSchema,
  connectionId: z.string().min(1).optional(),
  connectionPage: z.number().int().nonnegative().optional(),
  repositoryPage: z.number().int().nonnegative().optional(),
  environmentPage: z.number().int().nonnegative().optional(),
  runtimeModelPage: z.number().int().nonnegative().optional(),
  multiSelect: z.boolean().optional(),
});

const launchPendingSchema: z.ZodType<FeishuLaunchPending> = coordinatesSchema.extend({
  version: z.literal(2),
  pendingId: z.string().uuid(),
  incomingMessageId: z.string().min(1),
  actorId: z.string().min(1),
  content: z.string().trim().min(1),
  cardMessageId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  phase: z.enum([
    "resolving",
    "configuring",
    "starting",
    "active",
    "failed",
    "delivery_failed",
    "stale",
    "expired",
  ]),
  view: z.enum(["summary", "workspace", "runtime"]),
  intent: intentSchema,
  editor: editorSchema.optional(),
  draft: launchDraftSnapshotSchema.optional(),
  error: z.string().optional(),
  selectionRevision: z.number().int().nonnegative(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

function launchPendingKey(pendingId: string): string {
  return `launch-pending:${pendingId}`;
}

async function persistLaunchPending(
  env: Pick<Env, "FEISHU_KV">,
  pending: FeishuLaunchPending
): Promise<void> {
  const now = Date.now();
  const remainingLifetimeMs = pending.createdAt + LAUNCH_PENDING_MAX_LIFETIME_MS - now;
  if (remainingLifetimeMs <= 0) throw new Error("Launch request expired");
  const expirationTtlSeconds = Math.max(
    KV_MIN_EXPIRATION_TTL_SECONDS,
    Math.ceil(Math.min(LAUNCH_PENDING_IDLE_TTL_MS, remainingLifetimeMs) / 1_000)
  );
  await createKvCacheStore(env.FEISHU_KV).put(
    launchPendingKey(pending.pendingId),
    JSON.stringify(launchPendingSchema.parse(pending)),
    { expirationTtl: expirationTtlSeconds }
  );
}

export function snapshotRuntimeDraft(
  draft: ResolveRuntimeLaunchDraftResponse
): FeishuLaunchDraftSnapshot {
  return {
    resolverVersion: draft.resolverVersion,
    capabilityCatalogVersion: draft.capabilityCatalogVersion,
    checkedAt: draft.checkedAt,
    draftDigest: draft.draftDigest,
    launchable: draft.launchable,
    effective: draft.effective,
    issues: draft.issues,
  };
}

export async function createLaunchPending(
  env: Pick<Env, "FEISHU_KV">,
  input: Omit<
    FeishuLaunchPending,
    | "version"
    | "pendingId"
    | "phase"
    | "view"
    | "intent"
    | "selectionRevision"
    | "createdAt"
    | "updatedAt"
  > & { intent?: FeishuLaunchIntent }
): Promise<FeishuLaunchPending> {
  const now = Date.now();
  const pending: FeishuLaunchPending = {
    version: 2,
    pendingId: crypto.randomUUID(),
    ...input,
    phase: "resolving",
    view: "summary",
    intent: input.intent ?? { target: null },
    selectionRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  await persistLaunchPending(env, pending);
  return pending;
}

export async function getLaunchPending(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string
): Promise<FeishuLaunchPending | null> {
  const value = await createKvCacheStore(env.FEISHU_KV).get(launchPendingKey(pendingId), "json");
  const parsed = launchPendingSchema.safeParse(value);
  if (!parsed.success) return null;
  return Date.now() - parsed.data.createdAt < LAUNCH_PENDING_MAX_LIFETIME_MS ? parsed.data : null;
}

export async function updateLaunchPending(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string,
  update: (current: FeishuLaunchPending) => FeishuLaunchPending,
  options: { incrementRevision?: boolean } = {}
): Promise<FeishuLaunchPending | null> {
  const current = await getLaunchPending(env, pendingId);
  if (!current) return null;
  const next = launchPendingSchema.parse({
    ...update(current),
    pendingId: current.pendingId,
    version: 2,
    selectionRevision: current.selectionRevision + (options.incrementRevision === false ? 0 : 1),
    updatedAt: Date.now(),
  });
  await persistLaunchPending(env, next);
  return next;
}

export async function deleteLaunchPending(
  env: Pick<Env, "FEISHU_KV">,
  pendingId: string
): Promise<void> {
  await createKvCacheStore(env.FEISHU_KV).delete(launchPendingKey(pendingId));
}
