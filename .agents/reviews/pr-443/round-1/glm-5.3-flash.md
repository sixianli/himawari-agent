# PR 443 复核结论（基准 79534150 → 8aeba5f5）

## 发现的问题（按严重度从高到低）

**中 · apps/agent-service/src/production-apple-push.ts:171-179 — 「清除推送」只发给登记过 alert 类型且配置匹配的设备，其余设备吊销前收不到清除推送。**
读代码证实：`wipeDevice` 只 `listRegistrations({ pushType: "alert" })`，且循环里 `if (!this.#configured(registration)) continue;`。一台只登记了 `widgets`/`liveactivity`、或其登记的 topic/environment 不在当前配置名单里的设备，被吊销时一条清除推送都不发，而作者说法第 6 条目标是「先给它发一条清除推送」无条件成立。建议：回退用任一可用登记（widgets/liveactivity）发 `background` 清除推送，或在文档里写明这个限制。

**低 · packages/persistence-sqlite/src/sqlite-apple-push-operations.ts:289-298 — 通道升级是单向的：一旦 source_key 有过任何 web_push 尝试行，之后才登记的 iPhone 永远收不到这条的 APNs 版本。**
读代码证实：第一条语句把 `channel IS NULL` 的行路由到 apns 的条件是「不存在任何通道的 attempts 行」；第二条只做 apns→web_push 回退（:302-321），没有 web→apns 升级。设计文档 §11（docs/execution/specs/2026-11-11-apple-device-body-design.md:485）写「有可用的 iPhone 推送令牌就走苹果推送」，没写清「登记之前已走 web_push 的历史条目是否升级」。行为可解释为去重，但和设计文字有出入。建议：在设计文档里补一句。

**低 · apps/agent-service/src/production-apple-push.ts:145,488-500 — `#activityStarts` 集合只在内存里增、从不清理，服务长期运行会缓慢增长。**
读代码证实：`this.#activityStarts.add(key)`（:500）没有对应的删除；每个「设备×运行」一个键。推测：按实际运行量，增长速度很慢，但没有上限护栏。建议：加容量上限或随 `removeRegistration` 清理。

**低 · apps/agent-service/src/production-apple-push.ts:286-342 — 同一条审批通知每次重试都重新签发一对按钮凭据。**
读代码证实：`#sendAlert` 每次尝试都调 `#actions` → `issueActionTokens`（表无去重约束），重试路径（pending→下次 due）会为同一 sourceKey 累积多行凭据，靠 7 天+过期才 prune。无害但浪费。建议：按 (deviceId, sourceKey, action) 幂等。

**低（信息） · packages/gateway-contracts/src/client-capabilities.ts:172-177,195-196 — 本 PR 顺手补了 8 条与苹果推送无关的 v2 能力表登记。**
读代码证实：这些类型（memory.external.*、device.pairing.*、device.rename/revoke、device.list.read、server.status.read）在基准提交 79534150 的 contracts-v2.ts 里就已存在，而基准的能力表没登记——基准上 `client-capabilities.contract.test.ts:33` 的「每个类型恰好登记一次」用例应当是红的；本 PR 把表补齐并同步重生成 Swift（clients/macos/Sources/Generated/ClientCapabilities.swift，client-parity 测试约束两者一致）。属于对前一批遗留的修复，但 PR 说明未提及。建议：在 PR 说明里补一句。

**低（信息） · packages/persistence-sqlite/src/migrations/0095_apple_push.sql:1 — `companion_of` 外键没有 ON DELETE 规则。**
读代码证实：`REFERENCES paired_devices(id)` 默认 NO ACTION。我读到的所有路径都只把 paired_devices 置 `revoked`、不删行，所以目前不会触发；但将来引入物理删除时会因为被手表引用而失败。推测：风险很低。建议：加注释性说明或 ON DELETE SET NULL（SQLite 重建列成本高，也可只留记录）。

**未核实（低风险推测） · 日志泄漏残余面 — 作者说法第 9 条基本成立，但有一处我无法完全排除。**
读代码证实：`onDelivery` 只记 pushType/kind/code（service-main.ts），`onFailure` 只记 `stableErrorCode(error)`，`DevicePushError` 的 message 就是错误码本身（device-push.ts:35-44），凭据拒绝原因（unknown/other_device/…）不出进程（device-push.ts:196-202 统一映射为 410）。设备令牌出现在 HTTP/2 请求路径 `/3/device/{token}`（apple-push-sender.ts:141），node:http2 的底层错误对象理论上可能带 URL；`stableErrorCode` 的实现我没读，「错误信息里绝不出现令牌」无法百分之百证实。建议：复核 `stableErrorCode` 对 http2 错误的处理。

