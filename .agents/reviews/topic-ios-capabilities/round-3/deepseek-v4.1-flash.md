## 一、已证实的问题（按严重度从高到低）

> 严重度：P1 高，P2 中，P3 低。

### P1-1 新工具会让所有活跃对话的请求开头变一次，和“只对新对话生效”矛盾

**问题**：方案说“设备工具固定存在……新工具只对新对话生效”。但按现有冻结逻辑，工具名集合一变，活跃对话下一轮就会重建请求头。也就是说，新增“设备工具”和“读当下情况的工具”会让所有已有对话各变一次，不是只影响新对话。

**证据**：
- `packages/application/src/services/thread-prompt-bundle-service.ts:89`：`if (!sameNames(record.identity.toolNames, identity.toolNames)) return "tool_set_changed";`
- 同文件 `:204-205`：工具参数结构变了也会 `tool_schema_changed`。
- `.claude/rules/prompt-prefix.md:41` 第 6 条把“工具集合变了”列为换新条件。

**建议**：二选一并在 ADR 写明：(a) 给新工具加“只对某时间点后创建的对话生效”的发布门，老对话继续用冻结的旧工具；(b) 明确接受一次全量重建，并记录、通知 Andy。不要保留“只对新对话生效”这句没有实现依据的表述。

---

### P1-2 审批/通知按钮的取值和现有合约不兼容，“稍后”没有落点，高风险口头确认不满足 recent auth

**问题**：方案说通知按钮带“同意 / 不用 / 稍后”，点了直接回写。现有审批合约只接受 `approved | denied`，没有“稍后”；v2 还要求 `expectedRevision` 和 `semanticSnapshotHash`，通知按钮只带“审批编号和有效期”不够。高风险审批要求的是受信任身份提供方的近期认证，耳机里口头确认不能产生这个证据。

**证据**：
- `packages/gateway-contracts/src/contracts.ts:97`：`decision: enumeration(["approved", "denied"])`。
- `packages/gateway-contracts/src/contracts-v2.ts:182`：同样只有两个值，并要求 `expectedRevision`、`semanticSnapshotHash`。
- `packages/application/src/services/approval-service.ts:71-76`：`current.recentAuthenticationRequired && !input.response.recentAuthenticationRef` 直接拒绝。
- `packages/application/src/ports/recent-authentication.ts:5-8`：证据来源只有 `cloudflare_access_login_time | built_in_mfa | provider_step_up`，没有“语音确认”。

**建议**：通知按钮不要只带审批编号，改为一个服务器可解析的不透明动作令牌，里面绑定 `approvalRequestId + expectedRevision + semanticSnapshotHash + expiresAt + deviceId`；新增明确的 `defer/snooze` 命令和值，或把“稍后”实现成“关闭通知、不改审批状态”；高风险审批必须用 `UNNotificationActionOptions.authenticationRequired` 加服务器 recent auth，删除“耳机里口头确认”这条路径。

---

### P1-3 APNs 的推送类型/优先级写错，推送去重表也表达不了 APNs 和小组件/实时活动

**问题**：方案把“服务器找设备：提醒、要设备做的动作、小组件数字”统一写成“苹果推送，优先级设 10”。Apple 明确规定：`background` 类型必须用优先级 5，用 10 是错误；`widgets`、`liveactivity` 是另外的 push type。现有 `web_push_feedback` 的 `channel` 只允许 `web_push`，`kind` 只允许 `reminder/approval/run`，主键还是“一件事一行”，无法同时表达 APNs、网页推送、小组件和实时活动。

**证据**：
- Apple《Sending notification requests to APNs》：`background` 类型“Always use priority `5`. Using priority `10` is an error.”；`apns-push-type` 必须和载荷一致，否则“may return an error, delay the delivery of the notification, or drop it altogether.”
- `packages/persistence-sqlite/src/migrations/0061_web_push_feedback.sql:6,9,15`：`kind IN ('reminder','approval','run')`、`channel IN ('web_push')`、`PRIMARY KEY (owner_id, agent_id, source_key)`。
- `packages/persistence-sqlite/src/migrations/0058_web_push.sql:26`：`web_push_outbox.kind` 同样只有三类。

**建议**：按用途分开：用户可见通知用 `alert`（紧急才 10）；后台数据/动作唤醒用 `background`（必须 5）；小组件用 `widgets`；实时活动用 `liveactivity`。小组件刷新和实时活动不要和“用户可见通知”共用同一个来源键，否则一次小组件刷新可能把真正的提醒标记成“已送达”。新增统一的投递决策表，至少支持 `web_push | apns`，并迁移 `channel/kind` 约束。

