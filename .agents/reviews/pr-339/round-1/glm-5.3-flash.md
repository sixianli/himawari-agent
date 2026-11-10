# 复核报告：PR 339（记忆带日期，ADR 0199）

## 侧重检查（走过的流程和结论）

我从最普通的一条聊天流程走了一遍：主人发消息 → 运行组装（service-main.ts:1853）→ 上下文组装（context-formation-service.ts）→ 信封存取 → 读回投影（context-projection-service.ts）→ Pi 适配器拼最后一条消息（pi-runtime-adapter.ts）→ 模型；另一条是档案流：OwnerProfileService.compose → 档案块进信封 → 同上到模型；再加记忆页概览流（production-memory-control.ts 的 outline）。

- 自动带入：`production-run-memory.ts:378` 产出 `dates` → `context-formation-service.ts:607-614` 写进信封记忆块 → `context-projection-service.ts:432` 读回带到投影 → `pi-runtime-adapter.ts:634-637` 在正文后拼日期。每一步都有对应测试（下文问题 3）。
- 档案：`owner-profile-service.ts:305` 把日期直接写进档案文本，日期随文本整体成为块内容，同样只进最后一条消息。
- 记忆页概览流（`production-memory-control.ts:555` → outline）发现一个隐患，见下面第 1 条。
- 档案与资料块的时区同源：两者最终都来自 `runPolicy.timeZone`（service-main.ts:1927-1929 传给 memoryCapture → production-run-composition.ts:278 传给 OwnerProfileService；service-main.ts:2052-2054 传给 run 组合 → production-run-composition.ts:426 传给 Pi 适配器）。
- 测试覆盖总体到位；`production-memory-control` 的 outline 是唯一在本次改动接触面里、没有专门用例的路径（因为它输出不含日期，见第 1 条）。

## 发现的问题（按严重度从高到低）

**1.（低）apps/agent-service/src/production-http-composition.ts:1043-1055 — 记忆页概览用的 OwnerProfileService 没传 timeZone**
证据：这段构造只传了 `state/pins/readText/storeText/digest`（1043-1055 行），而同文件 1066-1068 行明明把 `runPolicy.timeZone` 传给了外层的 ProductionMemoryControl。run 组合里的那个实例（production-run-composition.ts:278）是传了时区的。
读代码证实的影响面：目前无可观察错误——outline 的行文本不含日期（owner-profile-service.ts:131-132 只回 `{memoryId, text, updatedAt}`），而三种日期格式无论时区长度固定（“YYYY-MM-DD”恒 10 字符），所以“已用 N 字”数字不受时区影响。但这是隐含耦合：将来 outline 一旦显示日期，或日期格式长度随时区可变，这里就会静默出错。
建议：给这个实例也传 `timeZone`（一行改动），消除两处实例配置不对称。

**2.（低）packages/application/src/ports/memory-dates.ts:26-28 与 49-60 — 坏日期字符串会原样透传给模型**
证据：`localDate` 对解析不了的值 `return value`（28 行），`isMemoryDates` 只要求非空字符串（53-59 行），不校验日期格式。`validFrom` 是模型提取字段（提示词只“要求” YYYY-MM-DD，prompt-catalog/src/memory.ts:26），模型完全可能给出“下个月”这类值，信封校验会放过，模型会看到“（下个月 至今）”。
字节仍是确定的（同一输入同一输出），不违反追加规则；ADR 0199 的“同一条记忆每次字节相同”在这些值不变的前提下成立。属可接受的降级，但值得记录。
建议：要么在 `isMemoryDates` 里要求 `YYYY-MM-DD` / ISO 即时两种形状（但要想清楚旧数据兼容），要么至少在 ADR 写明透传行为是有意的。

**3.（低，观察）老记忆没有 recorded_at 时，“记于”可能随时间漂移**
证据：`memoryDatesOf` 回退 `memory.recordedAt ?? memory.updatedAt`（memory-dates.ts:19）；`sqlite-memory-operations.ts:769-775` 的 UPDATE 确实不写 `recorded_at`（ADR 前提 3 证实），但 `sqlite-memory-maintenance.ts:62` 恢复归档会改 `updated_at`。迁移 0053 给老数据回填过 `recorded_at`（migrations/0053_memory_episodes.sql:2），正常新记录插入也带（725 行），所以这条回退路径应当极少触发；一旦触发，“记于”某天会变——但它只在最后一条消息里，不破坏缓存，且和 recall 的回退一致（production-memory-recall.ts:233 同样写法）。
建议：无需改动；可在 ADR 后果里补一句“recordedAt 为空且记忆被恢复归档时，日期会变一次”。