## 侧重检查（普通流程走查 + 覆盖情况）

流程：iPhone 登记（POST push/register → DevicePushService.register → saveRegistration）→ 审批入 outbox（channel NULL）→ ProductionWebPush.#deliver → companion.deliver → routeOutbox（NULL→apns）→ listDue → #sendAlert → issueActionTokens（只存 sha256）→ APNs 发送 → recordAttempt/feedback → 用户点按钮（POST approvals/respond → takeAction → 原子消费 → dispatch approval.respond）→ 网页吊销（beforeRevoke 清除推送 → revokeDevice → disablePushForRevokedDevices）。

- 有测试覆盖：登记正反例、三通道投递与回退、按钮凭据全部正反例（含并发双击）、sender 全部行为、迁移保数据、吊销删凭据、导出不含凭据（push-channels 9 例、notification-actions 13 例、sender 7 例、迁移契约 1 例——条数与作者说法一致，我逐一数过）。
- 没有测试覆盖的路径（推测，基于已读测试清单）：wipeDevice 对「无 alert 登记/配置不匹配」设备的行为；web_push 已有尝试行之后登记 iPhone 的通道升级；`markRegistration` 里 `DEVICE_REVOKED` 不可覆盖的守卫（:270）；7 天 prune 的实际触发；`npm run check` 51 步与 `npm run build` 我无法运行，未核实。

## 必答问题逐条回答

1. **不会改变模型已见过的请求开头。** 读代码证实：整个 diff 不含 prompt-catalog、runtime-pi、thread-prompt、系统提示或工具定义相关文件；新增路径（push/register、approvals/respond、companions、feedback）通向审批网关和推送，不组装任何发给模型的请求；`npm run check:prompt-prefix` 的比对范围（messages 逐字节、其余字段按值）没有输入来源变化。会变的值（通知按钮凭据、APNs 负载）全部在推送与设备通道里，不在模型请求里。
2. **不会。** 读代码证实：改动新产生的序列化（APNs JSON、SQLite 行、导出文件）都不进入模型请求；`homeDigest` 对 approvals/reminders 显式排序（production-apple-push.ts:586-601）；无时间字段、无依赖前后文的遮盖改动。tokenHash 前 40 位作幂等键是确定性的。
3. **有，反向用例真实会失败。** 读代码证实：迁移契约测试反向插入旧格式/非法 channel 会抛错（apple-push-migration.contract.test.ts:108-136）；并发双击一次 200 一次 410（notification-actions.test.ts:353-365）；外设备/过期/审批变更/重复使用均 410（:311-351）；presence-approve 无确认签名 403 且凭据不作废（:240-271）；sender 对超 4096 字节不发、连不通/超时 retry（apple-push-sender.test.ts:128-183）；配置缺 webPush 必败（startup-configuration.unit.test.ts 新增用例）；导出逐文件断言凭据字节不出现且导入后两表为 0（data-export.test.ts 新增反向用例）。未核实：layer0 清单登记、`npm run check` 实际运行结果。
4. **逐值两端核对通过，仅上述几个低危缺口。** 读代码证实：`apn_` 编号（生成 `apn_`+22 位 base64url ⇔ DB CHECK 长 26 且前缀 apn_ ⇔ saveRegistration 正则，消费端 attempts.subscription_id/markRegistration 无格式冲突）；token_hash（sha256 64 位 hex ⇔ DB CHECK ⇔ 路由 idempotency 键）；outbox.channel（routeOutbox 只写 'apns'/'web_push' ⇔ 列 CHECK ⇔ 两个 listDue 的过滤条件互补）；attempts 的 channel/push_type 成对约束与两个写入方一致；feedback.channel CHECK 放宽且写入方匹配；companion_of（setCompanion 校验 watch/iphone ⇔ 列 CHECK kind='watch' ⇔ ELIGIBLE_ALERT_REGISTRATION 与凭据转显两端消费）；导出清单、schema-catalog 描述、SUPPORTED_SCHEMA_MAX=95、check-data-export 86 条、Swift 生成文件均同步。核对过的结论与作者九条说法全部一致（第 6、9 条见上面的低危备注），未发现说法与代码相反之处。