---

### P1-4 “感知记录不出现在任何对话请求里”和工具读取设计矛盾；删除承诺覆盖不了已经写入历史的工具结果

**问题**：方案一边说“感知记录不拼进对话消息，只进抽取记忆和主动检查”，一边说“对话里需要当下情况时，模型调用固定存在的工具去读”。工具结果本身就是一条消息；按现有规则，它会存进历史并在以后每轮重发。因此：
- 感知记录**会**出现在后续对话请求里；
- 用户删除感知记录后，已经写进对话历史的工具结果仍然在，模型仍能看到；
- “都能看、都能删”对对话历史、提供商请求日志、备份都不成立。

**证据**：
- 方案第 6.2 节和 6.6 节。
- `.claude/rules/prompt-prefix.md:35` 第 4、5 条：存历史存实际发出去的那一条，已发内容只追加。
- 现有事件/消息路径：`packages/application/src/services/product-thread-gateway-adapter.ts:628` 回答文字是事件，但工具结果最终仍作为消息进入历史。

**建议**：把目标改成“感知数据只以追加的工具结果出现，永不写进系统提示、工具定义或已有历史”，不要再写“任何对话请求里”。删除语义要二选一：(a) 对话里只返回短摘要/引用，不返回原始转写，删除时只需删服务器原文和记忆；(b) 允许原始内容进对话，就必须实现“删除这段对话/压缩改写历史”的 ADR 和用户可见说明，并承认提供商日志、备份不可撤回。

---

### P1-5 主人语音会同时走现有 `user_message` 记忆抽取和新感知抽取，重复且可能冲突

**问题**：方案说主人对 Himawari 说的话“当作主人发来的一条消息进对话，和打字完全一样”，又说新增一个“从感知记录抽取记忆”的后台服务，并“不改现有的每轮抽取”。按现有代码，`user_message` 会触发 `AutomaticMemoryService`；同一段话又被感知抽取一遍，可能生成两条来源不同、置信度不同、甚至互相矛盾的记忆，费用也翻倍。

**证据**：
- `apps/agent-service/src/production-memory-capture.ts:720`：`source.sourceType !== "user_message"` 直接返回。
- 方案第 5 节“主人说的原话直接成为正式记忆”、第 6.3 节“当作主人发来的一条消息”、第 9.5 节“单独的提示词，不改现有的每轮抽取”。

**建议**：明确单一权威路径。例如：主人对 Himawari 说的话只走现有 `user_message` 抽取；感知抽取显式排除“已识别为主人且明确对 Himawari 说”的记录。或者反过来，语音统一走感知抽取，并在对话路径里打标记跳过。无论哪种，加去重键（感知记录编号 + 原话哈希）和“同一句话不产生两条记忆”的测试。

---

### P1-6 删除不完整：现有删除只标记来源，不失效记忆；按 `source_id` 删除还会误伤

**问题**：方案引用的现状是“删掉来源只打标记，记忆还在”。但方案又承诺“删除一段感知记录：只由它产生的记忆一起作废，不再被想起；有多个来源的记忆去掉这一条来源并重新评估”。现有删除代码只把 `memory_provenance.source_deleted = 1`、把 `memory_records.source_thread_id` 置空，并不会删除或失效记忆，也不会重新评估。更危险的是，run/task 删除是按 `source_id` 单独匹配的，不带 `source_type`；如果感知记录编号和 run/thread 编号落在同一命名空间，会误把别的来源标成已删除。

