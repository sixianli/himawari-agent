## 证实的

### 会出错（高）

**1. 系统代传的上传与“60 秒创建时间 + 一次性随机值”互相矛盾，离线感知上传会全部被拒**
- 问题：设计要求每次请求按 RFC 9421 签名，服务器拒绝创建时间偏差超过 60 秒、随机值重复的请求（`docs/execution/specs/2026-11-11-apple-device-body-design.md:173`）；但同一份设计又说没连接时把 `perception`、`perception/media`、`track` 交给“系统代传”，只签文件摘要（`:218`、`:231`）。苹果的后台传输由系统在“合适的时候”执行，可能等网络、等充电、最长可拖到数天；HTTP 请求和 `Signature` 头在任务创建时就固定了，真正发出时 `created` 早已过期。系统重试还会复用同一个 nonce，被服务器当作重放拒绝。
- 证据：Apple《Downloading files in the background》：“Only upload tasks from a file are supported”（<https://developer.apple.com/documentation/foundation/downloading-files-in-the-background>）；WWDC23《Build robust and resumable file transfers》：“Background session always waits for connectivity, so tasks will be scheduled at some point after the device connects to the internet again”（<https://developer.apple.com/videos/play/wwdc2023/10006/>）；Apple 归档文档：“By default, the system allows up to seven days for a background session to run”（<https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/DeferNetworking.html>）。RFC 9421 §7.2.2 要求用 nonce 和时间戳限制重放（<https://www.rfc-editor.org/rfc/rfc9421.html>）。
- 建议：把“后台文件上传”和“交互请求”分成两种凭据。交互请求继续用 RFC 9421；后台上传在入队时向服务器申请一个设备绑定的上传会话（upload id + 长有效期、范围限定到文件摘要和记录编号的令牌），服务器只在该路径接受它，按 upload id + 感知记录编号幂等，并支持可续传协议。不要把 60 秒签名用于系统代传。

**2. “`other` 在代码层不能产生设备动作、提醒、审批”只在感知抽取路径成立，对话工具路径没有污点追踪**
- 问题：设计表格说依据全是 `other` 时，正式记忆、提醒、日历、设备动作、审批都拒绝（`:333-341`）；但 `perception_read` 的结果是作为工具结果追加到对话末尾（`:571`），模型随后完全可以在同一轮调用 `device_action`、现有的提醒工具或日历工具。设计没有给工具结果打“来源是 `other`”的标签，也没有在副作用工具入口检查本轮依据。于是网页、屏幕文字、短信里的间接注入可以借 `perception_read` 进入对话，再触发“中”风险动作——而“中”风险按规则手册是预先授权的（`:486`）。
- 证据：设计明确写“第一道是上面那张表”（`:353`），但那张表只覆盖抽取候选的处理。OWASP LLM01 对间接提示注入的定义是“LLM accepts input from external sources, such as websites or files... content may have data that... alters the behavior”；缓解措施要求“Require human approval for high-risk actions”和“handle these functions in code rather than providing them to the model”（<https://genai.owasp.org/llmrisk/llm01-prompt-injection/>）。
- 建议：给每次工具结果带 `provenance`（`owner_spoken` / `other` / 混合），并在所有副作用入口（`device_action`、提醒、日历、审批、记忆转正）检查“本轮是否有主人当前消息或 `owner_spoken` 记录作为依据”。仅有 `other` 工具结果时，副作用必须拒绝或转成需要主人确认的建议。用 `ScriptedModelPort` 注入“读到网页后调用 device_action”的反向用例，守卫去掉时必须失败。

**3. 新增决策类别的值会被数据导出 schema 拒绝（I-73 同类问题）**
- 问题：设计新增 `device_action`、`delivery_timing`、`limit_change` 到 `DECISION_KINDS`（`:633`），但数据导出的 `DECISION_SCHEMA.kind` 是一个写死的枚举，不含这三个值。导出或导入带新类别的决策记录会失败。设计只写了“登记在 `DECISION_KINDS`、`DECISION_OUTCOMES`”，漏了导出 schema。
- 证据：`packages/application/src/ports/decision-ledger.ts:30-58`；`packages/persistence-sqlite/src/data-export/schemas.ts:190-198` 固定列了 `proactive`、`memory_candidate`、`consolidation`、`context_truncation`、`retrieval_degrade`、`external_read`、`rule_review`，没有新值。I-73 的教训正是“清单里的 id 能通过后端校验吗”（`docs/incidents-and-gates.md` I-73）。
- 建议：让导出 schema 从 `DECISION_KINDS`/`DECISION_OUTCOMES` 生成，或同步修改；加一条“每种 kind 都能导出再导入”的往返测试，并从 schema 删掉一个 kind 时该测试必须失败。

