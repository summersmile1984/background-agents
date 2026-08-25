# 飞书集成

> 状态：首个可部署版本已实现，生产启用前必须完成飞书开发者后台配置和真实租户 E2E。

Open-Inspect 的飞书集成是一个独立的 Cloudflare Worker。它不会将飞书 App Secret、飞书 tenant access
token、GitHub/Gitea PAT 或 sandbox capability 发送到浏览器或沙盒。

## 当前能力

- 私聊机器人发送文字请求，或在群聊中 @机器人发送文字请求。
- 使用明确的 `owner/repo` 自动定位仓库；否则通过飞书消息卡片选择 GitHub 或 Gitea 仓库。
- 创建 session、将结果回传同一飞书主题，并提供 Web session 与 PR 链接。
- 在同一主题继续 session；只有原发起人可以继续该 session。
- 事件与卡片回调的 verification token、加密载荷、签名、事件/action 去重与 Control
  Plane 回调签名验证。

图片、文件、运行偏好卡片、状态/停止/Review 按钮、主动通知和受管群自动化仍按
[飞书机器人入口方案](../plans/feishu-bot-integration.md)
的后续阶段实施；当前版本会对非文字消息明确提示，而不是静默丢弃。

## 部署前配置

1. 在飞书开放平台创建企业自建应用，启用机器人能力。
2. 在 Terraform 的安全变量后端（或 CI 的 `TF_VAR_…`）配置：

   ```text
   TF_VAR_enable_feishu_bot=true
   TF_VAR_feishu_app_id=cli_…
   TF_VAR_feishu_app_secret=…
   TF_VAR_feishu_verification_token=…
   TF_VAR_feishu_encrypt_key=…
   ```

   不要把这些值写进 `terraform.tfvars` 并提交，也不要通过前端 Settings 保存。

3. 部署后从 Terraform output 获得 `feishu_bot_url`，在飞书开发者后台配置：

   | 飞书配置             | Open-Inspect URL                    |
   | -------------------- | ----------------------------------- |
   | 事件订阅 Request URL | `https://<feishu-bot>/events`       |
   | 消息卡片回调 URL     | `https://<feishu-bot>/card-actions` |

4. 使用飞书后台生成/保存的 verification token 与 Encrypt Key 更新上述 Worker secret，然后执行 URL
   challenge。订阅接收消息事件 `im.message.receive_v1`，并申请最小的机器人收发消息权限。
5. 先只将应用发布给测试用户和测试群。群 @ 功能还需要设置
   `TF_VAR_feishu_bot_open_id`；在完成群聊 E2E 前保持 `TF_VAR_feishu_triggers_enabled=false`。

## 真实 E2E 验收

必须在真实飞书测试租户完成以下操作，浏览器自动化不能替代这些验证：

1. 事件 URL challenge 成功，错误 token 和伪造签名返回 401。
2. 与机器人私聊，发送包含 GitHub 仓库的请求；确认创建了正确 session，完成卡回到原主题。
3. 重复执行一次并选择 Gitea 仓库；确认 clone、commit、push、PR 和结果链接全程使用该 connection。
4. 在同一主题发送 follow-up；确认进入相同 session。让另一测试用户点击旧卡片，确认被拒绝。
5. 将机器人加到测试群，在配置 bot open ID 后启用群 @；确认普通消息不触发，只有 @机器人触发。

飞书官方资料：[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、
[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、
[Request URL 配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)。