**证据**：
- `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:759-775`：只更新 `source_deleted` 和 `source_thread_id`。
- 同文件 `:804`、`:838-841`：`UPDATE memory_provenance SET source_deleted = 1 WHERE source_id = ?`，没有 `source_type`。
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:842-843`：写入来源时 `source_type` 固定为 `'reference'`，方案要新增“感知记录”来源需要改写入路径。

**建议**：删除必须按 `(source_type, source_id)` 复合键；所有感知记录编号加全局唯一前缀（方案的新值清单里已有“记忆来源前缀”，但还要有“感知记录前缀”）。删除逻辑要明确“失效记忆、撤出向量索引、撤出档案块、撤出主动检查、撤出导出”，并补测试。对已导出文件、备份、提供商日志，明确写“不可撤回”而不是“覆盖导出”。

---

### P1-7 新模型出口的敏感信息遮盖和数据分级没有落到门禁

**问题**：方案新增多条会发给模型的路径：感知抽取、感知主动检查、照片/屏幕/短信理解。方案只说“沿用现有的数据分级和路由规则”，但没有给每种感知数据指定分级，也没有说这些新路径必须经过统一出口。现有 `check:egress-redaction` 会拒绝未登记的模型出口；不登记就发不出去，登记了但没走遮盖就会泄露密码、验证码、银行卡等。

**证据**：
- `docs/adr/0148-send-every-model-request-through-one-in-process-egress.md:47` 第 9 条：`npm run check:egress-redaction` 要求登记出口，拒绝未登记的模型或嵌入请求出口。
- `packages/application/src/services/model-visibility.ts:10-14`：`public/private/sensitive` 对模型可见，`restricted` 不可见。
- 方案第 9 节数据去向表只写“会发给模型服务方：是”，没有分级和遮盖门禁。

**建议**：给每种感知数据定分级（例如旁人语音、短信、健康、精确位置至少 `sensitive`，必要时 `restricted`）；所有新模型路径必须走 `ModelEgress`；在 `check:egress-redaction` 登记，并加一条 I-78 式测试：感知抽取提示里的固定文字不被误遮、外来内容里的密码/验证码被遮。还要在数据去向表里写清哪类数据会到哪一档模型/服务商。

---

### P1-8 提示注入只有提示词和评测，没有确定性强制；感知内容可以触发记忆转正、日历和审批

**问题**：方案说“提示词固定写明不照做，并用评测守住”。但网页正文、短信、屏幕文字、旁人说话都是不可信输入；只靠提示词和评测，不能阻止模型被诱导去调用设备工具、创建日历、转正记忆或发起审批。尤其“听到的约定和待办，直接建提醒或日历事件”是一个从不可信环境音频直接产生副作用的路径。

**证据**：
- 方案第 6.3 节：“它们可能夹带……提示词固定写明不照做，并用评测守住。”
- 方案第 5 节：“时间和对象清楚的，直接建提醒或日历事件并告诉主人，可一键撤销。”
- 现有确定性保护只在审批/授权层：`packages/application/src/services/approval-service.ts` 会校验快照和 recent auth，但感知抽取和自动建日历不走这条路径。

**建议**：在入口处给数据打“可信指令/不可信数据”标记（主人声纹 + 明确唤醒才可信）；代码层强制“不可信内容不能创建正式记忆、不能自动建日历、不能发起审批”，而不是只写在提示词里。评测用 `ScriptedModelPort` 返回恶意输出，断言仍不产生副作用；再加真实模型的提示注入评测作为补充，不作为唯一门禁。

---

### P1-9 WebSocket 只在握手验身份，吊销不即时；Cloudflare 服务令牌是账号级共享凭据

**问题**：方案说“连接建立时用设备密钥签名验证，之后这条连接上的消息不用逐条签名”，并说“逐台吊销，立即生效”。现有网页 SSE 在每次事件时都会 `revalidate` 身份；新长连接如果只在握手验一次，吊销设备后旧连接仍能继续发消息，直到连接自然断开。Cloudflare 服务令牌是账号级 Client ID/Secret，不是每台设备一把；删一个服务令牌会同时影响所有设备，不能替代应用层的逐设备吊销。

**证据**：
- 方案第 7.3 节“身份只验一次”。
- `packages/platform-node/src/http-gateway-server.ts:1131-1132`：现有 SSE 每条事件调用 `options.authentication.revalidate?.(authentication)`。
- Cloudflare 文档：服务令牌由 Client ID + Client Secret 组成；要撤销访问必须删除令牌；“As long as the Client ID and Client Secret are still valid, they can be exchanged for a new token on the next request.”（<https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>）

**建议**：长连接定期 `revalidate`，设置最大连接寿命；设备吊销时主动关闭该设备的所有连接；每台设备用独立的服务令牌或应用层每消息/每会话签名；服务令牌只当网络层门，不作为设备身份。加测试：吊销设备后，已建立的连接在下一个心跳/消息被拒绝并关闭。

---

### P1-10 设备动作和日历同步缺少幂等与“结果未知”，可能重复执行不可逆动作；自动建日历可能发邀请

**问题**：方案说“设备执行并回报”“执行后读回来核实”，但没有定义动作的唯一键和 `result_unknown` 语义。如果设备已经建了日历/闹钟/家居动作，网络在回报前断了，服务器重试可能重复执行。另一个具体风险：自动创建日历事件时如果带了参与者，可能触发对外邀请，而方案自己规定“对外发送要确认”。

**证据**：
- 方案第 5 节能力四、第 6.3 节“涉及钱、删除、对外发送的仍然要确认”。
- 现有 durable 执行已经有“结果未知/不自动重放”的模式（例如 `run-execution-source.ts`、`durable-background-work-service.ts` 的 `result_unknown` 处理），但方案没有复用。

**建议**：每个动作带服务器生成的幂等键，设备侧持久化去重；服务器记录“已派发/执行中/结果未知/已核实”，结果未知时禁止自动重试，只允许读回或人工确认。自动创建的日历事件默认不带参与者、不发邀请；带参与者或对外通知必须确认。联系人和日历双向同步先做只读，写入用 per-record revision/ETag、冲突策略和撤销。

---

### P2-1 主动检查的端口和表都是 Gmail 形状，新增来源不止迁移一个 CHECK

**问题**：方案说“主动检查改成来源登记”，但现有端口、类型和表都写死了 Gmail 的字段和约束。新增“感知记录”来源时，`ProactiveSourceItem` 的 `messageId/threadId/from/subject/snippet/link/body/attachments` 没有对应语义；`source_insights` 的唯一键 `(source, thread_id)` 对“一段经历”也不成立；`skip_reason` 只有 `category/sensitive/own_mail`，没有“旁观者/不可信”等原因。

**证据**：
- `packages/application/src/ports/proactive-checks.ts:4`：`ProactiveSource = "gmail"`。
- 同文件 `:40-57`：邮件字段；`:421-455`：`ProactiveSourceItem`/`ProactiveSourceReader` 也是邮件读取器。
- `packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:11,80,102`：`scenario/source IN ('gmail')`；`:94`：`UNIQUE (owner_id, agent_id, source, thread_id)`；`:107`：`skip_reason IN ('category','sensitive','own_mail')`。

**建议**：先定义来源中立的 `ProactiveSourceItem`（如 `sourceId`、`occurredAt`、`participants`、`contentRefs`、`dataClassification`）和每个来源自己的适配器；新增来源时同时迁移 `decision_ledger.scenario`、`source_insights.source`、`proactive_processed_messages.source`、去重键、`skip_reason`、UI 和导出。把“来源名、场景名、去重键、跳过原因”一起写进新值清单。

---

### P2-2 后台文件上传按“每条一个文件”，和 Apple 的批量/限流建议冲突

**问题**：方案说“连接不在时，写成文件交给系统代传；每条带唯一编号”。Apple 的 background URLSession 文档明确建议少开会话、批量传输；如果每天数千条感知记录各建一个上传任务，会撞上系统限流和任务开销。

**证据**：Apple《Downloading files in the background》：“Only upload tasks from a file are supported”；“use a small number of background sessions — ideally just one — and use these sessions to start many download tasks at once”；“If you find you need to launch thousands of download tasks, change your design to perform fewer, larger transfers.”（<https://developer.apple.com/documentation/foundation/downloading-files-in-the-background>）

**建议**：设备端把多条感知记录攒成一个有界批次文件（或一个请求里的多条记录），用单个 background session 上传；保留每条记录的唯一编号用于去重；设置队列上限、最旧丢弃/告警、指数退避。不要按“每条一个文件”设计。

---

### P2-3 持续云端转写所有环境音，隐私、成本和法律风险没有闭合

**问题**：方案写“一直在转文字”“旁人说的话也转成文字上传，全部交给模型理解”“默认全开”。如果按服务器转写，等于把主人和旁人的全天音频持续送到服务器；如果按设备转写，也仍然持续采集。方案自己也说日本/中国关于录到旁人的法律只有二手来源、未核实。

**证据**：方案第 5 节“听”、第 7.4 节“边说边传”、第 9 节数据去向表；第 13 节第 8 条“日本和中国关于录到旁人的规定，现在只有二手来源”。

**建议**：默认在设备本地做人声检测和唤醒词，只在唤醒后或明确开启“持续环境记录”时才上传相关片段；对旁观者语音做数据最小化（不建人物档案、默认短保留、可一键删除）；第三方转写服务必须逐语言、逐服务单独同意，并写清保留和训练条款；在动工前做法律复核，不要用“默认全开”绕过。

---

### P2-4 “紧急的永远立刻送”忽略 Focus 和 Critical Alerts 的平台限制

**问题**：方案说“紧急的永远立刻送”。iOS 的专注模式、通知摘要、静音都可能影响送达；要穿透专注模式，普通通知只能用 `.timeSensitive`（且用户允许时），`.critical` 需要 Apple 特批的 Critical Alerts entitlement，个人侧载 App 不能假设拿得到。

**证据**：Apple `UNNotificationInterruptionLevel`：`timeSensitive` “breaks through system notification controls”；`critical` 需要对应能力（<https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel>）。方案第 5 节能力二写“紧急的永远立刻送”。

**建议**：把“永远”改成“在系统允许的范围内尽力”：紧急用 `.timeSensitive`，高风险/安全告警另外评估 Critical Alerts；把 Focus、通知权限被关、低电量模式列入“平台做不到/只能尽力”的清单，并在“用量/状态”页显示当前通知是否会被系统抑制。

---

### P2-5 检查门禁没有真正接线，部分反向用例按现在的写法不会失败；评测样本量缺失

**问题**：方案第 12 节列了很多门禁，但：
- `npm run check:prompt-prefix` 只跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`，只统计 `[I-66]` 标签，要求至少 8 条并包含 4 个 `[COMPACT-*]` 名字；把“感知记录不出现”加进去并不会自动生效，还要改 `REQUIRED` 和测试文件。
- “感知记录不出现在任何对话请求里”和工具读取设计矛盾（见 P1-4），按字面写必然失败或写成假测试。
- “夹带指令的感知记录不能改变工具选择/审批/记忆转正”如果依赖真实模型，不是确定性门禁；必须用脚本模型 + 代码层拒绝。
- “第 7.7 节每个计时数字超过门槛就拒绝上线”在目标值还没定之前无法运行。
- 评测集写着“带样本量”，但正文没有给任何样本量。