**4. 主动提醒的来源改造漏掉运行时、每来源开关、导出 schema 和最后两份重建表**
- 问题：
  - 设计说“Gmail 写死在类型、三份迁移的表约束、导出导入校验和查询里”（`:387`），实际 `CHECK (source IN ('gmail'))` 出现在 `0062`、`0069`、`0087`、`0088`、`0089` 五份迁移里，`scenario` 约束也在 `0062:29`、`0069:11`、`0087:27`、`0088:27`、`0089:27`；只改“三份”会留下 `0088/0089` 重建出来的 `source_insights`、`proactive_processed_messages` 和 `decision_ledger` 仍然拒绝新来源。
  - 现有运行时 `production-proactive.ts` 是 Gmail OAuth/单一连接状态机，很多地方写死 `source: "gmail"`（`:289`、`:321`、`:504`、`:509`、`:537`、`:544`、`:566`、`:571`）；`ProactiveSourceItem` 的字段也是 Gmail 形状（`packages/application/src/ports/proactive-checks.ts:40-57` 的 `threadId`、`from`、`subject`、`body`、`attachments` 等）。新来源 `speech/calendar/location/message/screen` 没有 token、没有 thread、没有邮件的这些字段，现有 reader/store 接不了。
  - 设计说“每个新来源单独开关，默认开”（`:391`），但 `proactive_settings` 只有全局 `enabled`（`0062_proactive_checks.sql:1-10`），`ProactiveSettings` 也只有 `enabled`（`proactive-checks.ts:31-38`），没有每来源开关或每来源预算的存储。
- 证据：上面列出的迁移行；`packages/persistence-sqlite/src/data-export/schemas.ts:199`、`:253`、`:273` 仍只接受 `gmail`；`apps/agent-service/src/production-proactive.ts:289` 等。
- 建议：先定义通用的 `ProactiveSourceItem`（或每来源 adapter）和每来源设置表（enabled、预算、条目上限、最晚送达时间），让运行时按登记表遍历，而不是继续 Gmail 单一状态机；重建全部五份相关迁移（包括 `decision_ledger.scenario`）；导出 schema 从登记表生成；UI/i18n 也按登记表生成。增加“每个来源用假 reader 跑通 + 未登记来源写不进库”的集成测试。

### 会出错（中）

**5. 感知记录的删除没有对象类型、没有 provider 清理、没有内容引用计数**
- 问题：设计说删除按 `(source_type = perception, source_id)` 匹配，只由它产生的记忆作废（`:544-552`）。但现有删除服务 `GovernedDeletionObjectType` 只有 `thread | run | task | memory | payload`（`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:38`），感知记录不是可删除对象，没有 tombstone、重试、验证。记忆删除还要求外部 provider 清理到 `deleted_verified`（`:864-869`），设计只写“作废，从检索索引里拿掉”，漏了 `memory_projection_jobs` 和外部索引删除。第 1 步“内容从内容存储里删掉”也没有检查同一 payload 是否被别的记录引用；现有 payload 删除会拒绝被引用的 payload（`:893-899`）。
- 证据：上述行；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:503-510` 的 `sources()` 只返回 `source_id`，丢掉了 `source_type`。
- 建议：给 `GovernedDeletionObjectType` 增加 `perception` / `perception_episode`，走现有 tombstone/重试/验证；删除时查 `(source_type, source_id)`，标记记忆重新过门槛，并 enqueue projection delete，等 provider 清理到 `deleted_verified`；payload 只在引用计数为零时删除。记忆读取接口应同时返回 `source_type` 和 `source_id`，否则“跳到原话”只能靠前缀猜。

**6. 记忆出处的写入端目前固定写 `source_type = 'reference'`，不是 `perception`**
- 问题：设计说感知抽取把出处写成 `source_type = perception`（`:631`），但现有记忆保存路径硬编码 `source_type = 'reference'`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:866-871`）。如果不改 port（`ProductMemoryRecord.sourceRefs` 只有一个字符串数组）和这条 INSERT，新增的 `perception` 类型根本写不进去；而删除按 `source_type = perception` 匹配会找不到。
- 证据：`sqlite-memory-operations.ts:868` 的 SQL 是 `VALUES (?, 'reference', ?, 0)`；`memory_provenance` 的 `source_type` 没有枚举约束（`0001_initial_product_schema.sql:410-415`），所以“能写”不代表“写对了”。
- 建议：把 `sourceRefs` 改成携带类型的结构（例如 `{type, id}`），或在记忆保存入口显式接受 provenance；迁移已有 `reference` 语义；加一条“保存一条 `perception` 出处后，按类型 + 编号能删到”的测试。

**7. “高风险”没有映射到现有审批的 `CRITICAL`，高风险动作可能根本不会要求近期身份验证**
- 问题：设计说高风险动作“每次确认”，高风险审批要带确认密钥的签名（`:453`、`:486`）。现有审批服务只在 `intent.finalRisk === "CRITICAL"` 时设置 `recentAuthenticationRequired`（`packages/application/src/services/action-policy-service.ts:503`）。如果设备动作把“高”映射成 `HIGH`，审批会走普通确认，不会验证确认密钥。`mac.open` 在现有基线里是 `INSTALL_OR_EXECUTE_CODE = HIGH`（`:49`），不是 `CRITICAL`；`contact.update` 是 `CREATE_OR_UPDATE = MEDIUM`。
- 证据：`action-policy-service.ts:37-50`、`:503`；设计 `:476-486` 只写“高/中/低”，没有说映射到 `ACTION_RISK_LEVELS` 的哪一档。
- 建议：在动作登记表里显式加 `requiresOwnerPresence` 或把高风险动作映射到 `CRITICAL`；`mac.open`、`mac.app`、门锁/车库门、`calendar.delete`、`contact.update` 逐项决定。加一条测试：高风险设备审批不带确认密钥签名时必须 `NOT_AUTHORITATIVE`，即使风险等级是 `HIGH` 也一样。

