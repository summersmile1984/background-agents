import type { FeishuCard } from "./feishu/client";
import type { VisualVerificationReport } from "@open-inspect/shared/types/visual-verification";
import type { FeishuRepositoryConnection, FeishuRepositoryTarget } from "./targets";
import type {
  RuntimeCommandOption,
  RuntimeHarnessOption,
  RuntimeModelOption,
} from "@open-inspect/shared/types/runtime-launch";
import { sessionShortId } from "./conversation/session-short-id";

export { sessionShortId } from "./conversation/session-short-id";

// Keep mobile cards short enough to scroll comfortably. Repository selection
// uses buttons instead of select_static because Feishu's mobile selector opens
// a searchable bottom sheet whose keyboard can cover the available actions.
export const REPOSITORIES_PER_PAGE = 6;
export const RUNTIME_MODELS_PER_PAGE = 8;
const SESSION_LIST_LIMIT = 12;

function stateLabel(
  state: "starting" | "active" | "delivery_failed" | "completed" | "failed" | "stale" | undefined
): string {
  switch (state) {
    case "starting":
      return "正在启动";
    case "active":
      return "工作中";
    case "completed":
      return "已完成";
    case "delivery_failed":
      return "请求未送达";
    case "failed":
      return "失败";
    case "stale":
      return "已失效";
    default:
      return "状态未知";
  }
}

function text(content: string): { tag: "plain_text"; content: string } {
  return { tag: "plain_text", content };
}

function title(
  content: string,
  template: "blue" | "green" | "red" | "orange" = "blue"
): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: text(content) },
    elements: [],
  };
}

function elements(card: FeishuCard): Record<string, unknown>[] {
  return card.elements as Record<string, unknown>[];
}

function buttonRow(input: {
  label: string;
  value: Record<string, unknown>;
  type?: "default" | "primary";
}): Record<string, unknown> {
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: text(input.label),
        type: input.type ?? "default",
        value: input.value,
      },
    ],
  };
}

export function buildConnectionPickerCard(input: {
  pendingId: string;
  connections: FeishuRepositoryConnection[];
  selectionRevision?: number;
}): FeishuCard {
  const card = title("选择代码源");
  const selectionRevision = input.selectionRevision ?? 0;
  elements(card).push(
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "先点选代码源；下一步会显示该代码源的仓库。手机端无需打开搜索框。",
      },
    },
    ...input.connections.map((connection) =>
      buttonRow({
        label:
          connection.catalogStatus === "refreshing"
            ? `${connection.label} · ${connection.provider}（目录刷新中）`
            : `${connection.label} · ${connection.provider} (${connection.repositoryCount} 个仓库)`,
        value: {
          action: "select_connection",
          pendingId: input.pendingId,
          connectionId: connection.id,
          selectionRevision,
        },
      })
    )
  );
  return card;
}

export function buildRepositoryPickerCard(input: {
  pendingId: string;
  connection: FeishuRepositoryConnection;
  repositories: FeishuRepositoryTarget[];
  page: number;
  selectionRevision?: number;
}): FeishuCard {
  const pageCount = Math.max(1, Math.ceil(input.repositories.length / REPOSITORIES_PER_PAGE));
  const page = Math.min(Math.max(0, input.page), pageCount - 1);
  const offset = page * REPOSITORIES_PER_PAGE;
  const visible = input.repositories.slice(offset, offset + REPOSITORIES_PER_PAGE);
  const selectionRevision = input.selectionRevision ?? 0;
  const card = title(`选择 ${input.connection.label} 仓库`);
  const navigationActions: Record<string, unknown>[] = [];
  if (page > 0) {
    navigationActions.push({
      tag: "button",
      text: text("上一页"),
      type: "default",
      value: {
        action: "repository_page",
        pendingId: input.pendingId,
        connectionId: input.connection.id,
        page: page - 1,
        selectionRevision,
      },
    });
  }
  if (page + 1 < pageCount) {
    navigationActions.push({
      tag: "button",
      text: text("下一页"),
      type: "default",
      value: {
        action: "repository_page",
        pendingId: input.pendingId,
        connectionId: input.connection.id,
        page: page + 1,
        selectionRevision,
      },
    });
  }
  elements(card).push(
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `代码源：**${input.connection.label}** · ${input.connection.repositoryCount} 个仓库 · 第 ${page + 1}/${pageCount} 页\n\n直接点选仓库，不会唤起手机输入法。`,
      },
    },
    ...visible.map((repository) =>
      buttonRow({
        label: `${repository.provider} · ${repository.fullName}`,
        value: {
          action: "select_target",
          pendingId: input.pendingId,
          connectionId: input.connection.id,
          repositoryKey: repository.repositoryKey,
          page,
          selectionRevision,
        },
      })
    ),
    ...(navigationActions.length > 0 ? [{ tag: "action", actions: navigationActions }] : [])
  );
  return card;
}