**证据**：
- `scripts/check-prompt-prefix.mjs:9-11,28,44-52`。
- 方案第 12 节最后一段：只有评测类别，没有数字。
- 方案第 7.7 节：“目标值不在这里拍脑袋写。先测出现在网页的基线，再定每一项的目标”。

**建议**：为每条门禁写清“守卫是什么、去掉哪个守卫会让哪条反向用例失败、在哪个测试文件跑”。新增一个应用层集成测试：开启/关闭感知、配对/不配对设备时，系统提示、工具定义和已有历史逐字节相同；只有末尾不同。提示注入用脚本模型返回恶意输出，断言代码层仍拒绝。先补评测样本量和验收阈值，再谈“拒绝上线”。

---

### P2-6 新值清单漏了关键值，逐项核对会撞上现有校验

**问题**：方案第 9 节的“新值清单”方向对，但漏了这些会被现有合约/数据库拒绝或误用的值：

| 新值 | 产生处 | 使用处/校验 | 结果 |
|---|---|---|---|
| 通知按钮“稍后” | 通知动作 | `contracts.ts:97` / `contracts-v2.ts:182` 只接受 `approved/denied` | 被拒 |
| 审批按钮的设备绑定 | 方案第 5 节 | 审批合约没有 `deviceId` 字段；只有 `approvalRequestId/runId/decision/semanticSnapshotHash` | 无法校验“发给别的设备” |
| APNs 通道 | 苹果推送 | `0061_web_push_feedback.sql:9` `channel IN ('web_push')` | 存不进 |
| widget/liveactivity 类型 | 苹果推送 | `0058_web_push.sql:26` `kind IN ('reminder','approval','run')`；`0061:6` 同 | 存不进或去重错 |
| 感知来源的跳过原因 | 感知主动检查 | `0069_decision_ledger.sql:107` 只有 `category/sensitive/own_mail` | 被拒 |
| 感知来源的去重键 | 感知主动检查 | `0069:94` `UNIQUE (source, thread_id)`，感知没有 Gmail thread | 不成立 |
| 感知记录的决策 `kind`（若新增） | 决策记录 | `0069:5-9` 固定六种 `kind` | 被拒 |
| 导出格式中的感知记录 | 数据导出 | `data-export/schemas.ts`、`FORMAT_VERSION`、导入校验 | 需要新格式版本和导入测试 |
| 设备编号 | 配对 | `packages/domain/src/identifiers.ts:39` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | 带 `/`、`=`、base64 的编号会被拒 |
| APNs 设备令牌 | 注册推送 | Apple：“Don't make assumptions about device token size.” | 不能固定 64 位十六进制 |
| 感知数据分级 | 新模型路径 | `model-visibility.ts:10-14` 只有前三级对模型可见 | 不指定就可能误发或误挡 |