**8. Mac 动作的目录/App 白名单只写在文档里，服务器端没有存储，`mac.open` 的 URL scheme/路径规范化也没定义**
- 问题：设计说“Mac 的两个动作在名单之外一律由设备端拒绝，服务器端也拒绝，两边都判”（`:486`），但 `devices` 表只有“支持的动作清单”（`:185`），没有目录、App、URL scheme 白名单。服务器端没有数据可判。`mac.open` 还允许打开网址（`:483`），而 `file://`、`javascript:`、自定义 scheme、带查询参数的 URL 都可能绕过“只限目录”的限制或把数据带出去。
- 证据：设计 `:185`、`:483-486`；没有对应的新值/表项。
- 建议：增加 `device_policy`（设备、允许的目录实路径、允许的 App bundle id、允许的 URL scheme/host），服务器和设备同步；路径用 `realpath`/symlink/`..` 规范化后比较；URL 只允许明确的 scheme 和 host 白名单，禁止 `file://` 除非精确匹配白名单文件。加路径穿越、symlink、`file://`、`javascript:`、`https://attacker/?data=...` 的反向测试。

**9. “建议”没有数据模型**
- 问题：设计反复说 `other` 产生的提醒/日历“存成建议”（`:339`、`:372`），删除时“由它产生的建议删掉”（`:550`），提醒页上等主人点。但全文没有“建议”的表、编号、状态、去重键、过期时间、导出/删除规则，也没有进新值清单。实现时只能临时拼，无法保证幂等和可删除。
- 证据：设计 `:339`、`:372`、`:550`；第 17 节新值清单没有“建议”。
- 建议：明确建议是复用现有 `source_insights` 还是新表；定义 id、来源感知记录、提议的动作、去重键、状态（open/accepted/dismissed/expired）、最晚送达时间、决策记录关联；补进新值清单和删除/导出测试。

**10. `check:data-export` 并不是“拦下没登记的表”的那道检查；`check:prompt-prefix` 的新用例也不会自动运行**
- 问题：设计说“`npm run check:data-export` 会拦下没登记的表”（`:556`、`:708`）。实际 `check:data-export` 只是在 4 个文件里跑带 `[P1-6]` 的至少 53 条测试（`scripts/check-data-export.mjs:9-15`、`:48`）；真正检查“数据库表 == schemaCatalog”的是 `packages/persistence-sqlite/test/migration-engine.contract.test.ts:67-72`，不在 `check:data-export` 里。设计把 `check:prompt-prefix` 写成放测试的位置（`:686`），但该脚本只跑带 `[I-66]` 的测试，`REQUIRED = 8` 且固定要求 `[COMPACT-1..4]`（`scripts/check-prompt-prefix.mjs:8-11`）；新用例不带 `[I-66]` 就不会跑，带上了还要同步计数。
- 证据：上述脚本行。
- 建议：把“未登记的表”检查明确放到 `migration-engine.contract.test.ts`（或把它接进 `check:data-export`）；把新测试标上 `[I-66]`/`[P1-6]` 并更新 `REQUIRED`；在方案里写清每个检查的 tag 和计数，否则“有自动检查”是假的。

**11. “感知记录的原文不进已有历史”与 `perception_read` 的工具结果自相矛盾；反向用例也测不到**
- 问题：设计说“感知记录的原文不进系统提示、工具定义和已有历史”（`:576`），但 `perception_read` 的结果是作为工具结果追加（`:571`），而规则第 4 条明确把“工具结果”算作历史（`.claude/rules/prompt-prefix.md:35`）。从下一轮起，这段原文就是“已有历史”。更关键的是，设计提出的反向用例“把一条感知记录拼进历史消息，检查必须失败”（`:686`）只能证明“改写已发消息会被前缀检查抓到”；如果实现把记录作为**新消息**追加到末尾，前缀检查会通过，但记录仍然进了历史。它测不到“不得进入系统提示/工具定义/已有消息之前”这个真正的不变量。
- 证据：`.claude/rules/prompt-prefix.md:35`；设计 `:571`、`:576`、`:686`。
- 建议：把不变量改写为“感知内容只能作为本轮末尾的工具结果出现，不得出现在系统提示、工具定义、或任何早于本轮的消息里”；测试直接检查请求结构（位置/角色），而不是只跑前缀连续性。`detail: full` 必须有长度上限和截断标记。

**12. 同一消息内的遮盖会受同批其它记录影响，设计“删改别的记录不会改变这次请求的字节”不成立**
- 问题：ADR 0230 和设计说“点名的值只从这一次请求自己的内容里认，不去查别的感知记录，所以删改别的记录不会改变这次请求的字节”（`docs/adr/0230-...:119`、设计 `:578`）。但规则第 11 条写明：点名消息里的值会在整条消息里遮掉，包括同一请求里排在它后面的消息；同一批感知记录如果拼在同一条消息里，一条记录里的密码/验证码会让同批其它记录里的同一个值也被遮。删掉或改动同批另一条记录、或改变排序，都会改变某条记录的字节。
- 证据：`.claude/rules/prompt-prefix.md:52-54`；ADR 0230 `:119`；设计 `:578`。
- 建议：要么明确“一批记录是一个遮盖单元”，不再声称单条记录字节独立；要么在拼接前对每条记录单独遮盖（用固定的、只依赖该记录自身的上下文），再拼接。加一条测试：一条记录含密码、另一条记录含同一值，打乱顺序和删除第一条时，第二条的字节应保持不变（如果这是要守的承诺）。

