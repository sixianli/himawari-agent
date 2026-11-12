## 结论摘要

本 PR 确实只有文档和指令文件，没有改运行代码，因此它本身不会改变发给模型的请求字节。但它是一份会指导后续实现的详细设计和 ADR，里面有几处会直接影响安全边界、数据删除和跨文档一致性的问题；其中“嵌入网页会话”一条会让设备命令白名单失效，建议在动工前修掉。

以下先写读代码能证实的，再写推测/未核实，最后单独写「侧重检查」并逐条回答必答问题。

---

## 一、读代码证实的问题

### 1. 高：设备凭据换来的网页会话会绕过“设备只能做白名单命令”的边界

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:188`、`:229`；`docs/adr/0229-native-apple-clients-and-device-api.md:102`
- 问题：设计一边说设备只能调用 `/api/device/v1/` 白名单里的命令，另一边又让 App 用设备签名换一个“走现有网页接口和同源检查”的短期网页会话。如果这个会话就是现有主人网页登录会话，那么设备（或拿到设备签名的人）可以借它改规则、删记忆、导出数据，设备命令白名单不再是一道边界。
- 证据：
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:188`：“App 用设备签名向服务器换一个短期的网页会话（默认 1 小时），之后嵌入页面走现有的网页接口和同源检查。”
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:229`：“设备接口里没有‘改规则’‘删记忆’‘导出数据’，这些只在嵌入的网页里做，走网页自己的登录。”
  - `docs/adr/0229-native-apple-clients-and-device-api.md:102`：“设备能调用的命令是一张白名单……不是网页能做的全部。”
- 建议：明确网页会话的权限范围。至少把嵌入网页会话限制为只读或只允许非破坏性页面，禁止改规则、删记忆、导出、删除设备等接口；否则应在 ADR 里明确承认“配对设备等于获得主人网页权限”，并重新评估吊销、审批和设备丢失的风险。

### 2. 中：新文档仍把 ADR 0083 当成现行架构，和 ADR 0234 矛盾

- 文件:行：`docs/adr/0229-native-apple-clients-and-device-api.md:79`、`:126`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:66`、`:98`；`docs/adr/0234-one-program-per-person-database-file.md:61-64`、`:67`；`docs/adr/0083-isolated-instance-per-person-with-owner-entry.md:2-6`
- 问题：ADR 0083 已经 `status: superseded`、`superseded_by: docs/adr/0234...`，但新 ADR 仍以“每个人一个独立实例”作为前提，并让别人的包“填自己那个实例的地址”。ADR 0234 已改成“一个程序、每人一个数据库文件”，并且“一个网址、一个 Cloudflare Access 应用”。两套地址/开通模型直接冲突。
- 证据：
  - `docs/adr/0234-one-program-per-person-database-file.md:61`：“只跑一套程序，每人一个数据库文件。”
  - 同文件 `:67`：“登录：一个网址、一个 Cloudflare Access 应用，名单里放所有受邀邮箱。”
  - `docs/adr/0083-isolated-instance-per-person-with-owner-entry.md:2-6`：`status: superseded`，`superseded_by: "docs/adr/0234-one-program-per-person-database-file.md"`。
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:98`：“多人实例的开通流程本身（由 ADR 0083 和‘多人使用’线程管）；这里只保证别人的包能填自己实例的地址。”
  - `docs/adr/0229-native-apple-clients-and-device-api.md:126`：“别人的包多一步：填自己那个实例的地址或扫码配对（前提 18）。”
- 建议：把 0229/0230/设计里的 ADR 0083 引用改为 ADR 0234，并写清楚多人场景下设备接口怎样在一个程序、一个入口下找到设备所属的数据库文件；删除“填自己实例地址”的表述。

### 3. 中：ADR 0229 把已被 ADR 0227 取代的 MCP 固定令牌方案当成当前先例

- 文件:行：`docs/adr/0229-native-apple-clients-and-device-api.md:67`、`:101`；`docs/adr/0219-read-only-mcp-entry-with-static-token.md:58-60`；`docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:58-59`
- 问题：ADR 0229 前提 6 说“已经有不经过浏览器的入口先例：固定令牌加 Cloudflare 服务令牌”，来源写 ADR 0219 决定 1；但 ADR 0219 自己在第 60 行注明该固定令牌认证已被 ADR 0227 取代，ADR 0227 决定 1 明确 `/api/mcp/v1` 只认 Cloudflare Access 凭证、固定令牌不再被接受。因此“和 Muse、MCP 入口同样的做法”里的 MCP 部分不成立。
- 证据：
  - `docs/adr/0219-read-only-mcp-entry-with-static-token.md:60`：“2026-11-11 起：本条的固定令牌认证由 ADR 0227 取代。”
  - `docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:58`：“`/api/mcp/v1` 只认 Cloudflare Access 凭证……固定令牌（`Authorization: Bearer`）不再被接受。”
  - `docs/adr/0229-native-apple-clients-and-device-api.md:67`：“已经有不经过浏览器的入口先例：固定令牌加 Cloudflare 服务令牌……来源 `docs/adr/0219...`”
- 建议：改引 ADR 0162（Muse 服务令牌 + 应用密钥）或 ADR 0227 的现状；不要用已被取代的 ADR 0219 决定 1 作为安全先例。

### 4. 中：`alarm.set` 的“按低处理”和现有风险基线冲突

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:524`；`packages/application/src/services/action-policy-service.ts:40`
- 问题：动作登记表说 `alarm.set` 是“新建或修改，按低处理”，但现有 `ACTION_KIND_RISK_BASELINE` 把 `CREATE_OR_UPDATE` 固定为 `MEDIUM`。如果实现时按表里“现有类别和档位”去接，`alarm.set` 实际是 MEDIUM，不是 LOW；如果强行降为 LOW，就绕过了规则手册/审批。这个值在“产生处（动作登记表）”和“使用处（权限服务）”两端不一致。
- 证据：
  - 设计 `:524`：“`alarm.set` | 新建或修改，按低处理 | 不要 | 读回；可撤销”
  - 代码 `packages/application/src/services/action-policy-service.ts:40`：`CREATE_OR_UPDATE: "MEDIUM",`
