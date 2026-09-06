import { describe, expect, it } from "vitest";
import type { ResolveRuntimeLaunchDraftResponse } from "@open-inspect/shared/types/runtime-launch";
import type { FeishuLaunchPending } from "./conversation/launch-store";
import {
  buildLaunchLifecycleCard,
  buildTurnCompletionCard,
  buildTurnWorkingCard,
} from "./launch-cards";

function resolvedDraft(): ResolveRuntimeLaunchDraftResponse {
  const effort = { value: "high", label: "High", nativeValue: "high", isDefault: true };
  const model = {
    model: "openai/gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Fast coding model",
    category: "coding",
    routeId: "codex:openai:subscription",
    provider: "openai",
    enabled: true,
    ready: true,
    efforts: [effort],
    supportsAttachments: true,
    supportsToolEvents: true,
    supportsLiveModelSwitch: true,
  };
  const route = {
    routeId: model.routeId,
    harness: "codex" as const,
    provider: "openai",
    transport: "native" as const,
    displayName: "OpenAI subscription",
    ready: true,
    code: "READY" as const,
    models: [model],
  };
  return {
    resolverVersion: "1",
    capabilityCatalogVersion: "catalog-1",
    checkedAt: 1,
    draftDigest: "a".repeat(64),
    launchable: true,
    effective: {
      target: {
        kind: "repository",
        connectionId: "github-main",
        provider: "github",
        environmentId: null,
        repositories: [
          {
            repositoryKey: "repo-1",
            connectionId: "github-main",
            externalRepositoryId: "1",
            owner: "open-inspect",
            name: "background-agents",
            branch: "main",
            position: 0,
            webUrl: "https://github.com/open-inspect/background-agents",
            cloneUrl: "https://github.com/open-inspect/background-agents.git",
          },
        ],
      },
      harness: {
        value: "codex",
        source: { scope: "integration", id: "feishu" },
        inherited: true,
      },
      routeId: {
        value: model.routeId,
        source: { scope: "installation", id: "default" },
        inherited: true,
      },
      model: {
        value: model.model,
        source: { scope: "integration", id: "feishu" },
        inherited: true,
      },
      effort: {
        value: "high",
        source: { scope: "session", id: null },
        inherited: false,
      },
      nativeEffort: "high",
      settings: {
        allowNetwork: {
          value: true,
          source: { scope: "installation", id: "default" },
          inherited: true,
        },
        profile: {
          value: "safe",
          source: { scope: "installation", id: "default" },
          inherited: true,
        },
        instructions: {
          value: "Be concise",
          source: { scope: "session", id: null },
          inherited: false,
        },
      },
    },
    options: {
      harnesses: [
        {
          harness: "codex",
          displayName: "Codex",
          description: "OpenAI coding agent",
          enabled: true,
          runtimeAvailable: true,
          ready: true,
          settingsSchemaVersion: "1",
          settings: [
            {
              key: "allowNetwork",
              label: "网络访问",
              description: "允许访问公网",
              type: "boolean",
              defaultValue: false,
              allowedScopes: ["session"],
              mutability: "session-start",
              visibility: "user",
              sensitive: false,
            },
            {
              key: "profile",
              label: "配置档",
              description: "选择运行策略",
              type: "enum",
              defaultValue: "safe",
              enumOptions: [
                { value: "safe", label: "安全" },
                { value: "fast", label: "快速" },
              ],
              allowedScopes: ["session"],
              mutability: "session-start",
              visibility: "user",
              sensitive: false,
            },
            {
              key: "instructions",
              label: "附加指令",
              description: "输入本次会话的附加指令",
              type: "string",
              defaultValue: "",
              allowedScopes: ["session"],
              mutability: "session-start",
              visibility: "user",
              sensitive: false,
              constraints: { maxLength: 200 },
            },
          ],
          liveMutation: { model: false, effort: false, settings: [] },
          routes: [route],
        },
      ],
      models: [model],
      efforts: [effort],
      commands: [],
    },
    issues: [],
  };
}

