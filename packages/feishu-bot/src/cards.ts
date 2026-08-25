import type { FeishuCard } from "./feishu/client";
import type { FeishuRepositoryConnection, FeishuRepositoryTarget } from "./targets";

// Feishu's static-select UI only renders a small option set reliably. Keep the
// card page below that client limit so every repository remains reachable.
export const REPOSITORIES_PER_PAGE = 9;
const SESSION_LIST_LIMIT = 12;

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

export function buildConnectionPickerCard(input: {
  pendingId: string;
  connections: FeishuRepositoryConnection[];
}): FeishuCard {
  const card = title("选择代码源");
  elements(card).push(
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "先选择代码源；下一步会在该代码源内选择仓库。",
      },
    },
    {
      tag: "action",
      actions: [
        {
          tag: "select_static",
          name: "connection",
          placeholder: text("选择 GitHub、Gitea 或其他代码源"),
          value: { action: "select_connection", pendingId: input.pendingId },
          options: input.connections.map((connection) => ({
            text: text(
              `${connection.label} · ${connection.provider} (${connection.repositoryCount} 个仓库)`
            ),
            value: connection.id,
          })),
        },
      ],
    }
  );
  return card;
}

export function buildRepositoryPickerCard(input: {
  pendingId: string;
  connection: FeishuRepositoryConnection;
  repositories: FeishuRepositoryTarget[];
  page: number;
}): FeishuCard {
  const pageCount = Math.max(1, Math.ceil(input.repositories.length / REPOSITORIES_PER_PAGE));
  const page = Math.min(Math.max(0, input.page), pageCount - 1);
  const offset = page * REPOSITORIES_PER_PAGE;
  const visible = input.repositories.slice(offset, offset + REPOSITORIES_PER_PAGE);
  const card = title(`选择 ${input.connection.label} 仓库`);
  const actions: Record<string, unknown>[] = [
    {
      tag: "select_static",
      name: "repository",
      placeholder: text("选择仓库"),
      value: {
        action: "select_target",
        pendingId: input.pendingId,
        connectionId: input.connection.id,
        page,
      },
      options: visible.map((repository) => ({
        text: text(`${repository.provider} · ${repository.fullName}`),
        value: repository.repositoryKey,
      })),
    },
  ];
  if (page > 0) {
    actions.push({
      tag: "button",
      text: text("上一页"),
      type: "default",
      value: {
        action: "repository_page",
        pendingId: input.pendingId,
        connectionId: input.connection.id,
        page: page - 1,
      },
    });
  }
  if (page + 1 < pageCount) {
    actions.push({
      tag: "button",
      text: text("下一页"),
      type: "default",
      value: {
        action: "repository_page",
        pendingId: input.pendingId,
        connectionId: input.connection.id,
        page: page + 1,
      },
    });
  }
  elements(card).push(
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `代码源：**${input.connection.label}** · ${input.connection.repositoryCount} 个仓库 · 第 ${page + 1}/${pageCount} 页`,
      },
    },
    { tag: "action", actions }
  );
  return card;
}

export function buildWorkingCard(input: {
  targetLabel: string;
  model: string;
  sessionId?: string;
  webAppUrl: string;
}): FeishuCard {
  const card = title("Open-Inspect 正在工作");
  elements(card).push({
    tag: "div",
    text: { tag: "lark_md", content: `目标：**${input.targetLabel}**\n模型：\`${input.model}\`` },
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
}): FeishuCard {
  const card = title(
    input.success ? "Open-Inspect 已完成" : "Open-Inspect 运行失败",
    input.success ? "green" : "red"
  );
  const body = input.success
    ? input.textContent.trim() || "Agent 已完成。请打开 Web 会话查看详细记录。"
    : `运行失败：${input.error || "未知错误"}`;
  elements(card).push({
    tag: "div",
    text: { tag: "lark_md", content: `目标：**${input.targetLabel}**\n\n${body.slice(0, 3000)}` },
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
  elements(card).push({ tag: "action", actions });
  return card;
}

export function buildSessionListCard(input: {
  sessions: Array<{ sessionId: string; targetLabel: string; model: string; createdAt: number }>;
  webAppUrl: string;
}): FeishuCard {
  const card = title("近期 Open-Inspect 会话");
  const sessions = input.sessions.slice(0, SESSION_LIST_LIMIT);
  const baseUrl = input.webAppUrl.replace(/\/$/, "");
  const content = sessions.length
    ? sessions
        .map((session, index) => {
          const url = `${baseUrl}/session/${encodeURIComponent(session.sessionId)}`;
          return `${index + 1}. **${session.targetLabel}** · \`${session.model}\` · [打开会话](${url})`;
        })
        .join("\n")
    : "尚无近期会话。发送一条新的顶层任务即可创建会话。";
  elements(card).push({ tag: "div", text: { tag: "lark_md", content } });
  return card;
}