**13. `result_unknown` 只防了设备重放同一个动作编号，没防模型用新编号重试、设备重装或吊销后离线执行**
- 问题：流程说设备先存编号、再执行，同一编号不重做（`:494`）；回报丢了记 `result_unknown`，不自动重做（`:495`）。但模型看到“结果未知”后可以再调用 `device_action`，服务器会生成新的动作编号，设备会当成新动作执行。设备重装/清数据会丢掉本地编号去重表；设备被吊销后，本地队列里的动作仍可能在离线时执行。这些对 `calendar.delete`、`home.control`、`mac.open` 都是不可逆的。
- 证据：设计 `:488`（编号服务器生成）、`:494-495`；没有设备侧状态机（received/started/completed/result）或“同一意图”去重。
- 建议：动作登记表加 `intent_fingerprint`；`result_unknown` 后同一意图的新调用必须要求读回或主人确认，不能直接新建。设备本地存完整状态机而不是只存编号；重装后先向服务器查询未决/未知动作再执行；吊销后丢弃队列，高风险动作执行前要求在线确认。

**14. 上限主要按天、且部分由设备上报，缺服务端硬上限和原子预留，容易被伪造/突发耗尽**
- 问题：设计列了每天模型费、录音时长、ASR 时长、图片张数、记录条数、设备队列、电量（`:506-515`）。但：
  - `location_track_points` 单独一张表（`:318`），没有每日点数上限；按 10 秒一个点，90 天约 77 万行，且可被恶意设备放大。
  - `perception/media`、`device_mirror_items`、`utterances/partial` 没有单请求/单日字节上限；一个被攻陷或有 bug 的设备可以塞满磁盘/内存。
  - `device.queue.bytes` 是设备上报值，服务器不能信；`perception.records.daily` 到了上限才停，但并发请求可以同时越过上限。
  - 抢跑缓存按“这句话的编号”存在内存 60 秒（`:271`），没有条目数/总字节上限；大量唯一切半句可以打爆内存。
  - `perception_read` 的 `full` 没有结果条数/字符上限（`:468`），模型可被诱导读一整年数据，费用和上下文都会爆。
  - `limit_usage` 的“发生时累加”（`:519`）没有说原子 UPSERT/预留；并发下会超。
- 证据：上述设计行；现有 `check:settings-scope` 只检查设置列（`scripts/check-settings-scope.mjs`），不覆盖这些新上限。
- 建议：增加服务端硬上限：单请求体、单文件/总媒体字节、每日轨迹点数、镜像条目/字节、抢跑缓存条目/字节、`perception_read` 最大条数/字符、抽取批最大字符；用 SQLite 原子 UPSERT/条件更新做“检查并预留”，不是先读后调；设备上报值只用于显示，不作为服务端放行依据。每项加上限测试和并发突发测试。

**15. 本地缓存、声纹、剪贴板的保留/分类/删除/远程擦除缺失**
- 问题：设备允许只读缓存最近的对话和记忆（`:592`），但删除/吊销只讲服务器端，没有说设备本地缓存怎么清、丢设备时怎么远程擦除。声纹“一直保留”（`:542`）是生物识别数据，没有单独的数据分级、加密、导出/删除说明。剪贴板内容默认归到“私密”，但剪贴板经常含密码/验证码，至少应是“敏感/受限”；照片、位置也可能敏感。
- 证据：设计 `:537-542`、`:592`；数据分级只点名健康、短信、屏幕文字敏感（`:579`）。`check:settings-scope` 的现有设置列也不涉及这些。
- 建议：明确设备缓存使用系统数据保护（如 `NSFileProtectionComplete`）、吊销时远程擦除/失效本地缓存；声纹单独分类为敏感，禁止导出或按明确同意导出；剪贴板默认敏感；把“丢设备/吊销”的本地擦除写进验收和真机清单。

**16. 口头指令的验收与“认人未达标前全部是 `other`”冲突，设计没有把门禁写进验收**
- 问题：设计说认人错认率达标前，门槛设“永远不过”，所有听到的话都是 `other`（`:330`）。但验收 #2 要求主人说“嘿 Himawari，帮我……”就执行（`:109`），验收 #1/#3 也依赖主人亲口说的话。按安全门，达标前这些验收根本不可能通过；而设计没有在验收/建造顺序里写“听/口头指令在认人达标后才验收”，也没写达标前的产品形态（只能按键/打字，还是每次回问）。
- 证据：设计 `:330`、`:343-351`、`:108-110`。
- 建议：把验收分成“认人达标前/后”两组；达标前明确“不执行口头指令，只回问或只记录为 `other`”；或者为 Andy 自己的设备提供可控的单人模式，但必须在 ADR 里写明风险，不能靠“门槛永远不过”和“验收要求执行”同时存在。

### 会出错（低）/ 可以更好