function pending(view: FeishuLaunchPending["view"]): FeishuLaunchPending {
  const draft = resolvedDraft();
  return {
    version: 2,
    pendingId: "00000000-0000-4000-8000-000000000001",
    tenantKey: "tenant",
    chatId: "chat",
    chatType: "p2p",
    rootMessageId: "root",
    replyMode: "flat",
    incomingMessageId: "incoming-secret",
    actorId: "feishu:tenant:user",
    content: "修复不能泄露到 action value 的任务内容",
    cardMessageId: "card-secret",
    phase: "configuring",
    view,
    intent: { target: { kind: "repository", repositoryKey: "repo-1" } },
    ...(view === "runtime"
      ? {
          editor: {
            kind: "runtime" as const,
            base: { target: { kind: "repository" as const, repositoryKey: "repo-1" } },
            draft: { target: { kind: "repository" as const, repositoryKey: "repo-1" } },
          },
        }
      : {}),
    draft: {
      resolverVersion: draft.resolverVersion,
      capabilityCatalogVersion: draft.capabilityCatalogVersion,
      checkedAt: draft.checkedAt,
      draftDigest: draft.draftDigest,
      launchable: draft.launchable,
      effective: draft.effective,
      issues: draft.issues,
    },
    selectionRevision: 3,
    createdAt: 1,
    updatedAt: 1,
  };
}

function actionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(actionValues);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...("value" in record ? [record.value] : []),
    ...Object.values(record).flatMap(actionValues),
  ];
}

function actionGroups(value: unknown): Record<string, unknown>[][] {
  if (Array.isArray(value)) return value.flatMap(actionGroups);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const current =
    record.tag === "column_set" && Array.isArray(record.columns)
      ? [
          (record.columns as Record<string, unknown>[]).flatMap((column) =>
            Array.isArray(column.elements)
              ? (column.elements as Record<string, unknown>[]).filter(
                  (element) => element.tag === "button"
                )
              : []
          ),
        ]
      : [];
  return [...current, ...Object.values(record).flatMap(actionGroups)];
}

function callbackValue(action: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(action.behaviors)) return undefined;
  const behavior = (action.behaviors as Record<string, unknown>[]).find(
    (candidate) => candidate.type === "callback"
  );
  return behavior?.value as Record<string, unknown> | undefined;
}

function taggedComponents(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(taggedComponents);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.tag === "string" ? [record] : []),
    ...Object.values(record).flatMap(taggedComponents),
  ];
}

