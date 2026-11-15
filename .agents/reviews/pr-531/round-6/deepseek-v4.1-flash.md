## 本轮核对范围

- 实际增量 `c4c7a48b5..d5201c8a2` 只改了 3 个文档（web-push spec、apple design、apple plan）和若干 review 记录文件，**没有改任何代码**。所以本轮以文档核对为主；顺着文档中的行为往代码追了 `production-web-push.ts`、`production-apple-push.ts`、`production-proposals.ts`、`service-main.ts`、`web-push-gate.ts`、`sw.js`、`sqlite-owner-proposal-operations.ts` 以及两个测试文件。base..head 里的旧代码是前几轮的范围，没有整份重读。

### 1. 低 — 上一轮第 2 条只改好了一半：第四类进了表，但流程图、取舍和验证仍写“三类来源”

**文件:行**

- `docs/execution/specs/2026-10-26-web-push-design.md:59`
- `docs/execution/specs/2026-10-26-web-push-design.md:255`
- `docs/execution/specs/2026-10-26-web-push-design.md:263`

**问题**

上一轮说“网页推送说明仍写‘三类来源’，第四类没有进表”。这次确实把标题、目录、正文链接和来源表都改成了“推送来源”，并新增了提议一行（`:115`），`Urgency 按上表`（`:136`）也因此覆盖到提议。但同一份规格里仍有三处写“三类来源”，没有把提议算进去，读者按流程图/验证清单实现时仍会漏掉提议。

**证据（亲自读到的原文）**

```text
:59   每 10 秒扫一遍三类来源
:108  推送调度器每 10 秒扫一遍下面三类来源和一类提议，把新事写进待推送表
:255  **扫描而不是在每个写入点发事件。** 三类来源分散在记忆、审批、运行三处
:263  - 调度（`[WP-3]`）：三类来源各推一次且只推一次
```

而新增的第四行是：

```text
:115  | 待处理的提议 | 只取最新一份待处理提议 | `proposal:<提议 id>:<proposedAt>` | 提议时间起 24 小时，不受“静默延后”规则延后 | `normal` |
```

代码确实会扫提议：`production-web-push.ts:428-448` 在每轮 `#run()` 里读 `#readyProposals` 并入队；`production-web-push.ts:651-671` 为 `proposal:` 来源生成固定文字和 `quiet: true`。所以这些“三类来源”的旧说法与实现不一致。

**建议**

把 `:59` 改为“三类来源和待处理提议”或“四类来源”，把 `:255`、`:263` 补上提议这一路（例如“提议另从 `owner_proposals` 读”），并在 `:263` 的验证清单里点名新加的反向测试。另建议在 `:115` 的表行或 `:117` 的说明里写明提议的 `kind` 仍是 `reminder`（代码就是按提醒类别入队和受开关控制的，见 `production-web-push.ts:443` 和 `production-apple-push.ts:273`），避免读者以为要新增 `kind`。

## 读代码证实的

- 提议确实只为“24 小时内最新的待处理提议”入队一条：`production-web-push.ts:429-448` 先按 `PROPOSAL_WINDOW_MS = 24h` 过滤（`:24`、`:484-490`），再用 `reduce` 取 `proposedAt` 最大的一行；`sourceKey` 是 `proposal:<id>:<proposedAt>`，`expiresAt = proposedAt + 24h`，`kind: "reminder"`。
- 去向和数量与作者说法一致：苹果推送 `production-apple-push.ts:98-106` 在 `quiet` 时去掉 `sound`/`badge`、把 `interruption-level` 设为 `passive`；`:383` 把 `apns-priority` 设为 5；`:291-299` 在 `quiet` 时跳过角标读取。网页推送 `production-web-push.ts:564` 在 `quiet` 时角标传 0，`:797` 把 `urgency` 设为 `normal`，`:153-161` 只在 `quiet === true` 时写入 `silent: true`；`sw.js:20` 只在 `notification.silent === true` 时把 `silent` 传给 `showNotification`。
- 读取失败不影响其他推送：`production-web-push.ts:480-496` 捕获 `listReady` 异常、上报一次并返回 `ok: false`；发送时 `:651-660` 只在 `pending.ok === true` 且找不到该提议时才判过期，所以失败时已入队的照发。对应反向测试 `push-channels.test.ts:1020-1062`、`:1064-1082`。
- 提议属于受保护类、不被不推送时段延后：`web-push-gate.ts:18-23` 把 `proposal` 放进 `PUSH_RULE_PROTECTED_CLASSES`，`:37` 由 `proposal:` 前缀识别；`production-web-push.ts:579-582` 对受保护类直接放行。测试 `push-channels.test.ts:1084-1104` 用一个总是 `defer` 的 gate 验证仍会发送。
- 直接使用端都接受这些值：`PENDING_PROPOSAL_CEILING` 在 `service-main.ts:2839-2846` 作为 `listPending` 的 limit，持久层 `sqlite-owner-proposal-operations.ts:271` 用 `MAX_LISTED = 200` 夹紧，数值一致；`quiet` 只在本 PR 的 web/Apple 组装和测试里使用；`proposal` 推送类只用于内存中的闸门判断，没有写进数据库或导出 schema。`silent` 只进入网页负载和 service worker。
- 旧文档锚点没有断链：全仓 grep 未发现 `三类推送来源`，`#推送来源` 的三处引用（目录、目标与边界、数据库）都指向新标题。