**17. 设备时间没有规范化就按“设备时间加编号”排序**
- 问题：设计说抽取时按“设备时间加编号”排序（`:577`）。如果存的是设备原始时间字符串（不同时区、不同精度、设备时钟不准），字典序不等于时间序，同一批记录在换时区/重传时可能排出不同字节。
- 建议：入库时统一转成 UTC 毫秒整数（另存原始字符串用于显示），排序用整数 + 记录编号；加一条“同一瞬间不同时区格式排序相同”的测试。

**18. 通知按钮的原子性、Watch 镜像、反馈无审批绑定**
- 问题：通知凭据的五项核对（`:449`）没有说“检查 + 标记已用”是原子操作；两个并发点击可能都通过。通知可能被 Apple Watch 镜像/转发，而 token 绑定的是某一台设备；Watch 上点按钮时用谁的密钥、token 是否仍有效，设计没写。`useful/disturbing` 没有审批编号，表里的“绑定的审批编号和版本/指纹”对反馈应为空，五项核对要分支。
- 建议：用 `UPDATE ... WHERE used_at IS NULL AND expires_at > now` 的原子消费；明确 Watch 通知的 action 由 iPhone 处理还是 Watch 自己签名，并加真机测试；反馈 token 的审批字段允许为空，核对分支处理。

**19. “设备只收到和它有关的事件”与现有全局事件 cursor 的续传语义没说清**
- 问题：设备流是现有事件流的子集（`:231`），但现有 cursor 是全局事件序号（`http-gateway-server.ts:1115`）。如果服务器按设备过滤事件，设备报的 cursor 在全局序列里可能指向没发给它的事件；续传可能跳事件或反复“整份重取”。设计没有定义每设备 cursor 或过滤后的序列映射。
- 建议：为设备流定义独立的每设备事件序列/游标，或明确规定“全局 cursor + 过滤，服务器按全局位置续传”，并加“过滤后断线续传不丢不重”的测试。

**20. 如果 `perception_read.kinds` 是枚举，工具定义会随类型清单变化；“两个固定工具”就不成立**
- 问题：设计说工具定义字节永远不变（`:463-470`），但 `perception_read` 的 `kinds` 参数可选项如果由感知类型清单生成，以后新增类型就会改变工具定义的参数结构。规则第 6 条要求参数结构变化要换新（`.claude/rules/prompt-prefix.md:41`），而现有 `promptBundleChange` 只比较工具名（`thread-prompt-bundle-service.ts:89`），不会处理参数结构变化，旧对话会继续用旧枚举。
- 建议：把 `kinds` 定义成自由字符串/数组，由执行端按清单校验；如果坚持枚举，就把清单版本冻结进工具定义，并接受换新。

**21. 新提示词分阶段上线可能多次改变 trusted-text 清单，导致老对话多次重建/遮盖变化**
- 问题：设计说“加两个新工具和新提示词……只这一次”（`:580`）。但 `TRUSTED_PROMPT_TEXTS` 由所有提示词模块在构建时汇总（`packages/prompt-catalog/src/trusted.ts:10`），建造顺序第 4、5、7 阶段还会陆续加提示词；每次新增都可能改变老对话的遮盖结果，触发不止一次前缀变化。规则第 11 条也写明这种已知代价（`.claude/rules/prompt-prefix.md:53`）。
- 建议：把所有新提示词一次性发布，或把 trusted 清单/遮盖规则按对话冻结；在方案里明确“只重建一次”依赖“提示词一次上线”，否则验收 #10 不成立。

**22. 文档与规则不一致：Mac 验证被无限期推迟，但设计把 Mac App 放在第 7 阶段**
- 问题：`.agents/instructions/test-and-production-hosts.md:17` 写“Mac 仍然是受支持的产品平台，但用户已无限期推迟了所有 Mac 验证：在用户恢复之前，不要安排或提议在 Mac 上运行”。设计第 7 阶段要交付 Mac App，验收也要求 Mac 客户端在 Andy 的 Mac 上用 Xcode 构建/测试（`:588-594`、`:712` 附近）。这两者至少需要澄清：Apple 客户端构建测试的例外（同文件第 9 行）是否覆盖 Mac App，还是 Mac App 也要等“Mac 验证恢复”。
- 建议：在 ADR/设计里引用第 9 行的例外并明确 Mac App 属于该例外；或者把 Mac App 从第 7 阶段移到“Mac 验证恢复后”，避免规则和计划冲突。

**23. 迁移“三份”实际是五份，且 `decision_ledger.scenario` 也要改**
- 问题：除了上面第 4 条，设计第 9 节只写“三份迁移”（`:396`），但 `0062`、`0069`、`0087`、`0088`、`0089` 都含 `source/scenario IN ('gmail')`，其中 `0088/0089` 是最新重建版本。改表队列如果只排三份，合入后新来源仍会被最新表约束拒绝。
- 建议：改表队列列全五份，并明确 `decision_ledger.scenario`、`source_insights.source`、`proactive_processed_messages.source`、`proactive_connections.source` 都要重建；用“登记表里的每个来源都能插进每张表”的集成测试守。