- 建议：要么在 `ACTION_KIND_RISK_BASELINE` 中新增一个明确的低风险动作类别，要么把 `alarm.set` 改成 MEDIUM；不要只在设计表里写“按低处理”。

### 5. 中：记忆出处改成“类型+编号”只点名了一处 SQL，代码里还有多处只按 `source_id` 更新

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:604`、`:610`；`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:762-764`、`:804-805`、`:838-841`；`packages/persistence-sqlite/src/sqlite-durable-operations.ts:3750-3753`
- 问题：设计说要修“删除只按编号匹配”，并让记忆出处按 `(source_type = perception, source_id)` 一起匹配；但它只点名了删除流程和 `sources()` 两处。当前代码至少还有三处 `UPDATE memory_provenance ... WHERE source_id = ?` / `WHERE source_id IN (...)`，分别对应线程、运行、任务和 durable operations。实现时只改一处，仍可能误伤同编号的其他来源。
- 证据：
  - `packages/persistence-sqlite/src/sqlite-governed-deletion.ts:762-764`：`UPDATE memory_provenance SET source_deleted = 1 WHERE source_id IN (...)`
  - 同文件 `:804-805`：`UPDATE memory_provenance SET source_deleted = 1 WHERE source_id = ?`
  - 同文件 `:838-841`：`UPDATE memory_provenance SET source_deleted = 1 WHERE source_id IN (...)`
  - `packages/persistence-sqlite/src/sqlite-durable-operations.ts:3750-3753`：同样的 `WHERE source_id IN (...)`
  - 设计 `:610`：“现有删除只按编号匹配……读出处的接口也只返回编号、丢了类型……这两处都改成类型和编号一起。”
- 建议：把这四处（以及未来新增的删除路径）统一改成按 `(source_type, source_id)` 匹配，并在设计里列出完整清单；否则 I-73 的“只在一端认”会重演。

### 6. 低：说了“具体数字见上限和用量”，但硬上限没有给数字

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:233`、`:571`
- 问题：接口一节说“每个接口都有服务器端的硬上限……具体数字见[上限和用量]”，但“上限和用量”一节只给了按天上限，单请求正文、单文件和解压后大小、一批记录条数、镜像同步条数、抢跑缓存条数/大小、一次抽取最大字数、防重放随机值保留条数这些都没有默认值或“配置键”清单。实施者无法据此判断是否真的防住了资源耗尽。
- 证据：
  - 设计 `:233`：“具体数字见[上限和用量](#limits)。”
  - 设计 `:571`：“每个接口还有不显示在用量页、只为防失控的硬上限（配置，超过直接拒绝）……具体数字见[上限和用量]。”但同节没有列出这些数字。
- 建议：补一张硬上限表（键、默认值、范围、超限行为），至少覆盖正文/文件/解压后大小、批条数、镜像条数、抢跑缓存、防重放随机值保留条数。

### 7. 低：实施计划的“改表批次”自相矛盾

- 文件:行：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:36`、`:50`、`:96`
- 问题：第 36 行说改表批次是第 1、3、5、7 批；第 50 行第 4 批明确“改投递记录表”；第 96 行又写“改表或动身份认证的批次（第 1、3、4、5、7 批）”。同一份计划前后不一致。
- 证据：
  - `:36`：“这份计划里改表的批次是第 1、3、5、7 批。”
  - `:50`：第 4 批内容“苹果推送……改投递记录表”。
  - `:96`：“改表或动身份认证的批次（第 1、3、4、5、7 批）。”
- 建议：统一为第 1、3、4、5、7 批，或把第 4 批的投递记录表迁移拆到别的批次。

### 8. 低：真机测试数量 19 项和 25 项不一致

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:819`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:48`
- 问题：详细设计说真机验收是 19 项（iPhone 13、手表 2、Mac 4），实施计划第 2 批说“25 项真机测试”。同一批验收范围对不上。
- 证据：
  - 设计 `:819`：“自动检查覆盖不了的 19 项……（iPhone 13 项、手表 2 项、Mac 4 项）”
  - 计划 `:48`：“同时做连接方式实测和 25 项真机测试”
- 建议：以外部清单为准统一数字，并说明“还没核实的事”的 25 条不是真机测试。

### 9. 低：ADR 说“四样设备”“一把密钥”，设计说三种设备、两把密钥

- 文件:行：`docs/adr/0229-native-apple-clients-and-device-api.md:93`、`:97`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:163`、`:169-171`
- 问题：ADR 决定 1 说“一共四样设备”，但设计明确设备种类只有 `iphone`、`watch`、`mac`，随身麦克风不是设备；ADR 决定 4 说配对时“生成一把 P-256 密钥”，设计要求设备密钥和确认密钥两把。后续表结构和配对流程会按设计实现，和 ADR 的表述不一致。
- 证据：
  - ADR `:93`：“做原生客户端，一共四样设备……随身麦克风经蓝牙接到 iPhone 或 Mac。”
  - 设计 `:163`：“设备种类：`iphone`、`watch`、`mac`。随身麦克风不是一台‘设备’。”
  - ADR `:97`：“每台设备配对时在自己的安全芯片里生成一把 P-256 密钥。”
  - 设计 `:169-171`：“生成两把 P-256 密钥：设备密钥、确认密钥。”
- 建议：把 ADR 的“四样设备”改成“三个设备种类加一个采集来源”，并把“一把密钥”改成“设备密钥和确认密钥两把”。

### 10. 低：若干代码行号/引用已失效

- 文件:行与证据：
  - 设计 `:77` 说 `strict-configuration.ts:1043` 是 `optional("dailyCostMicros", ...)`；实际第 1043 行是 `"relatedCharactersPerMail",`，真正的代码在 `:1067`：`const dailyCostMicros = optional("dailyCostMicros", 1_000_000, 1, 100_000_000);`。
  - 设计 `:399` 说 `sqlite-memory-operations.ts:868` 是 `VALUES (?, 'reference', ?, 0)`；实际 `:868` 是 `INSERT INTO memory_provenance ...`，`:869` 才是 `VALUES`。
  - ADR 0229 `:78` 引用 `.agents/instructions/test-and-production-hosts.md:8` 的原话“绝不在用户的 MacBook 上运行 Himawari 测试……”，但本 PR 已把第 8 行改成“服务器端的测试”。引用位置和原文都已变化。
- 建议：修正行号，并把 ADR 的“现在规则”改成引用变更前的提交，或改写为“本 ADR 修改前的规则”。

### 11. 低：Runbook 和老 ADR 仍保留“Mac 只用来编辑”一类绝对说法

- 文件:行：`docs/adr/0229-native-apple-clients-and-device-api.md:167`；`docs/runbooks/test-host-operations-runbook.md:57`；`docs/adr/0043-push-every-commit-full-test-before-merge.md:51`
- 问题：新指令文件已允许苹果客户端在 Mac 上构建/测试，但 Runbook 仍写“永远不在 MacBook 上跑 Himawari 的测试、构建……Mac 只用来编辑、审查、提交”；ADR 0041/0042/0043/0044/… 等仍写着“Mac 不跑测试”。ADR 0229 只说 Runbook 等切回完整模式时重新封存，没有标这些老 ADR 被修订。
- 证据：
  - `docs/runbooks/test-host-operations-runbook.md:57`：“永远不在用户的 MacBook 上跑 Himawari 的测试、构建……Mac 只用来编辑、审查、提交。”
  - `docs/adr/0043-push-every-commit-full-test-before-merge.md:51`：“开发 Mac 不跑测试……构建、`npm run check`、`npm test`……都不在 Mac 上跑。”
  - ADR 0229 `:167` 只说“两份 Runbook……等切回完整模式时重新封存”，没有说老 ADR 不再适用。
- 建议：至少在这些老 ADR 的正文加一行“苹果客户端例外见 ADR 0229”，或在 ADR 0229 的“随本 ADR 修改的文档”里明确列出被取代/修订的 ADR 列表。

### 12. 低：新值清单漏了“发布渠道”等值

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:194`、`:684-725`
- 问题：`devices` 表有“发布渠道”和“支持的动作清单”两个值，但第 17 节“新值清单”没有列“发布渠道”的枚举、产生处、使用处和校验；设备支持的动作清单也没有独立的两端校验说明。按 I-73 的标准，这属于只在一端认。
- 证据：
  - 设计 `:194`：`devices` 表包含“发布渠道、……支持的动作清单”。
  - 设计 `:684-725` 的新值清单没有这两项。
- 建议：补上“发布渠道”和“设备支持动作清单”的产生/使用/校验/检查，或说明它们只是展示字段、不参与权限判断。

---

## 二、推测/设计缺口（未实现，无法用代码证实）

1. **后台抽取的日历表没有排序规则。** 设计 `:391`、`:640` 要求“同一批记录、同一份日历表和时间，发出去的字节相同”，但只规定了记录按“设备时间加编号”排序，没有规定日历表、镜像表、建议等集合的排序。若实现按数据库返回顺序序列化，同一份内容可能在不同请求里变成不同字节，违反 prompt-prefix 第 10 条。建议补“所有集合都按固定键排序”。
2. **遮盖的“同批单位”只允许向前依赖。** 设计 `:641` 说“删掉或改动同批里的一条记录，可能改变同批别的记录被遮成什么样”。按 prompt-prefix 第 11 条，一条记录的遮法只能依赖它自己和它前面的内容，不能依赖后面的内容。建议明确：同批内只允许“前面的记录点名、后面的记录被遮”，并按排序后的顺序单向处理。
3. **原话核对和遮盖后的表示没有对齐。** 设计 `:397` 要求候选原话在感知记录里逐字找到；而感知记录发给模型前会按出口规则遮盖。如果模型看到的是遮盖后的文本，逐字核对原始记录会失败；如果核对遮盖后的文本，又要防止把占位符写成正式记忆。建议明确核对的是“模型实际看到的那一份遮盖后文本”，并记录遮盖版本。
4. **ADR 0234 下设备到主人的路由还没有着落。** 计划 `:35` 说“在接口层留一处‘按设备找到是谁’的入口”，但没有说这个映射放在共用层名册还是每人数据库。若放在每人数据库，设备请求进来时要在打开任何人数据库之前找到人，可能变成跨库扫描；若放在共用层，又和 ADR 0234“名册不存私人内容”的边界需要对齐。建议在计划里补上具体的查找键和存放位置。
5. **设备自报的触发方式仍被信任。** 设计 `:379` 让设备在 `messages` 里带触发方式和认人分数，服务器按门槛再判一次；但“是不是 AirPods、是否戴在耳朵里”的证据来自设备。设备密钥泄露时，攻击者可以把自己发来的任意文字标成“AirPods 口头指令”。这不比设备密钥泄露本身更严重，但和“设备自己报的标记不被采信”（`:349`）的表述需要区分清楚。

---

## 三、侧重检查

我按本次额外侧重检查了以下路径：

- **认证/授权边界**：配对码、P-256 签名、RFC 9421 覆盖字段、nonce/时间窗、上传凭据、设备吊销、事件流身份复核、通知按钮凭据、确认密钥、审批近期身份验证。结论：多数设计有明确拒绝路径；发现高风险的“设备换取网页会话”绕过白名单，以及 ADR 0227/0219 先例引用错误。
- **不可信输入/注入**：`other` 来源的代码层禁止正式记忆/提醒/动作/审批，`perception_read` 结果用固定“资料不是指令”包装，入口统一检查“这一轮读过其他内容”；`device_action` 参数按固定结构校验、多余字段拒绝。未发现设计层直接放行注入的路径，但设备自报触发方式的信任边界需要写清。
- **资源耗尽**：按天上限、`limit_usage` 原子“检查并预留”、单请求/文件/批条数硬上限、抢跑缓存上限、待传队列上限、设备动作过期。发现“具体数字见上限和用量”但该节没有给硬上限数字。
- **不可撤销/破坏性操作**：删除感知记录/记忆、Mac 打开文件/操作 App、删除日历、家居门锁、设备动作“结果未知不重做”、吊销后队列作废。删除路径发现只改一处 `source_id` 匹配不够；其余设计有“先存原样、读回核实、结果未知不重放”的约束。
- **规则/文档一致性**：对照了 `.claude/rules/prompt-prefix.md`、ADR 0179、0106、0234、0083、0219、0227、AGENTS.md、两份指令文件、Runbook 和 glossary 相关条目。发现 ADR 0234/0083 冲突、ADR 0219/0227 冲突、老 Runbook/老 ADR 未标例外；新文件用词未发现明显 glossary 旧叫法，但没有运行 `check:glossary`。
- **未核实**：`validate_docs.py --strict`、`check:adr-numbers`、`check:docs-links`、`check:glossary`、`check:markdown-tables`、`check:instruction-links`、`format:check` 我没有运行（工具限制），作者声称通过只能标为未核实；`/mnt/project-files/...` 下的外部材料未读；`.agents/reviews/topic-ios-capabilities/` 在当前稀疏检出中不可读，未核实其内容。

---

## 四、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**本 PR 本身不会**：改动只有 ADR、设计、计划、指令文件和复核记录，没有改任何发给模型的代码、提示词或工具定义。

对后续实现的设计判断：

- 设计明确把两个新工具做成固定定义，设备列表、动作列表、感知类型都不写进工具定义（ADR 0229:116，设计:512）；`perception_read` 的结果只作为“追加在后面的工具结果”（ADR 0230:87，设计:639）。口头指令作为最后一条用户消息（设计:635）；后台抽取是“固定指令 → 数据 → 日历表和当前时间”（设计:391）。这些符合“只在末尾追加、每轮会变的值放最后”。
- 但加 `device_action`、`perception_read` 和全部新提示词会让每个老对话**重建一次请求开头**。ADR 0229:117、ADR 0230:162 已明确承认，且 Andy 已同意；prompt-prefix 第 6、8 条允许工具集合变化时换新一次。设计:643 要求全部新提示词文字和两个工具在同一个版本上线，计划:37 把它们放在第 5 批，这个安排是对的。
- 风险点：如果实现时把设备/动作清单放进工具定义，或把当前状态/时间放进系统提示，就会违反规则；设计目前没有这样写。另一个已知一次性的变化是“新固定提示词文字进入固定文字清单，可能改变老对话的遮盖结果一次”（设计:643），这属于规则第 11 条写明的代价，不是本 PR 引入的隐藏变化。

**结论：本 PR 不改变；后续实现会有一次经 Andy 同意的工具集合换新，之后应稳定。前提是严格按设计把变化值放在工具结果/最后一条消息，且所有新提示词同版本上线。**

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**本 PR 不产生序列化内容，不会。** 后续设计已有一些确定性规则：感知记录按“发生时间毫秒整数 + 编号”排序（ADR 0230:122，设计:640），依据字段键顺序固定，登记表固定顺序，设备原样时间字符串只用于显示（设计:309）。这些都方向正确。

但有两个缺口需要补：

- 日历表/镜像/建议等集合没有写明排序；设计却断言“同一份日历表和时间，发出去的字节相同”（设计:640）。若实现按数据库返回顺序输出，仍可能不同字节。
- 遮盖按“一批记录”为单位，设计:641 的表述“删掉或改动同批里的一条记录，可能改变同批别的记录被遮成什么样”过宽。按 prompt-prefix 第 11 条，只能让后面的记录依赖前面的记录，不能反过来；需要把“同批内单向依赖”写死。

另外，原话核对到底对原始记录还是遮盖后文本（设计:397），目前没有定义，可能导致同一段话在不同遮盖状态下被判断成“核对得上/核对不上”。

**结论：本 PR 不涉及；后续实现需要补排序和遮盖单向依赖，否则同一批文字仍可能在不同请求里变成不同字节。**

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**本 PR 没有功能代码，因此没有“反向用例会失败”的功能测试可谈。** 文档层作者列出的 `check:adr-numbers`、`check:docs-links`、`check:glossary`、`check:markdown-tables`、`check:instruction-links`、`format:check` 在 `package.json` 中确实存在（如 `package.json:31`、`:34`、`:35`、`:52`、`:55`、`:56`、`:101`、`:102`），但**我无法运行，未核实**。

设计里为后续代码列了大量检查和反向用例（设计:762-800），方向是好的，例如：感知内容放进系统提示/工具定义/更早消息时检查必须失败；`other` 来源被诱导产生副作用时测试必须失败；通知凭据过期/重复/换设备必须失败；设备动作“结果未知”后换编号不得重做。但以下检查没有看到对应设计或被语义矛盾掩盖：

- 嵌入网页会话是否越权（本回复第 1 条高风险）；
- `alarm.set` 低风险映射是否有反向用例；
- 设备“发布渠道”“支持动作清单”的两端校验；
- 日历表/镜像集合排序确定性的反向用例；
- ADR/设计/计划之间的数字和引用一致性（19 vs 25、批次、行号），这类结构检查不会失败。

**结论：本 PR 只能靠文档结构检查；我未能运行，且即使这些检查通过，也不会发现上面这些语义矛盾。**

### 4. 每个新值的产生处和使用处两端都能接受吗？

逐个核对后：

- **`memory_provenance.source_type = "perception"`**：产生处（未来感知抽取）和存储端可以接受，因为当前 `memory_provenance` 的 `source_type` 没有枚举约束（`0001_initial_product_schema.sql:410-415`），导出校验也是自由文本（`data-export/schemas.ts:113`）。但使用端有两个问题：
  - `sources()` 只 `SELECT source_id`（`sqlite-memory-operations.ts:504-511`），丢掉了类型；
  - 删除 SQL 只按 `source_id` 匹配（`sqlite-governed-deletion.ts:762-764`、`:804-805`、`:838-841`；`sqlite-durable-operations.ts:3750-3753`）。
  设计只点名了一处，必须全部改成类型+编号，否则“记忆页跳到原话”和删除都会误判。
- **决策记录新类别 `device_action`、`delivery_timing`、`limit_change`**：现有 `DECISION_KINDS`/`DECISION_OUTCOMES` 有 TypeScript 约束（`decision-ledger.ts:30-58`），增加类别时必须同时补 outcomes；导出校验目前写死在 `data-export/schemas.ts:190-198`，设计说改成从登记表生成（设计:619），这个方向正确。要确保 `sqlite-decision-ledger-operations.ts:54` 的写入校验和导出导入都跟着生成，不能只改一处。
- **系统主动提醒来源名/场景名**：现有 `ProactiveSource = "gmail"`（`proactive-checks.ts:4`）、`SOURCES = ["gmail"]`（`sqlite-proactive-operations.ts:29`）、五份迁移的表约束（`0062:15` 等）、导出校验 `schemas.ts:199`、`:253`、`:273` 都是硬编码。设计说要建登记表并从登记表生成（设计:419-436），方向对；实施时要逐个核对，尤其是 `schemas.ts:273` 的 `processedMessages.source`。
- **推送通道 `apns` 和推送类型 `alert`/`widgets`/`liveactivity`**：现有 `web_push_feedback.channel` 明确 `CHECK (channel IN ('web_push'))`（`0061_web_push_feedback.sql:9`），设计说重建投递记录表（设计:472-478），可以接受；但新推送类型的枚举、环境值、写入处校验和 `apns_registrations` 的约束需要在设计里补全。
- **设备种类 `iphone`/`watch`/`mac`**：设计说服务器按清单校验、Swift 由清单生成（设计:687），两端有校验。但“发布渠道”没有进新值清单，也没有说明是否参与权限；如果服务端按发布渠道决定能力，就必须加两端校验。
- **动作名和风险档位**：`alarm.set` 的 LOW 与 `ACTION_KIND_RISK_BASELINE` 的 MEDIUM 冲突（上述第 4 条），这是两端校验失败的实例。
- **`device_action` 状态、`suggestion` 状态、`limit_usage` 周期、通知按钮动作、采集来源、镜像种类**：设计都登记了清单和使用处，方向可以；但要在实现时确保写入处和读取处都引用同一份清单，而不是各写一份枚举。

**结论：大部分新值在文档层面已经想到“两端”，但记忆出处/删除、`alarm.set` 风险、发布渠道/支持动作清单这几处两端不一致或缺失，需要在动工前补齐。**
