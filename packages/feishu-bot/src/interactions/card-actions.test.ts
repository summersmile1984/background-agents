import { describe, expect, it } from "vitest";
import { parseFeishuCardAction } from "./card-actions";

const pendingId = "1cd968ae-f012-4a12-898e-f320808f1af7";

describe("parseFeishuCardAction", () => {
  it("accepts an Event Subscription 2.0 callback", () => {
    const action = parseFeishuCardAction({
      schema: "2.0",
      header: { event_id: "evt-123", tenant_key: "tenant-123" },
      event: {
        context: { open_chat_id: "oc_chat" },
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          value: { action: "select_connection", pendingId },
          option: "scm_gitea",
        },
      },
    });

    expect(action).toEqual({
      actionId: "evt-123",
      chatId: "oc_chat",
      openId: "ou_user",
      targetKey: "scm_gitea",
      tenantKey: "tenant-123",
      value: { action: "select_connection", pendingId },
    });
  });

  it("reads a code-source selection directly from a mobile-safe button", () => {
    const action = parseFeishuCardAction({
      schema: "2.0",
      header: { event_id: "evt-button-1", tenant_key: "tenant-123" },
      event: {
        context: { open_chat_id: "oc_chat" },
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          value: {
            action: "select_connection",
            pendingId,
            connectionId: "scm_gitea",
          },
        },
      },
    });

    expect(action).toMatchObject({ targetKey: "scm_gitea" });
  });

  it("reads a repository selection directly from a mobile-safe button", () => {
    const action = parseFeishuCardAction({
      schema: "2.0",
      header: { event_id: "evt-button-2", tenant_key: "tenant-123" },
      event: {
        context: { open_chat_id: "oc_chat" },
        operator: { operator_id: { open_id: "ou_user" } },
        action: {
          value: {
            action: "select_target",
            pendingId,
            connectionId: "scm_gitea",
            repositoryKey: "scm_gitea:huangdong/chatbi",
            page: 0,
          },
        },
      },
    });

    expect(action).toMatchObject({ targetKey: "scm_gitea:huangdong/chatbi" });
  });

  it("keeps compatibility with legacy flat callbacks", () => {
    const action = parseFeishuCardAction({
      header: { event_id: "evt-456", tenant_key: "tenant-456" },
      context: { open_chat_id: "oc_legacy" },
      operator: { open_id: "ou_legacy" },
      action: {
        value: { action: "select_connection", pendingId },
        option: "scm_github",
      },
    });

    expect(action).toMatchObject({
      actionId: "evt-456",
      chatId: "oc_legacy",
      openId: "ou_legacy",
      targetKey: "scm_github",
      tenantKey: "tenant-456",
    });
  });

  it("rejects a callback without an authenticated actor", () => {
    expect(
      parseFeishuCardAction({
        header: { event_id: "evt-789", tenant_key: "tenant-789" },
        event: {
          context: { open_chat_id: "oc_chat" },
          action: { value: { action: "select_connection", pendingId }, option: "scm_gitea" },
        },
      })
    ).toBeNull();
  });
});