**24. 导出/导入可能被迫包含设备密钥、配对码、nonce、通知 token**
- 问题：设计说“新表全部登记进表结构目录和数据导出的校验”（`:556`）。但 `device_request_nonces`、`device_pairing_codes`、`notification_action_tokens`、`apns_registrations` 是安全/临时表，导出它们会泄露或制造重放风险；设备私钥本来就不该在服务器，公钥可以导出。设计没有区分“产品数据表”和“安全表”。
- 建议：明确导出白名单：感知记录、镜像、记忆、决策记录、设备元数据（不含私钥/token/nonce）导出；配对码、nonce、通知 token、APNs token 明确排除，并在 `check:data-export` 加反向断言。

## 推测 / 未核实

以下不是从仓库代码直接证实的，需要实现或真机确认：

1. **Watch 镜像通知的按钮归属**：iPhone 的通知可能镜像到 Watch，token 绑定的是哪台设备、Watch 上点按由谁签名，Apple 文档和真机行为需要确认。设计没有写。未核实。
2. **嵌入网页“只能在 App 内嵌浏览器里用”能否强制**：短期网页会话本质是 bearer cookie；服务端如何区分 WKWebView 与外部浏览器，设计没有机制。若靠 User-Agent 则可伪造。未核实。
3. **SQLite 单写者能否承受 20k 感知记录/天 + 全天轨迹 + 镜像同步 + 现有对话**：现有 I-36 已显示数据库单线程瓶颈；设计没有写入速率/批处理/保留清理的容量分析。需要实测，S1 的基线也没核实。
4. **`TRUSTED_PROMPT_TEXTS` 新增提示词是否真的会改变旧对话遮盖**：取决于新提示词文本是否与旧历史内容重叠；规则说可能，需要按实际文本验证。
5. **设备流“子集 + 全局 cursor”**：现有 gateway 是否已有按订阅过滤的游标语义，未读完整实现；需要核实。
6. **`kinds` 最终是否实现成枚举**：设计只写“可选”，没写类型；如果是枚举，第 20 条成立。
7. **`message.text`、`screen.text`、`clipboard.item` 在 iPhone 后台/无用户操作时是否真的可得**：设计把 `message.text`（短信和 iMessage）写进类型表（`:301` 附近），但 iPhone 沙盒通常不能读短信/iMessage；`screen.text` 需要 ReplayKit 广播；剪贴板后台读取受限。设计自己的未核实清单 #11/#12 也承认部分接口要试。需要在真机/官方文档确认，不能把“平台做不到”与类型表混在一起。
8. **Secure Enclave 的确认密钥每次使用都要求面容/解锁，且通知 action 扩展里能完成签名**：设计未核实清单 #1 已承认没读到原文；需要在真机验证。
9. **`/mnt/project-files/...` 的 S1/S8、`verified-apis.md`、`integrated-plan.md`、`device-test-list.md`、TaoSheng 笔记**：不在仓库，本次无法核实。S1 的 6.3 秒、S8 的苹果接口原话、19 项真机清单都应标“未核实”。
10. **Cloudflare Tunnel 在 Wi-Fi/蜂窝切换、后台长连接、大传输阻塞**：设计未核实 #3/#4/#5；需要实测。

## 侧重检查

我按你给的侧重逐类查了：

- **错误路径 / 不可信输入**：系统代传（60 秒签名/nonce 冲突，高）；`pair` 二维码被拍照后抢先配对（中，建议配对时在已登录页确认设备名）；设备上报的认人分数、镜像、动作结果、电量/队列大小（服务器不能全信，尤其 `device.queue.bytes`）；`utterances/partial` 洪泛（无上限）；`perception/media` 超大文件/压缩炸弹（无单文件/解压上限）；`perception_read` 的 `from/to/kinds/full`（无结果上限）；`device_action.arguments` 是自由对象（需要严格 schema/无额外字段）；`mac.open` 的 URL scheme/路径穿越。
- **安全边界**：RFC 9421 只签“方法、路径、正文摘要、created、nonce、设备编号”（设计 `:173`），没有签 `@authority`、`@query`、`content-type`。RFC 9421 §7.2.1 明确“未覆盖的部分可被修改而不影响签名”，§2.2.6 明确 `@path` 不含 query（<https://www.rfc-editor.org/rfc/rfc9421.html>）。`GET stream?afterCursor`、`GET threads/{id}` 等查询参数不在签名覆盖内；建议至少签 `@method`、`@authority`、`@path`、`@query`（或 `@target-uri`）、`content-digest`、`content-type`。设备密钥没有轮换流程；确认密钥的挑战没有 API/绑定细节；通知 token 的消费不是原子；嵌入网页 session 是 bearer；设备本地缓存/吊销远程擦除缺失；Mac 白名单未落库；`other` 污点未跨工具传播。
- **资源耗尽**：轨迹点、媒体、镜像、抢跑缓存、nonce 表、`perception_read` full、抽取批大小都没有硬上限；每日上限不是原子预留；SQLite 单写者容量未评估。
- **不可撤销操作**：`calendar.delete`、`contact.update`、`home.control`（门锁）、`mac.open`、`mac.app` 没有 before-image/撤销；`result_unknown` 后模型可用新 action id 重试；设备重装/吊销离线队列可重做；高风险映射可能不是 CRITICAL；通知按钮在锁屏上可能看不到正文就确认。
- **规则/说明/代码一致**：`check:data-export` 误称会拦未登记表；`check:prompt-prefix` 的 tag/计数没写；迁移“三份”实为五份；`TRUSTED_PROMPT_TEXTS`/新提示词只重建一次的说法依赖一次上线；Mac 验证无限期推迟与 Mac App 第 7 阶段冲突；`docs/adr/0230` 的“删改别的记录不改变字节”与规则第 11 条冲突；`DECISION_KINDS` 与导出 schema 不一致；`source_type='perception'` 与现有写入 `'reference'` 不一致。