function readyModels(
  harness: RuntimeHarnessOption
): Array<RuntimeModelOption & { routeId: string }> {
  return harness.routes.flatMap((route) =>
    route.models
      .filter((model) => model.ready)
      .map((model) => ({ ...model, routeId: route.routeId }))
  );
}

/** Continue a staged launch after a repository has been selected. */
export function buildRuntimeHarnessPickerCard(input: {
  pendingId: string;
  target: FeishuRepositoryTarget;
  harnesses: readonly RuntimeHarnessOption[];
  commands?: readonly RuntimeCommandOption[];
  selectionRevision?: number;
}): FeishuCard {
  const card = title("选择 Harness");
  const selectionRevision = input.selectionRevision ?? 0;
  const ready = input.harnesses.filter(
    (harness) => harness.ready && readyModels(harness).length > 0
  );
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `代码源：**${input.target.connectionLabel}**\n仓库：**${input.target.fullName}**\n\n选择本次会话使用的 Harness。设置由运行时能力目录校验，不会把密钥放进卡片。`,
    },
  });
  elements(card).push(
    ...ready.map((harness) =>
      buttonRow({
        label: harness.displayName,
        type: "primary",
        value: {
          action: "select_harness",
          pendingId: input.pendingId,
          connectionId: input.target.connectionId,
          repositoryKey: input.target.repositoryKey,
          harness: harness.harness,
          selectionRevision,
        },
      })
    )
  );
  const userSettings = ready
    .flatMap((harness) => harness.settings.filter((setting) => setting.visibility === "user"))
    .map((setting) => setting.label);
  const commandNames = (input.commands ?? [])
    .filter((command) => command.available)
    .map((command) => `/${command.slashName}`)
    .slice(0, 8);
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: [
        ready.length === 0 ? "当前没有已就绪的 Harness，请到 Web 设置检查运行时凭据。" : undefined,
        userSettings.length > 0
          ? `可配置设置：${[...new Set(userSettings)].join("、")}（复杂设置请在 Web 会话中调整）`
          : "Harness 设置当前遵循部署策略。",
        commandNames.length > 0 ? `可用命令：${commandNames.join("、")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  });
  return card;
}

export function buildRuntimeModelPickerCard(input: {
  pendingId: string;
  target: FeishuRepositoryTarget;
  harness: RuntimeHarnessOption;
  page?: number;
  selectionRevision?: number;
}): FeishuCard {
  const card = title(`选择 ${input.harness.displayName} 模型`);
  const allModels = readyModels(input.harness);
  const pageCount = Math.max(1, Math.ceil(allModels.length / RUNTIME_MODELS_PER_PAGE));
  const page = Math.min(Math.max(0, input.page ?? 0), pageCount - 1);
  const models = allModels.slice(
    page * RUNTIME_MODELS_PER_PAGE,
    (page + 1) * RUNTIME_MODELS_PER_PAGE
  );
  const selectionRevision = input.selectionRevision ?? 0;
  const navigationActions: Record<string, unknown>[] = [];
  if (page > 0) {
    navigationActions.push({
      tag: "button",
      text: text("上一页"),
      type: "default",
      value: {
        action: "runtime_model_page",
        pendingId: input.pendingId,
        connectionId: input.target.connectionId,
        repositoryKey: input.target.repositoryKey,
        harness: input.harness.harness,
        page: page - 1,
        selectionRevision,
      },
    });
  }
  if (page + 1 < pageCount) {
    navigationActions.push({
      tag: "button",
      text: text("下一页"),
      type: "default",
      value: {
        action: "runtime_model_page",
        pendingId: input.pendingId,
        connectionId: input.target.connectionId,
        repositoryKey: input.target.repositoryKey,
        harness: input.harness.harness,
        page: page + 1,
        selectionRevision,
      },
    });
  }
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `仓库：**${input.target.fullName}**\nHarness：**${input.harness.displayName}**\n\n只显示当前部署已启用且凭据就绪的模型。第 ${page + 1}/${pageCount} 页`,
    },
  });
  elements(card).push(
    ...models.map((model) =>
      buttonRow({
        label: `${model.displayName} · ${model.model}`,
        value: {
          action: "select_model",
          pendingId: input.pendingId,
          connectionId: input.target.connectionId,
          repositoryKey: input.target.repositoryKey,
          harness: input.harness.harness,
          routeId: model.routeId,
          model: model.model,
          selectionRevision,
        },
      })
    ),
    ...(navigationActions.length > 0 ? [{ tag: "action", actions: navigationActions }] : [])
  );
  return card;
}

export function buildRuntimeEffortPickerCard(input: {
  pendingId: string;
  target: FeishuRepositoryTarget;
  harness: RuntimeHarnessOption;
  model: RuntimeModelOption;
  routeId: string;
  commands?: readonly RuntimeCommandOption[];
  selectionRevision?: number;
}): FeishuCard {
  const card = title("选择 Effort");
  const selectionRevision = input.selectionRevision ?? 0;
  const efforts = input.model.efforts;
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `仓库：**${input.target.fullName}**\nHarness：**${input.harness.displayName}**\n模型：**${input.model.displayName}**\n\n选择推理深度；没有该选项的模型将使用自身默认值。`,
    },
  });
  const effortButtons = efforts.map((effort) =>
    buttonRow({
      label: effort.label,
      type: effort.isDefault ? "primary" : "default",
      value: {
        action: "select_effort",
        pendingId: input.pendingId,
        connectionId: input.target.connectionId,
        repositoryKey: input.target.repositoryKey,
        harness: input.harness.harness,
        routeId: input.routeId,
        model: input.model.model,
        effort: effort.value,
        selectionRevision,
      },
    })
  );
  effortButtons.push(
    buttonRow({
      label: efforts.length > 0 ? "使用模型默认" : "开始会话",
      type: "primary",
      value: {
        action: "select_effort",
        pendingId: input.pendingId,
        connectionId: input.target.connectionId,
        repositoryKey: input.target.repositoryKey,
        harness: input.harness.harness,
        routeId: input.routeId,
        model: input.model.model,
        effort: "inherit",
        selectionRevision,
      },
    })
  );
  elements(card).push(...effortButtons);
  const commandNames = (input.commands ?? [])
    .filter((command) => command.available)
    .map((command) => `/${command.slashName}`)
    .slice(0, 8);
  if (commandNames.length > 0) {
    elements(card).push({
      tag: "div",
      text: { tag: "lark_md", content: `创建后可在本话题使用：${commandNames.join("、")}` },
    });
  }
  return card;
}

export function buildWorkingCard(input: {
  targetLabel: string;
  model: string;
  branch?: string;
  harness?: string;
  reasoningEffort?: string;
  chatType?: "p2p" | "group";
  replyMode?: "thread" | "flat";
  sessionId?: string;
  webAppUrl: string;
}): FeishuCard {
  const shortId = input.sessionId ? sessionShortId(input.sessionId) : undefined;
  const card = title(`Open-Inspect 正在工作${shortId ? ` · #${shortId}` : ""}`);
  const runtime = [
    input.harness ? `Harness：\`${input.harness}\`` : undefined,
    `模型：\`${input.model}\``,
    input.reasoningEffort ? `Effort：\`${input.reasoningEffort}\`` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `目标：**${input.targetLabel}**${input.branch ? `\n分支：\`${input.branch}\`` : ""}\n状态：**工作中**\n${runtime}`,
    },
  });
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content:
        input.chatType === "group" && input.replyMode === "thread"
          ? "后续：请在本话题继续发送消息；新的顶层任务会创建独立会话。"
          : "后续：请引用回复本任务继续；新的顶层消息会创建独立会话。",
    },
  });
  if (input.sessionId) {
    elements(card).push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: text("打开 Web 会话"),
          type: "primary",
          url: `${input.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}`,
        },
      ],
    });
  }
  return card;
}

export function buildCompletionCard(input: {
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
  model?: string;
  reasoningEffort?: string;
  chatType?: "p2p" | "group";
  replyMode?: "thread" | "flat";
}): FeishuCard {
  const shortId = sessionShortId(input.sessionId);
  const card = title(
    `${input.success ? "Open-Inspect 已完成" : "Open-Inspect 运行失败"} · #${shortId}`,
    input.success ? "green" : "red"
  );
  const body = input.success
    ? input.textContent.trim() || "Agent 已完成。请打开 Web 会话查看详细记录。"
    : `运行失败：${input.error || "未知错误"}`;
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: [
        `目标：**${input.targetLabel}**`,
        input.branch ? `分支：\`${input.branch}\`` : undefined,
        input.harness ? `Harness：\`${input.harness}\`` : undefined,
        input.model ? `模型：\`${input.model}\`` : undefined,
        input.reasoningEffort ? `Effort：\`${input.reasoningEffort}\`` : undefined,
        input.previewUrl ? `预览：${input.previewUrl}` : undefined,
        "",
        body.slice(0, 3000),
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    },
  });
  const verificationLine = formatVisualVerification(input.visualVerification);
  if (verificationLine) {
    elements(card).push({
      tag: "div",
      text: { tag: "lark_md", content: verificationLine },
    });
  }
  elements(card).push({
    tag: "div",
    text: {
      tag: "lark_md",
      content:
        input.chatType === "group" && input.replyMode === "thread"
          ? "要继续修改，请直接在本话题发送消息。"
          : "要继续修改，请引用回复本任务；不要用普通顶层消息隐式续办。",
    },
  });
  const actions: Record<string, unknown>[] = [
    {
      tag: "button",
      text: text("打开 Web 会话"),
      type: "primary",
      url: `${input.webAppUrl.replace(/\/$/, "")}/session/${encodeURIComponent(input.sessionId)}`,
    },
  ];
  if (input.pullRequestUrl) {
    actions.push({ tag: "button", text: text("查看 PR"), url: input.pullRequestUrl });
  }
  if (input.previewUrl) {
    actions.push({ tag: "button", text: text("打开预览"), url: input.previewUrl });
  }
  elements(card).push({ tag: "action", actions });
  return card;
}

