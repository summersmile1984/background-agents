import type { VisualVerificationReport } from "@open-inspect/shared/types/visual-verification";
import type {
  ResolveRuntimeLaunchDraftResponse,
  RuntimeHarnessOption,
  RuntimeLaunchTarget,
  RuntimeModelOption,
} from "@open-inspect/shared/types/runtime-launch";
import type { FeishuCard } from "./feishu/client";
import type {
  FeishuLaunchIntent,
  FeishuLaunchPending,
  FeishuLaunchView,
} from "./conversation/launch-store";
import { sessionShortId } from "./conversation/session-short-id";
import type {
  FeishuEnvironmentTarget,
  FeishuRepositoryCatalog,
  FeishuRepositoryTarget,
} from "./targets";

export const LAUNCH_REPOSITORIES_PER_PAGE = 5;
export const LAUNCH_CONNECTIONS_PER_PAGE = 4;
export const LAUNCH_ENVIRONMENTS_PER_PAGE = 4;
export const LAUNCH_MODELS_PER_PAGE = 6;

type CardElement = Record<string, unknown>;

export interface LaunchCardCatalog {
  repositories: FeishuRepositoryCatalog;
  environments: FeishuEnvironmentTarget[];
  runtimeOptions?: ResolveRuntimeLaunchDraftResponse["options"];
  recentRepositoryKeys?: string[];
}

function plainText(content: string): { tag: "plain_text"; content: string } {
  return { tag: "plain_text", content };
}

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

function actionValue(
  pending: FeishuLaunchPending,
  action: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    action,
    pendingId: pending.pendingId,
    selectionRevision: pending.selectionRevision,
    ...extra,
  };
}

function button(
  pending: FeishuLaunchPending,
  label: string,
  action: string,
  options: {
    type?: "default" | "primary" | "danger";
    argument?: string;
    field?: string;
    url?: string;
    disabled?: boolean;
  } = {}
): CardElement {
  const behavior = options.url
    ? { type: "open_url", default_url: options.url }
    : {
        type: "callback",
        value: actionValue(pending, action, {
          ...(options.argument !== undefined ? { argument: options.argument } : {}),
          ...(options.field ? { field: options.field } : {}),
        }),
      };
  return {
    tag: "button",
    text: plainText(label),
    type: options.type ?? "default",
    width: "fill",
    ...(options.disabled ? { disabled: true } : {}),
    behaviors: [behavior],
  };
}

function linkButton(
  label: string,
  url: string,
  type: "default" | "primary" | "danger" = "default"
): CardElement {
  return {
    tag: "button",
    text: plainText(label),
    type,
    width: "fill",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

function actionRow(actions: CardElement[]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "stretch",
    horizontal_spacing: "medium",
    columns: actions.map((action) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [action],
    })),
  };
}

function actionRows(actions: CardElement[], perRow: number): CardElement[] {
  const rows: CardElement[] = [];
  for (let index = 0; index < actions.length; index += perRow) {
    rows.push(actionRow(actions.slice(index, index + perRow)));
  }
  return rows;
}

function card(
  title: string,
  template: "blue" | "green" | "red" | "orange" | "grey",
  elements: CardElement[]
): FeishuCard {
  return {
    schema: "2.0",
    // Feishu requires update_multi on both the original and replacement card
    // before PATCH will update a shared message for every recipient.
    config: { width_mode: "fill", update_multi: true },
    header: { template, title: plainText(title) },
    body: { elements },
  };
}

