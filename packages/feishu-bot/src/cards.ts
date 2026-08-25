import type { FeishuCard } from "./feishu/client";
import type { FeishuRepositoryTarget } from "./targets";

const MAX_CARD_REPOSITORIES = 50;

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

export function buildRepositoryPickerCard(input: {
  pendingId: string;
  repositories: FeishuRepositoryTarget[];
}): FeishuCard {
  const card = title("选择 Open-Inspect 目标");
  const visible = input.repositories.slice(0, MAX_CARD_REPOSITORIES);
  elements(card).push(
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          visible.length === input.repositories.length
            ? "请选择要工作的代码仓库。仓库会固定到新会话中。"
            : `请选择代码仓库（仅显示前 ${MAX_CARD_REPOSITORIES} 个）；也可以重新发送包含 \`owner/repo\` 的请求。`,
      },
    },
    {
      tag: "action",
      actions: [
        {
          tag: "select_static",
          name: "repository",
          placeholder: text("选择 GitHub 或 Gitea 仓库"),
          value: { action: "select_target", pendingId: input.pendingId },
          options: visible.map((repository) => ({
            text: text(`${repository.provider} · ${repository.fullName}`),
            value: repository.repositoryKey,
          })),
        },
      ],
    }
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