## 推测 / 未核实

- “不上手表”不是服务器能控制的。代码只发 APNs alert 到 iPhone 令牌，没有“不上手表”的字段或分支；文档 `docs/execution/plans/2026-11-11-apple-device-body-plan.md:163` 已明确写“服务器管不了……没核实”。这是已声明的限制，不是本轮新引入的错误。
- 声明式网页推送是否认识 `notification.silent`、以及各浏览器是否真的静音，代码只证明了“把字段传下去”，没有证明系统会采用；文档同一处也写了“没核实”。属于未核实项。
- `npm run check 56 步通过` 未运行，无法复核。

## 侧重检查

- **错误路径**：提议读取抛错被捕获并上报一次，其他来源继续；发送时读取失败不会把已入队的提议误判过期。已核实，测试覆盖。
- **不合规范/不可信输入**：`proposedAt`、`proposal.id` 来自数据库，SQL 使用参数绑定；通知正文是固定文案，不拼接提议内容，因此没有把提议内容或外部字符串带进锁屏。已核实。
- **安全**：没有新增密钥、日志或对外暴露字段；`silent`/`quiet` 不涉及敏感数据。未发现新问题。
- **资源耗尽**：每 10 秒最多读 `PENDING_PROPOSAL_CEILING = 200` 行，且 `ProposalBox` 的 pending 上限本身不超过 200；不会无限增长。已核实。
- **不可撤销操作**：每份提议按 `sourceKey` 去重，终态不再发；发送前会再确认提议仍待处理，已处理的记 `expired`。已核实。
- **规则文件、说明文档和代码一致性**：发现上面第 1 条的文档残留；其余新增说明（第四类、`normal`/passive、提醒开关、24 小时窗口）与代码一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮增量只有文档，没有系统提示、工具定义、历史消息或遮盖结果的改动；累计 PR 也没有改 `field-catalog`、`PUSH_QUIET_CLASSES` 或规则工具说明（`field-catalog.ts:87-93`、`rule-types.ts:47` 保持原样）。发给模型的内容没有变化，不存在“前缀被改写”的问题；推送是另一条链路。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。提议通知正文按语言取固定字符串（`production-web-push.ts:52-56`、`:73-77`、`:94-98`），不含时间或随机值；`sourceKey` 里的 `proposedAt` 对同一份待处理提议是稳定的（`sqlite-owner-proposal-operations.ts:158-186` 的 `refreshed` 分支不更新 `proposed_at`）。提议被重新打开时 `proposed_at` 会更新（`:199`），那会被当成新的待处理事件，而不是同一段文字变成不同字节。Apple 的 `Topic`/`collapseId` 由稳定的 `sourceKey` 派生（`production-web-push.ts` 的 `webPushTopic`，`production-apple-push.ts:376`）。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有。`push-channels.test.ts` 新增了：24 小时外的提议不发、30 份提议只入队最新一份、读取抛错不阻断其他推送、发送时读不到仍发已入队项、受保护类不被 defer、quiet 不读角标、网页 `urgency === "normal"`、`silent` 只对 quiet 生效；`service-worker-feedback.test.ts` 验证 `true`/缺失/字符串 `"true"` 三种情况。按现有断言，若把这些行为改回去，对应测试会失败（例如把 `proposal` 移出保护类会触发 defer 测试，把 24 小时过滤去掉会触发旧提议测试）。
4. **每个新值的使用端都能接受吗？** 增量本身没有产生运行时值，只改了文档锚点和表格。累计 PR 的值逐个核过：`PENDING_PROPOSAL_CEILING`（导出后在 `service-main.ts:2839-2846` 使用，持久层上限 200 接受）、`quiet`（web/Apple 组装和测试接受）、`proposal` 推送类（只在内存闸门和测试里使用，不入库、不入导出 schema）、`silent`（网页负载和 `sw.js` 接受，见 `sw.js:20`）。没有发现像 I-73 那样“清单里的值过不了下游校验”的情况。