function formatVisualVerification(report: VisualVerificationReport | undefined): string | null {
  if (!report || report.status === "not_requested") return null;
  if (report.status === "passed") {
    const artifactCount = report.scenarios.reduce(
      (total, scenario) => total + scenario.artifactIds.length,
      0
    );
    return `✅ 视觉验证已通过：${report.scenarios.length} 个场景，${artifactCount} 张截图。`;
  }
  const detail = report.failure?.message ? `：${report.failure.message}` : "";
  return report.status === "failed" ? `❌ 视觉验证失败${detail}` : `⚠️ 视觉验证未完成${detail}`;
}

export function buildSessionListCard(input: {
  sessions: Array<{
    sessionId: string;
    targetLabel: string;
    branch?: string;
    harness?: string;
    model: string;
    reasoningEffort?: string;
    state?: "starting" | "active" | "delivery_failed" | "completed" | "failed" | "stale";
    createdAt: number;
  }>;
  webAppUrl: string;
}): FeishuCard {
  const card = title("近期 Open-Inspect 会话");
  const sessions = input.sessions.slice(0, SESSION_LIST_LIMIT);
  const baseUrl = input.webAppUrl.replace(/\/$/, "");
  const content = sessions.length
    ? sessions
        .map((session, index) => {
          const url = `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
          const runtime = [session.harness, session.model, session.reasoningEffort]
            .filter(Boolean)
            .join(" · ");
          return `${index + 1}. **#${sessionShortId(session.sessionId)} · ${session.targetLabel}**${session.branch ? ` · \`${session.branch}\`` : ""}\n   ${stateLabel(session.state)} · ${runtime} · [打开会话](${url})`;
        })
        .join("\n")
    : "尚无近期会话。发送一条新的顶层任务即可创建会话。";
  elements(card).push({ tag: "div", text: { tag: "lark_md", content } });
  if (sessions.length > 0) {
    elements(card).push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "群聊优先在原话题继续；私聊可发送 `#短编号 请求` 显式续办指定会话。",
      },
    });
  }
  return card;
}