## 如果由我来定，我会怎样改这份方案

1. **先修正“值”的两端，再谈接口**：把 `DECISION_KINDS`、`ProactiveSource`、`perception` provenance、`device_action` 风险、每来源开关、`suggestion` 表、`GovernedDeletionObjectType` 全部列成一张“产生处/使用处/两端校验/检查”的表，逐项补全；先写导出/导入和表约束的往返测试，再写业务。特别是 `source_type`：把记忆出处 port 改成携带类型，而不是继续写 `'reference'`。
2. **把后台上传和交互请求分开**：交互 API 用 RFC 9421（覆盖 `@method`、`@authority`、`@path`、`@query`/`@target-uri`、`content-digest`、`content-type`、`created`、`nonce`，nonce 保留 ≥ 2× 时间窗）；后台文件上传用短/长有效期的 upload session token + upload id + 记录编号幂等 + 可续传，绝不套 60 秒签名。
3. **把“other 不能产生副作用”做成运行时不变量**：工具结果带 provenance；所有副作用工具在执行前检查本轮依据；只有 `other` 时一律要求主人确认或拒绝；用 ScriptedModelPort 测“注入网页内容 → 尝试 device_action/提醒/日历”的反向用例。
4. **把高风险动作映射到 `CRITICAL`**：动作登记表显式写 `requiresOwnerPresence`；`mac.open`/`mac.app`/门锁/车库门/`calendar.delete`/`contact.update` 按不可逆/对外/物理安全逐项定级；高风险审批必须确认密钥签名，且通知按钮要求解锁后能看到内容再确认。
5. **补齐数据模型**：`suggestion` 表、每来源设置表、每来源预算、`device_policy`（目录/App/URL scheme）、`perception_episodes`、`capture_source`、镜像 kind/version、动作状态机、`utterance` join id、APNs topic/bundle、`limit_usage` 周期键；所有新表进 schema-catalog，但安全/临时表明确排除导出。
6. **把资源上限做成服务端硬上限**：单请求体、媒体字节、轨迹点数、镜像字节、抢跑缓存、`perception_read` 结果、抽取批字符；原子预留；设备上报值只显示；加上限测试和并发测试。
7. **修测试门槛**：`[I-66]`/`[P1-6]` tag 和计数写进方案；“感知记录不进历史”改成结构断言；“同一批字节相同”固定时钟/日历/遮盖上下文；“同一句话一条记忆”先定义 join key；“result_unknown 不重做”覆盖模型新 action id、设备重装、吊销离线队列。
8. **把听/口头指令的门禁写进验收**：认人达标前明确“不执行口头指令”，验收 #1/#2/#3 分阶段；达标后再开。
9. **一次性上线所有新提示词和 trusted text**，或按对话冻结 trusted 清单，确保“只重建一次”不是分阶段多次。
10. **规则文档同步**：更新 `.agents/instructions/test-and-production-hosts.md` 的 Mac 例外与 Mac App 阶段；把“三份迁移”改成五份；把 `check:data-export` 的真实职责写对。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加？每轮会变的值是不是都在最后一条消息里？**

会改变一次，之后基本只在末尾追加：
- 新增 `device_action`、`perception_read` 会改变工具定义（请求最前面）。`packages/application/src/services/thread-prompt-bundle-service.ts:89` 的 `tool_set_changed` 会让每个老对话下一轮重建一次；Andy 已在 ADR 0229 决定第 7 条同意这次失效（`docs/adr/0229-native-apple-clients-and-device-api.md:114`）。之后系统提示和工具按对话冻结，正常只追加。
- 每轮会变的值：抽取的当前时间/日历在末尾（设计 `:568-569`）；`perception_read` 结果是本轮末尾的工具结果（`:571`）；口头指令是末尾用户消息（`:572`）。这几条符合“会变值只在最后”。
- **但设计说“感知记录原文不进已有历史”是错的**：`perception_read` 的工具结果从下一轮起就是历史，规则第 4 条明确把工具结果算历史（`.claude/rules/prompt-prefix.md:35`）。正确的不变量应是“只以本轮末尾工具结果出现，不得进入系统提示、工具定义或早于本轮的消息”。
- 另外，`perception_read.kinds` 不能是随类型清单变化的枚举，否则工具定义会变；“两个固定工具”只在它是自由字符串/数组时成立。新提示词会改变 `TRUSTED_PROMPT_TEXTS`（`packages/prompt-catalog/src/trusted.ts:10`），可能改变老对话遮盖；设计说“只这一次”依赖所有新提示词一次上线，否则第 4、5、7 阶段会多次变。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