**建议**：把上表逐项补进“产生处、使用处、两端校验、自动检查”。每个新枚举值都要有“生产者生成的值能通过消费者校验”的合同测试（I-73 的教训）。特别是“稍后”、APNs 通道、widget/liveactivity、skip reason、设备编号/令牌格式。

---

### P3-1 文档和规则不一致：Mac 测试规则不止一处，附件也不在当前仓库

**问题**：方案说“改写‘不在 MacBook 上运行测试’的规则”，但这条规则不在一处：`.agents/instructions/test-and-production-hosts.md:8` 明确“绝不在用户的 MacBook 上运行 Himawari 测试”，同文件 `:16` 还说 Mac 验证“已无限期推迟”；此外 ADR 0041/0044/0047/0050 等也重复了这条。只改一处会造成文档和代码/流程互相矛盾。另外，方案引用的 `verified-apis.md` 和 `../ios-app-eval/` 在当前检出中找不到，标“已核实”的接口无法复核。

**证据**：
- `.agents/instructions/test-and-production-hosts.md:8,16`。
- 当前仓库 `glob` 找不到 `verified-apis.md` 和 `ios-app-eval/`。
- 方案第 2 节自己承认 ChatGPT/Claude 的对比“没有逐个找一手来源”。

**建议**：列出所有需要改的规则文件和 ADR，逐条更新；把 `verified-apis.md`、TaoSheng 笔记等附件纳入仓库或改成可访问的链接；业界对比要么补一手来源，要么明确标“线程判断，未核实”。

