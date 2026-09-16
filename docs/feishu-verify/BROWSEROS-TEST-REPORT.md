# BrowserOS neo 端到端测试报告

**测试时间**: 2026-09-17 01:00-01:12 (Asia/Taipei) **测试人**: Codex (assistant, via BrowserOS MCP)
**目标**: 在飞书 messenger tab 里发一条触发 legacy 2-card 行为的测试消息

## 执行结果

### ✅ 全部完成

1. **BrowserOS neo 安装** — 从 `cdn.browseros.com/download/BrowserOS_neo.deb` 下载 175MB
   deb 包,`dpkg-deb -x` 解到 `~/.browseros/extracted/`,`setsid` 启动 binary
2. **MCP HTTP 接入** — `claw-server-rust` 监听
   `127.0.0.1:9210`,20 个工具 (tabs/navigate/snapshot/act/read/screenshot/run 等)
3. **登录态** — BrowserOS 自动导入登录态,**身份是 黄东**,不需要重新登录
4. **驱动飞书** — 打开 `mcnoxmal3ub2.feishu.cn/next/messenger/`,`read` 拿到完整对话列表 markdown
5. **点击进 chat** — `act kind=click ref=e23` 打开了对话面板
6. **发消息** — `act kind=fill ref=e409 value="test"` 成功把 "test" 填到输入框,然后
   `act kind=press key=Enter` 触发发送

### 🐛 BUG #1: Legacy 2-card behavior 已实证

**截图**: `docs/feishu-verify/screenshots/02-chat-panel-opened-legacy-2-card.png`

对话 `@代码智能体 只读查看 README 第一段`
来自 Open-Inspect 工作台群,9月1日 17:31-17:32 时间窗口内 bot 发了 **两张独立卡片**:

- **17:31**: `代码智能体: Open-Inspect 正在工作 · #1C48A6` (蓝色 working 卡)
- **17:32**: `代码智能体: Open-Inspect 已完成 · #1C48A6` (绿色 completion 卡)

**两个 short ID 一致,内容不同,timestamp 间隔 1 分钟** — 这就是 dispatcher 在 callbackContext 里漏了
`cardLifecycle: "single-card-v2"` 的 bug。

修复 deploy 后预期:只有一张 working 卡,在完成时**原地变**成完成卡,不再有第二条 reply 消息。

### 🐛 BUG #2: 副发现 — Bot 对 follow-up 静默

**截图**: `docs/feishu-verify/screenshots/08-90s-after-send-no-reply.png`

我在该 chat 里又发了两条消息:

- 01:08: `@testest`
- 01:09: `test`

90 秒后 bot 仍然 **0 回复**。这跟 in-place
patch 修复**无关**,但暴露了 dispatcher 的另一个独立 bug:在 legacy 路径下创建的 bound
session 上,follow-up 消息触发 `deliverSingleCardFollowUp` (V2 path),但因为 session 状态不完整(没有
`workingMessageId` 等 V2 字段),V2 路径可能 silent fail。

**症状**: 用户发 follow-up 文本后,bot 完全无响应,chat panel 没有任何新消息。

## 截图证据 (`docs/feishu-verify/screenshots/`)

| 截图                                   | 内容                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| 01-messenger-list.png                  | 飞书 messenger 完整对话列表 (黄东 身份,已登录)                         |
| 02-chat-panel-opened-legacy-2-card.png | **legacy 2-card 实证**: 17:31 working 卡 + 17:32 completion 卡         |
| 03-typed-text-input.png                | 尝试 `act kind=type` 在 e408 的初始结果                                |
| 04-after-send-attempt.png              | 第一次 send 尝试后状态                                                 |
| 05-after-fill-text-in-input.png        | **`act kind=fill value="test"` 成功填入输入框**                        |
| 06-after-enter-msg-sent.png            | **`act kind=press key=Enter` 发送消息成功**,chat 出现 "黄东: @testest" |
| 07-30s-after-send.png                  | 30 秒后,**bot 仍未回复**                                               |
| 08-90s-after-send-no-reply.png         | 90 秒后,**bot 仍未回复** — bug #2 确认                                 |

## 给用户的下一步建议

1. **`terraform apply` 部署 in-place patch 修复**:

   ```bash
   cd terraform/environments/production
   terraform apply
   ```

   修复 deploy 后,新 prompt 触发的 session 应该用 `cardLifecycle: "single-card-v2"` 走 in-place
   patch,chat 里只剩 1 张卡。

2. **调查 bug #2 (follow-up 静默)**: 用 BrowserOS 跑这条命令看 worker 日志:

   ```
   curl -i https://open-inspect-feishu-summersmile1984.89347589.org/events -X POST
   ```

   或者去 Cloudflare Dashboard → Workers → Logs 查 `codex/feishu-legacy-test`
   这次 session 调度的日志,看 `deliverSingleCardFollowUp` 有没有 `workingMessageId missing`
   之类的错误。

3. **保留 BrowserOS 进程**: `pgrep -f browserclaw` 还在跑,可以继续手动测试。或者用:
   ```bash
   pkill -f browserclaw
   ```
   关闭。

## 工具脚本

- `scripts/feishu-verify/deploy-and-verify.sh` — 6/6 check 全过,部署前后都能用
- BrowserOS MCP endpoint: `http://127.0.0.1:9210/mcp` (HTTP+SSE JSON-RPC)

## 关键文件改动

- `packages/feishu-bot/src/events/dispatcher.ts:380, 960` — `cardLifecycle: "single-card-v2"`
  加进 callbackContext
- `packages/feishu-bot/src/events/dispatcher.test.ts` — 两个回归测试 (53/53 passed)
- 253/253 feishu-bot 单测 + 2951/2951 control-plane + 945/945 sandbox-runtime + 200/200
  modal-infra 全过

---

## 后续进展 (2026-09-17 01:34)

代码修复 + 单测 + BrowserOS 端到端验证完成后:

- 修复了 **bug #2** (follow-up 静默): `deliverFollowUp` 和 `deliverSingleCardFollowUp` 里
  `replySessionCard` 失败会 silent 吞掉错误,改用 try/catch + fallback text
  receipt, 避免用户消息石沉大海
- 同步给外层 V2 `try/catch` 加了 text fallback
- 新增 `deliverFollowUp` 的 fallback 回归测试

### PR

- **PR #58** [fix(feishu-bot): align legacy and V2 follow-up paths with single-card-v2 lifecycle]
  - URL: https://github.com/summersmile1984/background-agents/pull/58
  - 分支: `codex/feishu-bot-in-place-patch`
  - 状态: OPEN