会，且不只在末尾：
- 抽取提示包含“日历表和当前时间”（设计 `:568`），同一批记录重试时字节不同。这可以接受（后台一次性调用），但不能在文档里笼统写“同样的内容每次发出去字节相同”。
- **同一消息内遮盖**：点名值会遮同一消息里的其它记录（`.claude/rules/prompt-prefix.md:52-54`），所以删改同批其它记录或改变顺序，可能改变某条记录的字节。ADR 0230 `:119` 和设计 `:578` 的“删改别的记录不会改变这次请求的字节”不成立。
- 设备时间没有规范化就按“设备时间加编号”排序（设计 `:577`），不同时区/格式/时钟会排出不同顺序；应先转 UTC 毫秒整数。
- `TRUSTED_PROMPT_TEXTS` 随构建/提示词清单变化，可能改变同一段内容的遮盖；需要冻结或一次发布。
- 会话侧：系统提示/工具按对话冻结、只追加，正常不会变；`perception_read` 每次返回的内容本来就是新内容，不属于“同一段文字”。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有，但有几条按所写办法测不出来或测错：
- `check:prompt-prefix` 只跑带 `[I-66]` 的测试，`REQUIRED=8` 且固定要求 `[COMPACT-1..4]`（`scripts/check-prompt-prefix.mjs:8-11`）；新用例必须带 tag 并同步计数，否则不运行。
- “感知记录原文不进历史”的反向用例（设计 `:686`）只证明“改写已发消息会被前缀检查抓到”；把记录作为新消息追加时前缀检查仍通过，测不到真正的不变量。应改成请求结构断言。
- `check:data-export` 只跑 4 个文件里带 `[P1-6]` 的 53 条测试（`scripts/check-data-export.mjs:9-15`）；“没登记的表”实际由 `migration-engine.contract.test.ts:67-72` 守，不在这个检查里。设计把门槛写错了。
- “同一批每次字节相同”必须固定时钟/日历/遮盖上下文，否则必失败（当前时钟和日历每次都变，同一条记录里的点名值还会影响同批其它记录）。
- “同一句话只产生一条记忆”没有定义 `utterances/partial`、`messages`、`perception:` 三个编号怎么对应，测试无法实现。
- “结果未知不重做”只测设备重放同一 action id；没测模型新建 action id 重试、设备重装丢失本地去重表、吊销后离线队列执行。
- “吊销后连接在下一次心跳前断开”与现有实现不符：`streamGatewayEvents` 在心跳/事件时 `revalidate`（`http-gateway-server.ts:497`），应写“下一次心跳时”。
- 高风险审批的测试需要“服务器给的一次性挑战”，但 API 表里没有获取 challenge 的端点；没有挑战就无法测确认密钥签名。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不是。逐个核对到的问题：
- **新决策类别**：`DECISION_KINDS` 增加了，但 `packages/persistence-sqlite/src/data-export/schemas.ts:190-198` 的导出枚举没有，导出/导入会拒绝。
- **新主动提醒来源**：`data-export/schemas.ts:199`、`:253`、`:273` 仍只接受 `gmail`；`production-proactive.ts` 的 OAuth/`source: "gmail"` 和 `ProactiveSourceItem` 的 Gmail 字段接不了新来源；`proactive_settings` 没有每来源开关；`0062/0069/0087/0088/0089` 的 CHECK 都要重建，设计只写“三份迁移”。
- **`perception` 出处类型**：`memory_provenance.source_type` 是自由文本、导出 `sourceType` 是 `text(1,512)`，能接受；但写入端硬编码 `'reference'`（`sqlite-memory-operations.ts:868`），删除端 `GovernedDeletionObjectType` 没有 `perception`（`sqlite-governed-deletion.ts:38`），记忆删除还要求 provider 清理到 `deleted_verified`（`:864-869`），设计漏了这些。
- **推送 `apns`/推送类型**：`0058:26`、`0061:9` 的 CHECK 要重建，设计提到了；但 `web_push_feedback.devices` 1..100、`kind` 仍限 reminder/approval/run，`widgets/liveactivity` 不写反馈，需要明确。
- **设备动作风险**：现有 `recentAuthenticationRequired = finalRisk === "CRITICAL"`（`action-policy-service.ts:503`）；设计说“高”每次确认，如果映射成 `HIGH` 就不会触发近期身份验证。`mac.open` 基线是 `HIGH`，`contact.update` 是 `MEDIUM`，需要逐项显式映射。
- **Mac 白名单**：`devices` 表没有目录/App/URL scheme 白名单，服务器端“也判”没有数据；`mac.open` 的 URL scheme/路径规范化缺失。
- **“建议”**：没有表/编号/状态/去重/过期/导出，无法删除和幂等。
- **遗漏的新值**：`capture_source`、`device_mirror_items.kind`、`perception_episodes.id`、`device_actions.status`、`utterances/partial` 的 join id、APNs topic/bundle、`limit_usage` 的周期键、每来源开关/预算、数据分级默认值、Mac 白名单、`suggestion` id、`perception` 删除对象类型。
- **导出边界**：`device_request_nonces`、`device_pairing_codes`、`notification_action_tokens`、`apns_registrations` 是安全/临时数据，不能因为“新表全部登记”就导出。

一句话：方案的方向可以保留，但在“后台上传认证、`other` 的跨工具污点、主动提醒来源的运行时/迁移/导出、感知删除、风险映射、资源上限、测试门槛”这几处，按现在的写法会出错；建议先补这些，再进入实施计划。