---

## 二、推测与未核实（需要动工前验证）

1. **抢跑的半句可能被存成消息再被最终句替换**：方案只说“准备阶段不产生发给模型的内容”，没说半句是否进入 thread history。如果进入后再替换，就是典型的 I-66 重演。需要在设计里明确“半句只进临时准备缓存，永不进历史”。
2. **服务器重做转写可能替换已存文本**：方案第 8 节说“服务器始终具备全部三步能力，可以重做”。如果“重做”是覆盖已发出去的用户消息，就违反只追加；必须改成“追加一条更正”或“首次只选一条路”。
3. **新增来源/工具/动作列表的顺序可能不稳定**：方案没有规定 registry、DB 查询、Map/Set 的排序。按 `prompt-prefix.md:51` 第 10 条，必须固定顺序；否则同一段文字在不同请求里可能变成不同字节。
4. **遮盖依赖可变的感知记录**：如果感知记录会进入“点名值”集合，删除/修改感知记录可能让同一段历史遮出不同字节。需要把遮盖的“点名值”限制在当前请求前面的对话消息里，不依赖可编辑的感知表。
5. **长连接断线超过事件保留期**：现有 SSE 有 `afterCursor`，但方案没写事件保留多久、游标太旧时怎么全量重同步。需要补“游标失效 → 重新取快照”的路径。
6. **Mac 任意 App/文件操作的安全边界**：方案只写“ Mac 上能做的更多（打开文件、操作 App，详细设计时列）”。这是高风险面，必须用现有 capability manifest/allowlist、逐动作审批和沙箱，不能留到详细设计才想。
7. **手表后台自己开麦、Mac 无后台限制、HTTP/3 网络切换不重连、生产机地区、OpenAI WebRTC 原话**：方案已标“未核实”，继续保持；不要把它们当既定前提写进 ADR。
8. **第三方转文字服务的费用/保留/训练条款**：方案只写“约 2 美元/月”，没有服务商的数据处理条款和删除承诺。
9. **Apple 论坛关于后台录音的回复不是官方文档**：方案前提 16 引用的是开发者论坛回复；应补官方 `UIBackgroundModes`/AVAudioSession 文档，或继续标“未核实”。
10. **“紧急永远立刻送”之外的 Focus/低电量/通知权限限制**：需要真机验证，不要用“永远”承诺。

---

## 三、侧重检查

我按“错误路径、不合规范/不可信输入、安全、资源耗尽、不可撤销操作、规则/文档一致性”逐项查了：