**4.（信息）界面口径：档案预览行不带日期，“已用 N 字”带日期**
证据：记忆页概览的行来自 outline（`production-memory-control.ts:561-566`，text 是纯记忆文本），而 used 含 dateNote（owner-profile-service.ts:217-221，`limit - remaining`）。ADR 0199 第 4 条只承诺了数字口径（“记忆页‘已用 N / 2000 字’因此包含日期的字数”），与代码一致，不算说错；但用户看到的行文字与计数字节不一一对应。推测：这是有意的（概览是管理视图），如非有意需补。

**5.（信息）manifest 三条 sha256 的具体值未核实**
证据：`apps/agent-service/test/prompt-catalog.unit.test.ts:300-319` 会对每个目录条目自动比对 sha256，错了会报 `PROMPT_MANIFEST_STALE`。我无法运行命令重算哈希，只能确认“有自动检查兜底”，不能确认提交里的三个哈希值本身正确（推测正确，因为登记流程就是同一测试写出的）。

## 读代码证实的 vs 推测

证实：日期只在最后一条用户消息（`session.prompt(turn)`，pi-runtime-adapter.ts:1765；系统提示/工具定义路径未动）；recordedAt 写后不改；时区接线两端同源；信封旧格式兼容（dates 可选）；档案预算连日期一起算且“主人的要求”不带；recall 路径本来就带日期。
推测（未核实）：五个门槛“去掉修改会失败”是 ADR 声称已实测，我只读了断言、没运行；manifest 哈希值正确性（见第 5 条）。

## 必答问题逐条回答

**1. 是否改变模型已见过的请求开头？** 不会。`dates` 经 `contextBlockContent`（pi-runtime-adapter.ts:633-637）拼进 `turnPrompt`，`turnPrompt` 的结果只经 `session.prompt(turn)`（1765 行）作为本轮新用户消息发出；系统提示、工具定义、历史、遮盖路径零改动。每轮会变的值（本轮选中记忆及其日期）都在最后一条用户消息里。compat 测试 `[MEMORY-DATE]` 用三轮对话验证了追加性（`findConversationBreak` 为 null，日期出现在 `messages.at(-1)`）。已发历史里的老记忆不补日期，符合“只追加”。

**2. 同一段文字在不同请求里是否字节相同？** 是，前提成立。`recordedAt` 只在插入时写、UPDATE 不改（sqlite-memory-operations.ts:769-775 证实）；`validFrom/validTo` 改动属于记忆内容本身变了；`memoryDateNote` 是纯函数，输入只有 dates 和配置时区，模板文字在目录里冻结（manifest 锁定）。两个已证实的例外（都无害）：时区配置改了字节会变（但在最后一条消息，且档案文本本来就重算）；recordedAt 缺失回退 updatedAt 时可能随维护操作漂移（问题 3）。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 有，五个门槛都存在且断言直接依赖本次改动：compat `[MEMORY-DATE]`（prompt-prefix.compat.test.ts:412-447）、信封形状四种坏值拒绝（context-projection.test.ts:292-315，`PORT_INVALID_OPERATION`）、端到端请求体含“（记于 2026-11-09）”（memory-model-visible.test.ts:394-424）、生产查询交出 dates（production-model-composition.unit.test.ts:1957-2004）、档案行带日期且规则不带（owner-profile-service.unit.test.ts:179-217）。按断言逐条读，去掉对应修改这些用例都会失败；是否“已实测”未运行验证。另有 prompt-catalog 测试自动锁 manifest 哈希。注意 memory-model-visible 那条是 monkey-patch search 强行喂 dates，真实 search 产出由 agent-service 单测补上——两条合起来才覆盖全链，单看任何一条都有洞。

**4. 每个新值的产生端和使用端都能接受吗？** 逐个核对过：`MemoryDates`（产生：production-run-memory.ts:378、owner-profile-service.ts:178-180；使用：formation 写信封、projection 校验透传、pi 适配器渲染）两端校验吻合；信封 `dates` 字段：读回端只允许 memory 块且形状合法（context-projection-service.ts:775-776），旧信封无此字段照常通过，formation 侧同名校验器（context-formation-service.ts:774-789）不校验 dates——宽松方向，只放行自己写出的信封，可接受；`MemoryRecord.dates`/`RuntimeProjectionContextBlock.dates` 均为可选，其他实现无需改动；三个提示词 id 已登记 manifest（有自动检查兜底，哈希值本身未核实）；`OwnerProfileServiceOptions.timeZone` 生产端已接线（run 组合），记忆页概览端漏接但当前无可观察影响（问题 1）。其他把记忆交给模型的路径：recall 已带日期（production-memory-recall.ts:233-235）；后台整理、邮件判断属于机器对机器的调用，不进对话资料块，作者划出范围是合理的——但整理（MEMORY_CONSOLIDATION_FORMAT）做冲突/去重判断时其实同样吃不到日期，将来若要“按时间判新旧”应把它纳入同一格式约定，建议在 ADR 后果里记一笔。