describe("single-card lifecycle cards", () => {
  it("renders a launchable JSON 2.0 summary without embedding server state in actions", () => {
    const result = buildLaunchLifecycleCard({
      pending: pending("summary"),
      webAppUrl: "https://open-inspect.example",
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      body: { elements: expect.any(Array) },
    });
    expect(serialized).not.toContain('"tag":"action"');
    expect(serialized).not.toContain("wide_screen_mode");
    expect(serialized).toContain('"tag":"column_set"');
    expect(serialized).toContain('"type":"callback"');
    expect(serialized).toContain("开始任务");
    expect(serialized).toContain('"schemaVersion":2');
    const serializedValues = JSON.stringify(actionValues(result));
    expect(serializedValues).not.toContain("incoming-secret");
    expect(serializedValues).not.toContain("card-secret");
    expect(serializedValues).not.toContain("不能泄露到 action value");
    expect(serialized).toContain("路由：codex:openai:subscription");
  });

  it("pins the mutable working-card wire shape to native Card JSON 2.0 components", () => {
    const result = buildTurnWorkingCard({
      sessionId: "session-12345678",
      targetLabel: "open-inspect/background-agents",
      webAppUrl: "https://open-inspect.example",
      harness: "codex",
      routeId: "codex:openai:subscription",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      task: "检查项目",
    });
    const components = taggedComponents((result.body as Record<string, unknown>).elements);
    const buttons = components.filter((component) => component.tag === "button");

    expect({
      schema: result.schema,
      config: result.config,
      componentTags: components.map((component) => component.tag),
      buttons: buttons.map((component) => ({
        type: component.type,
        width: component.width,
        behaviors: component.behaviors,
      })),
    }).toMatchInlineSnapshot(`
      {
        "buttons": [
          {
            "behaviors": [
              {
                "default_url": "https://open-inspect.example/session/session-12345678",
                "type": "open_url",
              },
            ],
            "type": "primary",
            "width": "fill",
          },
        ],
        "componentTags": [
          "markdown",
          "column_set",
          "column",
          "button",
          "plain_text",
        ],
        "config": {
          "update_multi": true,
          "width_mode": "fill",
        },
        "schema": "2.0",
      }
    `);
  });

  it("escapes prompt markdown while preserving the card's own hierarchy", () => {
    const state = pending("summary");
    state.content = "**伪标题** [外部链接](https://evil.example)";
    const serialized = JSON.stringify(
      buildLaunchLifecycleCard({
        pending: state,
        webAppUrl: "https://open-inspect.example",
      })
    );

    expect(serialized).toContain("\\\\*\\\\*伪标题\\\\*\\\\*");
    expect(serialized).not.toContain("[外部链接](https://evil.example)");
  });

  it.each([
    ["resolving", "正在解析"],
    ["starting", "正在创建会话"],
    ["active", "正在工作"],
    ["failed", "无法开始"],
    ["delivery_failed", "请求未送达"],
    ["stale", "状态已变化"],
    ["expired", "卡片已过期"],
  ] as const)("renders the %s lifecycle phase explicitly", (phase, title) => {
    const state = pending("summary");
    state.phase = phase;
    state.sessionId = "session-12345678";
    state.error = "测试错误";
    const serialized = JSON.stringify(
      buildLaunchLifecycleCard({
        pending: state,
        webAppUrl: "https://open-inspect.example",
      })
    );

    expect(serialized).toContain(title);
    if (phase === "active" || phase === "delivery_failed") {
      expect(serialized).toContain("/session/session-12345678");
    }
  });

  it("renders workspace choices on the same card for repository, no-repo, and environment targets", () => {
    const state = pending("workspace");
    state.editor = {
      kind: "workspace",
      base: state.intent,
      draft: state.intent,
      connectionId: "github-main",
      repositoryPage: 0,
    };
    const serialized = JSON.stringify(
      buildLaunchLifecycleCard({
        pending: state,
        catalog: {
          repositories: {
            connections: [
              {
                id: "github-main",
                label: "GitHub",
                provider: "github",
                repositoryCount: 1,
                catalogStatus: "available",
              },
            ],
            targets: [
              {
                repositoryKey: "repo-1",
                fullName: "open-inspect/background-agents",
                displayName: "background-agents",
                provider: "github",
                connectionId: "github-main",
                connectionLabel: "GitHub",
                defaultBranch: "main",
              },
            ],
          },
          environments: [
            {
              environmentId: "env-1",
              name: "集成测试环境",
              repositoryKeys: ["repo-1"],
            },
          ],
          recentRepositoryKeys: ["repo-1"],
        },
        webAppUrl: "https://open-inspect.example",
      })
    );

    expect(serialized).toContain("临时工作区");
    expect(serialized).toContain("最近使用");
    expect(serialized).toContain("open-inspect/background-agents");
    expect(serialized).toContain("集成测试环境");
    expect(serialized).toContain("应用工作区");
  });

  it("keeps large connection and environment catalogs reachable with in-place pagination", () => {
    const state = pending("workspace");
    state.editor = {
      kind: "workspace",
      base: state.intent,
      draft: state.intent,
      connectionId: "connection-5",
      connectionPage: 1,
      repositoryPage: 0,
      environmentPage: 1,
    };
    const result = buildLaunchLifecycleCard({
      pending: state,
      catalog: {
        repositories: {
          connections: Array.from({ length: 6 }, (_, index) => ({
            id: `connection-${index + 1}`,
            label: `代码源 ${index + 1}`,
            provider: "github" as const,
            repositoryCount: 0,
            catalogStatus: "available" as const,
          })),
          targets: [],
        },
        environments: Array.from({ length: 6 }, (_, index) => ({
          environmentId: `environment-${index + 1}`,
          name: `环境 ${index + 1}`,
          repositoryKeys: [`repository-${index + 1}`],
        })),
      },
      webAppUrl: "https://open-inspect.example",
    });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("代码源 5");
    expect(serialized).not.toContain("代码源 1");
    expect(serialized).toContain("上一组代码源");
    expect(serialized).toContain("环境 5");
    expect(serialized).not.toContain("环境 1");
    expect(serialized).toContain("上一组环境");
  });

  it("renders user-visible session-start settings as buttons and an inline form", () => {
    const draft = resolvedDraft();
    const result = buildLaunchLifecycleCard({
      pending: pending("runtime"),
      catalog: {
        repositories: { connections: [], targets: [] },
        environments: [],
        runtimeOptions: draft.options,
      },
      webAppUrl: "https://open-inspect.example",
    });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("网络访问");
    expect(serialized).toContain("set_runtime_setting");
    expect(serialized).toContain('"tag":"form"');
    expect(serialized).toContain('"form_action_type":"submit"');
    expect(serialized).toContain('"name":"runtime_setting_0"');
    expect(serialized).toContain("Be concise");
  });

  it("renders every Harness as a separate touch-friendly row", () => {
    const draft = resolvedDraft();
    draft.options.harnesses.push({
      ...draft.options.harnesses[0]!,
      harness: "claude",
      displayName: "Claude Code",
      routes: [],
    });
    const result = buildLaunchLifecycleCard({
      pending: pending("runtime"),
      catalog: {
        repositories: { connections: [], targets: [] },
        environments: [],
        runtimeOptions: draft.options,
      },
      webAppUrl: "https://open-inspect.example",
    });
    const harnessGroups = actionGroups(result).filter((actions) =>
      actions.some((action) => {
        const value = callbackValue(action);
        return value?.action === "set_runtime_field" && value.field === "harness";
      })
    );

    expect(harnessGroups).toHaveLength(2);
    expect(harnessGroups.every((actions) => actions.length === 1)).toBe(true);
  });

  it("keeps unavailable runtime options visible with their server-provided reason", () => {
    const draft = resolvedDraft();
    draft.options.models.push({
      ...draft.options.models[0]!,
      model: "openai/unavailable-model",
      displayName: "Unavailable model",
      ready: false,
      disabledReason: "缺少可用凭据",
    });
    const result = buildLaunchLifecycleCard({
      pending: pending("runtime"),
      catalog: {
        repositories: { connections: [], targets: [] },
        environments: [],
        runtimeOptions: draft.options,
      },
      webAppUrl: "https://open-inspect.example",
    });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("Unavailable model（不可用）");
    expect(serialized).toContain("缺少可用凭据");
    expect(serialized).toContain('"disabled":true');
  });

  it("updates the same turn surface to a completion card", () => {
    const result = buildTurnCompletionCard({
      sessionId: "session-12345678",
      targetLabel: "open-inspect/background-agents",
      textContent: "Done",
      success: true,
      webAppUrl: "https://open-inspect.example",
      routeId: "codex:openai:subscription",
      model: "openai/gpt-5.6-luna",
    });

    expect(result).toMatchObject({
      schema: "2.0",
      config: { update_multi: true, width_mode: "fill" },
      header: { template: "green" },
    });
    expect(JSON.stringify(result)).toContain("/session/session-12345678");
    expect(JSON.stringify(result)).toContain("codex:openai:subscription");
    expect(JSON.stringify(result)).toContain('"type":"open_url"');
  });
});