- **错误路径**：设备动作回报丢失、网络切换、进程被杀、服务重启后的 `result_unknown` 没有在方案里定义；现有 durable 执行有这类模式，但方案没有复用。删除路径只标记来源，不失效记忆。推送失败/过期/重复没有跨通道路径。
- **不合规范/不可信输入**：网页、短信、屏幕文字、旁人语音都是不可信输入；方案只靠提示词和评测，代码层没有“不可信内容不得产生副作用”的强制。设备消息编号、设备公钥、APNs 令牌、动作类型都没有格式和长度约束。
- **安全**：长连接只在握手验身份；服务令牌是账号级共享；设备吊销不能即时关闭连接；Mac 任意 App/文件操作没有能力清单；嵌网页的短期会话没有 origin 绑定；新模型路径没有强制走统一遮盖出口；第三人语音和画像没有默认关闭。
- **资源耗尽**：全天音频转写、整个相册、屏幕直播、每秒 OCR、每条一个后台上传任务、去重表增长、服务器转写队列都没有明确上限/背压/丢弃策略。方案有“每个上限都看得见”的方向，但没有落到服务端准入和队列。
- **不可撤销操作**：自动建日历可能发邀请；设备动作可能重复执行；联系人/日历双向同步没有冲突和撤销；删除感知记录无法撤回已进入对话历史、导出文件、备份和提供商日志的内容。
- **规则/文档一致性**：新工具“只对新对话生效”和现有 `tool_set_changed` 重建逻辑矛盾；“感知记录不出现在任何请求里”和工具读取矛盾；“Mac 测试规则”散落在多个文件和 ADR；附件不在仓库；业界对比缺一手来源。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先解决“请求开头”这件事，再谈功能。** 新增设备工具和读情境工具必须有一个明确的发布门：老对话继续用冻结的旧工具，新对话才带新工具；或者出 ADR 明确接受一次全量重建。否则方案的核心承诺不成立。
2. **重新定义感知与对话的边界。** 感知数据只以“追加的工具结果”进入对话，系统提示、工具定义、已有历史永不写入；对话里默认只返回短摘要/引用，原始转写留在服务器。删除只承诺“服务器原文 + 记忆 + 索引”，对已进入历史/导出/备份/提供商日志的内容明确写“不可撤回”，不要用“都能删”误导。
3. **记忆只保留一条权威路径。** 主人对 Himawari 说的话走现有 `user_message` 抽取；感知抽取排除这类记录。旁人的话、电视、网页、短信只当线索；不默认给第三人建人物档案。
4. **审批和通知重新设计值域。** 用不透明动作令牌绑定 `approvalId + revision + semanticSnapshotHash + expiry + deviceId`；新增 `defer/snooze` 命令；高风险只接受解锁/生物识别 + 服务器 recent auth，不接受语音确认。
5. **推送按用途分层。** 用户可见通知用 `alert`；后台唤醒用 `background` + priority 5；小组件 `widgets`；实时活动 `liveactivity`。小组件/实时活动不要和提醒共用同一个来源键。新增 `apns` 通道和统一投递决策表。
6. **设备动作和同步先做安全的最小集。** 先做只读感知和一个设备动作（例如“写提醒”），每动作带幂等键、`result_unknown`、读回核实、不自动重放；日历自动创建默认不带参与者、不发邀请；联系人/日历双向同步延后，先做只读。
7. **上传和设备端资源有界。** 设备端批量上传，单 background session；设置队列上限、最旧丢弃/告警、指数退避；默认本地 VAD/唤醒词，不做全天云端转写。
8. **门禁重写。** 每条门禁写清守卫和反向用例；新增应用层“新旧工具逐字节”测试、“感知不写入系统/工具/旧历史”测试、“提示注入不产生副作用”的脚本模型测试、“吊销设备关闭连接”测试、“APNs/网页推送只到一处”的跨通道测试；补评测样本量。
9. **文档一次改全。** 更新 Mac 测试规则涉及的所有文件和 ADR；把 `verified-apis.md`、TaoSheng 笔记纳入仓库；业界对比补一手来源或标“未核实”。
10. **分阶段上线。** 先做“配对 + 固定工具 + 一个只读感知类型 + 删除 + 用量页”，用网页上贴一段文字当感知记录验收；再扩到语音、照片、屏幕、设备动作。不要在第一步就开全天听和 Mac 任意操作。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**会，按现有代码至少会变一次。** 新增设备工具/读情境工具会让 `thread-prompt-bundle-service.ts:89` 的 `sameNames` 判断失败，返回 `tool_set_changed`，所有活跃对话下一轮都会重建冻结的工具和系统提示，请求开头从工具定义处开始变。方案说“只对新对话生效”，但现有代码没有这个发布门；需要额外实现。

如果把发布门做出来，那么：
- **已有对话**：系统提示、工具定义、历史都不变；只有新对话在开头带新工具。这是符合 `prompt-prefix.md` 第 6 条的。
- **感知记录**：只能以“追加的工具结果”出现在末尾，不能写进系统提示、工具定义或已有历史。方案说“不出现在任何对话请求里”是错的；工具结果会存进历史并重发。
- **每轮会变的值**：当前时间、情境、记忆等只能放在最后一条用户消息或追加的工具结果里；方案说配置不进系统提示/工具定义，方向对。
- **半句抢跑**：半句不能存成 thread message 再被最终句替换；只能进临时准备缓存。服务器重做转写也只能追加更正，不能覆盖。
- **遮盖**：如果新路径都走统一 `ModelEgress`，且遮盖只依赖当前请求前面的内容，字节是确定的；但不要让可编辑/可删除的感知记录进入“点名值”集合。

