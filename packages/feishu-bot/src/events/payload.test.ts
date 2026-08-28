import { describe, expect, it } from "vitest";
import { feishuEventEnvelopeSchema, parseFeishuMessageText } from "./payload";

describe("parseFeishuMessageText", () => {
  it("parses an ordinary text message", () => {
    expect(parseFeishuMessageText("text", JSON.stringify({ text: "检查项目" }))).toBe("检查项目");
  });

  it("parses a topic-group rich-text message without forwarding its mention", () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "at", user_id: "ou_bot", user_name: "代码智能体" },
          { tag: "text", text: " 帮我看看 chatbi 项目", style: [] },
        ],
      ],
    });

    expect(parseFeishuMessageText("post", content)).toBe("帮我看看 chatbi 项目");
  });

  it("preserves a rich-text title and multiple lines", () => {
    const content = JSON.stringify({
      title: "修复登录页",
      content: [
        [{ tag: "text", text: "运行测试" }],
        [
          { tag: "text", text: "参考 " },
          { tag: "a", text: "现有实现", href: "https://example.com" },
        ],
      ],
    });

    expect(parseFeishuMessageText("post", content)).toBe("修复登录页\n运行测试\n参考 现有实现");
  });

  it("rejects unsupported and malformed messages", () => {
    expect(parseFeishuMessageText("image", JSON.stringify({ image_key: "img" }))).toBeNull();
    expect(parseFeishuMessageText("post", "not-json")).toBeNull();
  });

  it("accepts topic-group message events for the dispatcher normalizer", () => {
    const parsed = feishuEventEnvelopeSchema.safeParse({
      header: { event_type: "im.message.receive_v1", tenant_key: "tenant" },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "user" } },
        message: {
          chat_id: "chat",
          chat_type: "topic_group",
          message_id: "message",
          message_type: "text",
          content: JSON.stringify({ text: "检查项目" }),
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});