function excerpt(content: string, max = 160): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function escapedTaskExcerpt(content: string): string {
  return excerpt(content).replace(/([\\`*_[\]()~>#+=|{}])/g, "\\$1");
}

function targetLabel(
  target: RuntimeLaunchTarget | null,
  pending: FeishuLaunchPending,
  catalog?: LaunchCardCatalog
): string {
  const snapshot = pending.draft?.effective.target;
  if (!target) return "尚未选择";
  if (target.kind === "none") return "临时工作区（无仓库）";
  if (target.kind === "environment") {
    const environment = catalog?.environments.find(
      (candidate) => candidate.environmentId === target.environmentId
    );
    return `环境 · ${environment?.name ?? target.environmentId}`;
  }
  const targetKeys = target.kind === "repository" ? [target.repositoryKey] : target.repositoryKeys;
  const catalogNames = targetKeys.flatMap((key) => {
    const repository = catalog?.repositories.targets.find(
      (candidate) => candidate.repositoryKey === key
    );
    return repository ? [repository.fullName] : [];
  });
  if (catalogNames.length === targetKeys.length) {
    return catalogNames.length === 1
      ? catalogNames[0]!
      : `${catalogNames[0]} 等 ${catalogNames.length} 个仓库`;
  }
  const repositories = snapshot?.repositories ?? [];
  const snapshotKeys = repositories.map((repository) => repository.repositoryKey);
  const snapshotMatches =
    snapshotKeys.length === targetKeys.length &&
    targetKeys.every((key) => snapshotKeys.includes(key));
  if (!snapshotMatches) {
    return target.kind === "repository"
      ? target.repositoryKey
      : `${target.repositoryKeys.length} 个仓库`;
  }
  const primary = `${repositories[0]!.owner}/${repositories[0]!.name}`;
  return repositories.length === 1 ? primary : `${primary} 等 ${repositories.length} 个仓库`;
}

function sourceLabel(scope: string): string {
  switch (scope) {
    case "installation":
      return "安装默认";
    case "integration":
      return "飞书默认";
    case "user":
      return "用户偏好";
    case "repository":
      return "仓库默认";
    case "environment":
      return "环境默认";
    case "session":
      return "本次覆盖";
    default:
      return scope;
  }
}

function runtimeSummary(pending: FeishuLaunchPending): string {
  const effective = pending.draft?.effective;
  if (!effective?.harness || !effective.routeId || !effective.model) return "等待解析";
  const effort = effective.effort?.value ?? "模型默认";
  const sources = [effective.harness, effective.model, effective.effort]
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .map((value) => sourceLabel(value.source.scope));
  const provenance = [...new Set(sources)].join(" / ");
  return `${effective.harness.value} · ${effective.model.value} · ${effort}\n路由：${effective.routeId.value}\n来源：${provenance}`;
}

function issues(pending: FeishuLaunchPending): CardElement[] {
  const messages = (pending.draft?.issues ?? []).slice(0, 4).map((issue) => {
    const icon = issue.severity === "error" ? "❌" : "⚠️";
    return `${icon} ${issue.message}`;
  });
  if (pending.error) messages.unshift(`❌ ${pending.error}`);
  return messages.length ? [markdown(messages.join("\n"))] : [];
}

function selectedIntent(pending: FeishuLaunchPending): FeishuLaunchIntent {
  return pending.editor?.draft ?? pending.intent;
}

function summaryElements(pending: FeishuLaunchPending): CardElement[] {
  const target = pending.intent.target;
  const elements: CardElement[] = [
    markdown(`**任务**\n${escapedTaskExcerpt(pending.content)}`),
    markdown(`**工作区**\n${targetLabel(target, pending)}`),
    markdown(`**Runtime**\n${runtimeSummary(pending)}`),
    ...issues(pending),
  ];
  if (pending.phase !== "configuring") return elements;
  elements.push(
    actionRow([
      button(pending, "更换工作区", "open_workspace"),
      button(pending, "调整 Runtime", "open_runtime"),
    ])
  );
  if (target && pending.draft?.launchable) {
    elements.push(actionRow([button(pending, "开始任务", "start_session", { type: "primary" })]));
  } else if (!target) {
    elements.push(markdown("请选择工作区后再开始任务。"));
  }
  return elements;
}

function repositoryTargetKeys(intent: FeishuLaunchIntent): string[] {
  if (intent.target?.kind === "repository") return [intent.target.repositoryKey];
  if (intent.target?.kind === "repository-set") return intent.target.repositoryKeys;
  return [];
}

function connectionRepositories(
  pending: FeishuLaunchPending,
  catalog: FeishuRepositoryCatalog
): {
  connectionId?: string;
  repositories: FeishuRepositoryTarget[];
  page: number;
  pageCount: number;
} {
  const editor = pending.editor;
  const connectionId = editor?.connectionId ?? catalog.connections[0]?.id;
  const repositories = connectionId
    ? catalog.targets.filter((target) => target.connectionId === connectionId)
    : catalog.targets;
  const pageCount = Math.max(1, Math.ceil(repositories.length / LAUNCH_REPOSITORIES_PER_PAGE));
  const page = Math.min(editor?.repositoryPage ?? 0, pageCount - 1);
  return { connectionId, repositories, page, pageCount };
}

function workspaceElements(
  pending: FeishuLaunchPending,
  catalog: LaunchCardCatalog
): CardElement[] {
  const editor = pending.editor;
  const intent = selectedIntent(pending);
  const { connectionId, repositories, page, pageCount } = connectionRepositories(
    pending,
    catalog.repositories
  );
  const selected = new Set(repositoryTargetKeys(intent));
  const visible = repositories.slice(
    page * LAUNCH_REPOSITORIES_PER_PAGE,
    (page + 1) * LAUNCH_REPOSITORIES_PER_PAGE
  );
  const recent = (catalog.recentRepositoryKeys ?? [])
    .flatMap((key) => {
      const repository = catalog.repositories.targets.find(
        (candidate) => candidate.repositoryKey === key
      );
      return repository ? [repository] : [];
    })
    .slice(0, 3);
  const elements: CardElement[] = [
    markdown(
      `**当前选择**\n${targetLabel(
        intent.target,
        { ...pending, intent } as FeishuLaunchPending,
        catalog
      )}`
    ),
    actionRow([
      button(pending, "临时工作区", "set_target", { argument: "none" }),
      button(pending, editor?.multiSelect ? "完成多仓库选择" : "选择多个仓库", "toggle_multi_mode"),
    ]),
  ];
  if (!editor?.multiSelect && recent.length) {
    elements.push(
      markdown("**最近使用**"),
      ...recent.map((repository) =>
        actionRow([
          button(
            pending,
            `${selected.has(repository.repositoryKey) ? "✓ " : ""}${repository.provider} · ${repository.fullName}`,
            "set_target",
            { argument: `repository:${repository.repositoryKey}` }
          ),
        ])
      )
    );
  }
  if (catalog.repositories.connections.length > 1) {
    const connectionPageCount = Math.max(
      1,
      Math.ceil(catalog.repositories.connections.length / LAUNCH_CONNECTIONS_PER_PAGE)
    );
    const connectionPage = Math.min(editor?.connectionPage ?? 0, connectionPageCount - 1);
    const visibleConnections = catalog.repositories.connections.slice(
      connectionPage * LAUNCH_CONNECTIONS_PER_PAGE,
      (connectionPage + 1) * LAUNCH_CONNECTIONS_PER_PAGE
    );
    elements.push(
      markdown("**代码源**"),
      ...actionRows(
        visibleConnections.map((connection) =>
          button(
            pending,
            `${connection.id === connectionId ? "✓ " : ""}${connection.label}`,
            "select_connection",
            { argument: connection.id }
          )
        ),
        2
      )
    );
    const connectionPages: CardElement[] = [];
    if (connectionPage > 0) {
      connectionPages.push(
        button(pending, "上一组代码源", "connection_page", {
          argument: String(connectionPage - 1),
        })
      );
    }
    if (connectionPage + 1 < connectionPageCount) {
      connectionPages.push(
        button(pending, "下一组代码源", "connection_page", {
          argument: String(connectionPage + 1),
        })
      );
    }
    if (connectionPages.length) elements.push(actionRow(connectionPages));
  }
  if (catalog.environments.length > 0) {
    const environmentPageCount = Math.max(
      1,
      Math.ceil(catalog.environments.length / LAUNCH_ENVIRONMENTS_PER_PAGE)
    );
    const environmentPage = Math.min(editor?.environmentPage ?? 0, environmentPageCount - 1);
    const visibleEnvironments = catalog.environments.slice(
      environmentPage * LAUNCH_ENVIRONMENTS_PER_PAGE,
      (environmentPage + 1) * LAUNCH_ENVIRONMENTS_PER_PAGE
    );
    elements.push(
      markdown("**环境**"),
      ...visibleEnvironments.map((environment) =>
        actionRow([
          button(pending, `环境 · ${environment.name}`, "set_target", {
            argument: `environment:${environment.environmentId}`,
          }),
        ])
      )
    );
    const environmentPages: CardElement[] = [];
    if (environmentPage > 0) {
      environmentPages.push(
        button(pending, "上一组环境", "environment_page", {
          argument: String(environmentPage - 1),
        })
      );
    }
    if (environmentPage + 1 < environmentPageCount) {
      environmentPages.push(
        button(pending, "下一组环境", "environment_page", {
          argument: String(environmentPage + 1),
        })
      );
    }
    if (environmentPages.length) elements.push(actionRow(environmentPages));
  }
  elements.push(
    markdown(editor?.multiSelect ? "**仓库（可多选，同一代码源）**" : "**全部仓库**"),
    ...visible.map((repository) =>
      actionRow([
        button(
          pending,
          `${selected.has(repository.repositoryKey) ? "✓ " : ""}${repository.provider} · ${repository.fullName}`,
          editor?.multiSelect ? "toggle_repository" : "set_target",
          {
            argument: editor?.multiSelect
              ? repository.repositoryKey
              : `repository:${repository.repositoryKey}`,
          }
        ),
      ])
    )
  );
  const pages: CardElement[] = [];
  if (page > 0)
    pages.push(button(pending, "上一页", "repository_page", { argument: String(page - 1) }));
  if (page + 1 < pageCount)
    pages.push(button(pending, "下一页", "repository_page", { argument: String(page + 1) }));
  if (pages.length) elements.push(actionRow(pages), markdown(`第 ${page + 1}/${pageCount} 页`));
  elements.push(
    actionRow([
      ...(editor?.base.target ? [button(pending, "取消", "cancel_editor")] : []),
      button(pending, "应用工作区", "apply_editor", {
        type: "primary",
        disabled: !intent.target,
      }),
    ])
  );
  return elements;
}

function effectiveHarness(pending: FeishuLaunchPending): string | undefined {
  const requested = selectedIntent(pending).runtime?.harness;
  return requested && requested !== "inherit" ? requested : pending.draft?.effective.harness?.value;
}

function effectiveModel(pending: FeishuLaunchPending): string | undefined {
  const requested = selectedIntent(pending).runtime?.model;
  return requested && requested !== "inherit" ? requested : pending.draft?.effective.model?.value;
}

function harnessModels(
  harness: RuntimeHarnessOption | undefined,
  options: ResolveRuntimeLaunchDraftResponse["options"] | undefined
): RuntimeModelOption[] {
  if (!harness || !options) return [];
  const harnessRouteIds = new Set(harness.routes.map((route) => route.routeId));
  return options.models.filter((model) => harnessRouteIds.has(model.routeId));
}

function settingValue(pending: FeishuLaunchPending, key: string, fallback: unknown): unknown {
  const override = selectedIntent(pending).runtime?.settings?.[key];
  if (override !== undefined) return override;
  return pending.draft?.effective.settings[key]?.value ?? fallback;
}

function settingTextValue(value: unknown, type: string): string {
  if (type === "string-list" && Array.isArray(value)) return value.join("\n");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function runtimeSettingsElements(
  pending: FeishuLaunchPending,
  settings: RuntimeHarnessOption["settings"]
): CardElement[] {
  const editable = settings.filter(
    (setting) =>
      !setting.sensitive && setting.visibility === "user" && setting.mutability === "session-start"
  );
  if (!editable.length) return [];
  const choiceSettings = editable.filter((setting) => ["boolean", "enum"].includes(setting.type));
  const inputSettings = editable.filter((setting) =>
    ["string", "integer", "string-list"].includes(setting.type)
  );
  const elements: CardElement[] = [markdown("**启动设置**")];
  for (const setting of choiceSettings) {
    const current = settingValue(pending, setting.key, setting.defaultValue);
    const choices =
      setting.type === "boolean"
        ? [
            { value: "true", label: "开启", typedValue: true },
            { value: "false", label: "关闭", typedValue: false },
          ]
        : (setting.enumOptions ?? []).map((option) => ({
            ...option,
            typedValue: option.value,
          }));
    elements.push(
      markdown(`**${setting.label}**\n${setting.description}`),
      ...actionRows(
        choices.map((choice) =>
          button(
            pending,
            `${Object.is(current, choice.typedValue) ? "✓ " : ""}${choice.label}`,
            "set_runtime_setting",
            { field: setting.key, argument: choice.value }
          )
        ),
        3
      )
    );
  }
  if (inputSettings.length) {
    const formElements: CardElement[] = inputSettings.map((setting, index) => {
      const maxLength = Number(setting.constraints?.maxLength);
      return {
        tag: "input",
        name: `runtime_setting_${index}`,
        required: false,
        input_type: setting.type === "string-list" ? "multiline_text" : "text",
        ...(setting.type === "string-list" ? { rows: 3, auto_resize: true, max_rows: 6 } : {}),
        label: plainText(setting.label),
        label_position: "top",
        placeholder: plainText(setting.description.slice(0, 100)),
        default_value: settingTextValue(
          settingValue(pending, setting.key, setting.defaultValue),
          setting.type
        ),
        width: "fill",
        ...(Number.isInteger(maxLength) && maxLength >= 1 && maxLength <= 1_000
          ? { max_length: maxLength }
          : {}),
      };
    });
    formElements.push({
      tag: "button",
      name: "apply_runtime_settings",
      form_action_type: "submit",
      text: plainText("保存启动设置"),
      type: "primary",
      width: "fill",
      behaviors: [
        {
          type: "callback",
          value: actionValue(pending, "apply_runtime_settings"),
        },
      ],
    });
    elements.push({ tag: "form", name: "runtime_settings_form", elements: formElements });
  }
  return elements;
}

function runtimeElements(
  pending: FeishuLaunchPending,
  options: ResolveRuntimeLaunchDraftResponse["options"] | undefined
): CardElement[] {
  const harnessName = effectiveHarness(pending);
  const selectedHarness = options?.harnesses.find((item) => item.harness === harnessName);
  const models = harnessModels(selectedHarness, options);
  const pageCount = Math.max(1, Math.ceil(models.length / LAUNCH_MODELS_PER_PAGE));
  const page = Math.min(pending.editor?.runtimeModelPage ?? 0, pageCount - 1);
  const visibleModels = models.slice(
    page * LAUNCH_MODELS_PER_PAGE,
    (page + 1) * LAUNCH_MODELS_PER_PAGE
  );
  const modelName = effectiveModel(pending);
  const routeId =
    selectedIntent(pending).runtime?.routeId ?? pending.draft?.effective.routeId?.value;
  const selectedModel = models.find(
    (model) => model.model === modelName && (!routeId || model.routeId === routeId)
  );
  const elements: CardElement[] = [markdown(`**当前 Runtime**\n${runtimeSummary(pending)}`)];
  if (options) {
    elements.push(
      markdown("**Harness**"),
      ...actionRows(
        options.harnesses
          .slice(0, 6)
          .map((harness) =>
            harness.ready
              ? button(
                  pending,
                  `${harness.harness === harnessName ? "✓ " : ""}${harness.displayName}`,
                  "set_runtime_field",
                  { field: "harness", argument: harness.harness }
                )
              : button(pending, `${harness.displayName}（不可用）`, "noop", { disabled: true })
          ),
        1
      )
    );
    const unavailableHarnesses = options.harnesses.filter(
      (harness) => !harness.ready && harness.disabledReason
    );
    if (unavailableHarnesses.length) {
      elements.push(
        markdown(
          unavailableHarnesses
            .slice(0, 3)
            .map((harness) => `${harness.displayName}：${harness.disabledReason}`)
            .join("\n")
        )
      );
    }
    if (visibleModels.length) {
      elements.push(
        markdown("**模型**"),
        ...visibleModels.map((model) =>
          actionRow([
            model.ready
              ? button(
                  pending,
                  `${model.model === modelName && model.routeId === routeId ? "✓ " : ""}${model.displayName} · ${
                    selectedHarness?.routes.find((route) => route.routeId === model.routeId)
                      ?.displayName ?? model.provider
                  }`,
                  "set_runtime_field",
                  { field: "model", argument: JSON.stringify([model.routeId, model.model]) }
                )
              : button(pending, `${model.displayName}（不可用）`, "noop", { disabled: true }),
          ])
        )
      );
      const unavailableModels = visibleModels.filter(
        (model) => !model.ready && model.disabledReason
      );
      if (unavailableModels.length) {
        elements.push(
          markdown(
            unavailableModels
              .map((model) => `${model.displayName}：${model.disabledReason}`)
              .join("\n")
          )
        );
      }
      const pages: CardElement[] = [];
      if (page > 0)
        pages.push(button(pending, "上一页", "runtime_model_page", { argument: String(page - 1) }));
      if (page + 1 < pageCount)
        pages.push(button(pending, "下一页", "runtime_model_page", { argument: String(page + 1) }));
      if (pages.length) elements.push(actionRow(pages));
    }
    if (selectedModel?.efforts.length) {
      const effort =
        selectedIntent(pending).runtime?.effort ?? pending.draft?.effective.effort?.value;
      elements.push(
        markdown("**Effort**"),
        ...actionRows(
          selectedModel.efforts.map((option) =>
            button(
              pending,
              `${option.value === effort ? "✓ " : ""}${option.label}`,
              "set_runtime_field",
              { field: "effort", argument: option.value }
            )
          ),
          3
        )
      );
    }
    if (selectedHarness)
      elements.push(...runtimeSettingsElements(pending, selectedHarness.settings));
  } else {
    elements.push(markdown("正在读取当前目标可用的 Runtime 选项…"));
  }
  elements.push(
    ...issues(pending),
    actionRow([
      button(pending, "恢复目标默认", "reset_runtime"),
      button(pending, "取消", "cancel_editor"),
      button(pending, "应用 Runtime", "apply_editor", { type: "primary" }),
    ])
  );
  return elements;
}

function phaseCard(pending: FeishuLaunchPending, webAppUrl: string): FeishuCard | null {
  if (pending.phase === "resolving") {
    return card("Open-Inspect · 正在解析", "blue", [
      markdown(
        `**任务**\n${escapedTaskExcerpt(pending.content)}\n\n正在解析工作区和 Runtime，请稍候…`
      ),
    ]);
  }
  if (pending.phase === "starting") {
    return card("Open-Inspect · 正在创建会话", "orange", [
      ...summaryElements(pending),
      markdown("配置已经锁定，正在创建 session 并调度 VM。"),
    ]);
  }
  if (pending.phase === "active") {
    const elements = [...summaryElements(pending), markdown("状态：**任务执行中**")];
    if (pending.sessionId) {
      elements.push(
        actionRow([
          button(pending, "打开 Web 会话", "open_web", {
            url: `${webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(pending.sessionId)}`,
          }),
        ])
      );
    }
    return card(
      `Open-Inspect 正在工作${pending.sessionId ? ` · #${sessionShortId(pending.sessionId)}` : ""}`,
      "blue",
      elements
    );
  }
  if (["failed", "delivery_failed", "stale", "expired"].includes(pending.phase)) {
    const title =
      pending.phase === "delivery_failed"
        ? "Open-Inspect · 请求未送达"
        : pending.phase === "stale"
          ? "Open-Inspect · 状态已变化"
          : pending.phase === "expired"
            ? "Open-Inspect · 卡片已过期"
            : "Open-Inspect · 无法开始";
    return card(title, "red", [
      ...summaryElements(pending),
      markdown(pending.error || "任务状态已经失效，请重新发送任务。"),
      ...(pending.sessionId
        ? [
            actionRow([
              button(pending, "打开 Web 会话", "open_web", {
                url: `${webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(pending.sessionId)}`,
              }),
            ]),
          ]
        : []),
      ...(pending.phase === "stale"
        ? [actionRow([button(pending, "重新解析", "retry_resolve", { type: "primary" })])]
        : []),
    ]);
  }
  return null;
}

export function buildLaunchLifecycleCard(input: {
  pending: FeishuLaunchPending;
  catalog?: LaunchCardCatalog;
  webAppUrl: string;
}): FeishuCard {
  const phase = phaseCard(input.pending, input.webAppUrl);
  if (phase) return phase;
  const view: FeishuLaunchView = input.pending.view;
  const elements =
    view === "workspace" && input.catalog
      ? workspaceElements(input.pending, input.catalog)
      : view === "runtime"
        ? runtimeElements(input.pending, input.catalog?.runtimeOptions)
        : summaryElements(input.pending);
  return card(
    view === "workspace"
      ? "Open-Inspect · 选择工作区"
      : view === "runtime"
        ? "Open-Inspect · 调整 Runtime"
        : "Open-Inspect · 准备开始",
    input.pending.draft?.launchable ? "blue" : "orange",
    elements
  );
}

export function buildTurnCompletionCard(input: {
  sessionId: string;
  targetLabel: string;
  textContent: string;
  success: boolean;
  error?: string;
  webAppUrl: string;
  pullRequestUrl?: string;
  previewUrl?: string;
  visualVerification?: VisualVerificationReport;
  branch?: string;
  harness?: string;
  routeId?: string;
  model?: string;
  reasoningEffort?: string;
}): FeishuCard {
  const details = [
    `目标：**${input.targetLabel}**`,
    input.branch ? `分支：\`${input.branch}\`` : undefined,
    input.harness ? `Harness：\`${input.harness}\`` : undefined,
    input.routeId ? `路由：\`${input.routeId}\`` : undefined,
    input.model ? `模型：\`${input.model}\`` : undefined,
    input.reasoningEffort ? `Effort：\`${input.reasoningEffort}\`` : undefined,
    "",
    input.success
      ? excerpt(input.textContent || "Agent 已完成。请打开 Web 会话查看详细记录。", 3_000)
      : `运行失败：${input.error || "未知错误"}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  const actions: CardElement[] = [
    linkButton(
      "打开 Web 会话",
      `${input.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}`,
      "primary"
    ),
  ];
  if (input.pullRequestUrl) actions.push(linkButton("查看 PR", input.pullRequestUrl));
  if (input.previewUrl) actions.push(linkButton("打开预览", input.previewUrl));
  const verification = input.visualVerification;
  const verificationText = verification
    ? `视觉验证：${verification.status}${verification.scenarios.length ? ` · ${verification.scenarios.length} 个场景` : ""}`
    : undefined;
  return card(
    `${input.success ? "Open-Inspect 已完成" : "Open-Inspect 运行失败"} · #${sessionShortId(input.sessionId)}`,
    input.success ? "green" : "red",
    [
      markdown(details),
      ...(verificationText ? [markdown(verificationText)] : []),
      actionRow(actions),
    ]
  );
}

export function buildTurnWorkingCard(input: {
  sessionId: string;
  targetLabel: string;
  webAppUrl: string;
  branch?: string;
  harness?: string;
  routeId?: string;
  model: string;
  reasoningEffort?: string;
  task: string;
}): FeishuCard {
  const runtime = [input.harness, input.routeId, input.model, input.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
  return card(`Open-Inspect 正在工作 · #${sessionShortId(input.sessionId)}`, "blue", [
    markdown(
      `**任务**\n${escapedTaskExcerpt(input.task)}\n\n**目标**\n${input.targetLabel}${
        input.branch ? ` · \`${input.branch}\`` : ""
      }\n\n**Runtime**\n${runtime}\n\n状态：**任务执行中**`
    ),
    actionRow([
      linkButton(
        "打开 Web 会话",
        `${input.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}`,
        "primary"
      ),
    ]),
  ]);
}