结论：**按方案现在的写法，不能保证只追加；新工具会全量变一次。必须加发布门或明确接受一次重建。**

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**有风险，方案没有规定到可以保证的程度。** 主要不是“带时间的字段”一项，而是：
- 新增的主动检查来源、设备动作类型、感官类型如果从数据库/Map/Set 遍历生成，顺序可能不稳定；
- 工具参数 enum、来源登记表、评测清单如果没有固定排序，序列化字节会变；
- “多久之前的”这类相对时间如果每轮重算并回写旧消息，会改历史；只有“按实际发出内容存历史”才稳定；
- 抢跑的半句如果被存成消息再替换，或服务器重做转写覆盖旧文本，会改字节；
- 如果遮盖的“点名值”来自可编辑/可删除的感知记录，删除一条感知记录可能让同一段历史遮出不同字节。

建议：所有新增列表显式 `ORDER BY`，所有 JSON 用固定键顺序，所有枚举在构建时固定；准备阶段只产出临时材料，最终请求只组装一次并按实际发出内容存历史；加“同一输入重复组装逐字节相同”和“删除感知记录不改变已有历史字节”的测试。

### 3. 改动有没有对应的自动检查，反向用例是不是真的会失败？

**部分有，但按方案现在的写法，至少 6 条不会真正拦住回归：**
- `check:prompt-prefix` 只跑 Pi 兼容测试文件，只统计 `[I-66]` 标签，要求 8 条并包含 `[COMPACT-*]`；把“感知记录不出现”加进去不会自动生效，还要改 `REQUIRED` 和测试文件。
- “感知记录不出现在任何对话请求里”和工具读取设计矛盾，按字面写必然失败或只能写成假测试。
- “夹带指令的感知记录不能改变工具选择/审批/记忆转正”如果靠真实模型，不是确定性门禁；必须用脚本模型 + 代码层拒绝。
- “同一件事经苹果推送和网页推送只到一处”没有跨通道投递表；现有 `web_push_feedback.channel` 只有 `web_push`。
- “过期、重复、发给别的设备的动作和按钮都被拒绝”没有设备绑定字段；审批合约里没有 `deviceId`。
- “第 7.7 节每个计时数字超过门槛就拒绝上线”在目标值未定时无法执行。
- “删除感知记录后，只由它产生的记忆不再被想起”现有删除只标记 provenance，不失效记忆；门禁必须断言记忆状态和索引，不只断言 `source_deleted`。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

**不能都接受。** 已核对到的具体冲突：
- `approved/denied` 不接受“稍后”；`contracts.ts:97`、`contracts-v2.ts:182`。
- 审批 v2 需要 `expectedRevision` 和 `semanticSnapshotHash`，通知按钮只带审批编号和有效期不够；`contracts-v2.ts:182`、`approval-service.ts:36-60`。
- 高风险审批需要受信任的 recent auth，语音确认不产生；`approval-service.ts:71-76`、`recent-authentication.ts:5-8`。
- APNs `background` 不能用 priority 10；`widgets/liveactivity` 是另外的 push type；Apple 文档原文。
- `web_push_feedback.channel IN ('web_push')`、`kind IN ('reminder','approval','run')` 不接受 APNs/widget/liveactivity；`0061_web_push_feedback.sql:6,9`、`0058_web_push.sql:26`。
- 主动检查来源/场景的 DB CHECK 只有 `gmail`；`0069_decision_ledger.sql:11,80,102`。
- 主动检查的跳过原因只有 Gmail 三种；`0069:107`。
- 主动检查的去重键 `UNIQUE (source, thread_id)` 不适用于“一段经历”；`0069:94`。
- `trigger.source_type` 只有 `user_message/schedule/external_event`；`0001_initial_product_schema.sql:133`。如果任何感知/设备路径要用新来源类型，会被拒。
- 删除按 `source_id` 不带 `source_type`，会和感知记录编号冲突；`sqlite-governed-deletion.ts:804,838`。
- 记忆来源写入固定 `'reference'`，新增“感知记录”来源要改写入路径；`sqlite-memory-operations.ts:842-843`。
- 设备编号必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`；`identifiers.ts:39`。
- APNs 设备令牌长度不能假设固定；Apple 文档“Don't make assumptions about device token size.”
- 新增感知记录进导出需要新的导出格式版本和导入测试；`data-export/schemas.ts`、`FORMAT_VERSION`。
- 感知数据分级没有指定；`model-visibility.ts:10-14` 决定哪些能发给模型。

这些都要在“新值清单”里补全，并逐项写“产生处、使用处、两端校验、自动检查”。尤其是“稍后”、APNs 通道/类型、设备绑定、skip reason、设备编号/令牌格式。
