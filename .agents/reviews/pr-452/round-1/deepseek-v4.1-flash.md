下面按严重度列出。凡标注「读代码证实」的，都是我在当前提交 `3a11271c1` 里直接读到的代码；没有运行测试（工具限制），所以清单哈希和实际测试结果只能标「未核实」。

## 一、读代码证实的问题

### 高

**1. 新增的“带日期记忆”绕过了主人关闭“每次对话都带上”的选择**
- 文件:行：`packages/application/src/services/owner-profile-service.ts:197`、`:258`、`:323`、`:375`
- 问题：`#select` 里已经算出了尊重 pin 的 `eligible`，但返回给 `compose` 的却是未过滤的 `valid`；这次新增的带日期条目正好遍历这个 `valid`。
- 证据：
  - `:197`：`const eligible = valid.filter((memory) => choices.get(memory.id) !== false);`
  - `:258`：`return { rules, sections, eligible: valid, usage };`
  - `:323`：`for (const memory of eligible) {`
  - `:375-376`：`const { ... eligible ... } = await this.#select(input);` → `const agenda = await this.#agenda(input, eligible);`
  - 产品文案明确承诺关闭后的行为：`apps/control-center/src/i18n/resources/zh-CN.ts:900` “你选过不再每次都带上，只在相关时调出。”；`:907` “事件、健康、财务和其他类的记忆只在相关时调出”。
- 影响：主人明确关掉“每次对话都带上”的带日期事件/健康/财务记忆，只要日期落在未来 7 天内，就会从这次改动起每轮进入最后一条消息，违背主人已有的开关。
- 建议：对新增的带日期条目使用 `choices.get(id) !== false` 过滤后的集合（或单独构造 `agendaEligible`）；加一条 `pinned:false` 的带日期记忆反向测试。如果产品确实想让近期事件无视 pin，需要同步改 UI 文案和规则文档，并明确得到主人同意。

### 中

**2. 提醒在 7 天窗口外时，带日期记忆仍被标成“没设提醒”**
- 文件:行：`owner-profile-service.ts:271-278`、`:302-306`、`:323-341`
- 问题：`reminded` 只收集 `listUpcoming` 返回的“从 now 到 now+7d”的提醒；一条记忆如果提醒时间在窗口外（例如下个月，或已过期但仍是 scheduled），它的带日期条目仍会带上 `OWNER_AGENDA_DATED` 的“（没设提醒）”。
- 证据：
  - `:271-278`：`listUpcoming({ ... from: input.now, to: until, limit: AGENDA_REMINDER_LIMIT })`
  - `:302-306`：`const reminded = new Set<MemoryId>(); ... reminded.add(memory.id);`
  - `:323-341`：`if (reminded.has(memory.id)) continue;` 然后对 `validFrom`/`validTo` 使用 `OWNER_AGENDA_DATED` / `OWNER_AGENDA_ENDING`。
- 影响：标签“没设提醒”在事实上可能错误，模型会据此建议设提醒或忽略已有提醒。
- 建议：要么查询该记忆是否已有任何提醒（不限窗口）再决定标签，要么把文案改成“本周没有提醒”这类准确表述。另：`:306` 在 `readText` 之前就加入 `reminded`，若该记忆文本读不到，带日期条目会被抑制且没有提示，也值得处理。

**3. 同一 dueAt 的多条提醒没有全序，输出字节依赖 `listUpcoming` 返回顺序**
- 文件:行：`owner-profile-service.ts:311-312`、`:344-351`
- 问题：提醒条目的 `tie` 固定为空串，排序键最后没有 memory id / reminder id；两条不同记忆的提醒同一 `dueAt` 时比较器返回 0，JS 稳定排序会保留 `listUpcoming` 的顺序。
- 证据：
  - `:311-312`：`instant: reminder.dueAt, tie: "",`
  - `:344-351`：`left.day.localeCompare(right.day) || Number(left.timed) - Number(right.timed) || left.instant.localeCompare(right.instant) || left.tie.localeCompare(right.tie) || left.label.localeCompare(right.label)`
- 影响：违反 `.claude/rules/prompt-prefix.md` 第 10 条“列表顺序不能依赖数据库返回顺序”；换一个 store 实现或数据库返回顺序变化，同一逻辑输入可能得到不同字节。
- 目前 SQLite 实现是 `ORDER BY r.due_at, r.id`（`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:144`），所以生产当前大概率仍确定；但这是实现细节，不是端口契约。
- 建议：提醒条目也把 `memory.id`（或 reminder id）作为最终 tiebreak；补一条两条同 dueAt 提醒、打乱 `listUpcoming` 返回顺序的测试。

**4. `shouldPropose` 是死字段，不能用来衡量“提得准不准”**
- 文件:行：`test/integration/jarvis-test/cases.ts:56-57`、`test/integration/jarvis-test/dataset.test.ts:20-39`、`test/integration/jarvis-test/live-round.test.ts:192-204`、`test/integration/jarvis-test/grade.ts:55-103`
- 问题：`shouldPropose` 只在 dataset 测试里被检查类型和“同一问题是否有正反标签”；`gradeTrial` 和写入 `round.json`/history 的 record 都没有读取它。因此历史记录里没有正/反标签，无法按标签统计“该提的提了、不该提的没提”。
- 证据：
  - `cases.ts:57`：`readonly shouldPropose?: boolean;`
  - `grade.ts:65-103` 只根据 `answer.expectations`、`fullRead`、`searched`、`environment` 和 `judgeRules` 评分；没有 `shouldPropose`。
  - `live-round.test.ts:194-203` 记录的 case 字段只有 `id`、`scenario`、`trials`、`jev_probability`、`judge_tier`、`durationsMs`。
- 影响：作者说“以后能量她提得准不准”，但代码只能靠裁判按文字 expectations 判断，无法从数据里直接算正/反例通过率；`shouldPropose` 与 expectations 写反了也没有测试能发现。
- 建议：要么把 `shouldPropose` 接入评分/记录，要么删掉这个字段；同时把 expectations 与标签的一致性纳入 dataset 测试。另 `toolResults.tool` 也没有校验是否对应真实工具，写错工具名会被静默当成“没有预设结果”。

**5. 反向测试里“instant 早于今天”的用例实际上没有验证过滤**
- 文件:行：`packages/application/test/owner-profile-service.unit.test.ts:591-599`、`:668-677`；生产代码 `owner-profile-service.ts:356-357`
- 问题：反向测试包含 `dated("memory-past-instant", "2026-10-25T11:59:59.000Z")`，但 `AGENDA_TEXT` 里没有给 `memory-past-instant` 配文本，`TEXT` 里也没有。即使过滤逻辑错误地把它放进来，`readText` 返回 `undefined`，`:356-357` 会 `if (!text) continue;`，最终仍然没有 agenda，测试照样通过。
- 证据：
  - 测试 `:671`：`dated("memory-past-instant", "2026-10-25T11:59:59.000Z"),`
  - `AGENDA_TEXT` 的键见 `:591-599`，不含该 id。
  - 代码 `:356-357`：`const text = ...; if (!text) continue;`
- 影响：这条反向用例对“instant 早于 now 是否被排除”没有判别力；去掉了 `dayInWindow` 里的 instant 检查，这条测试也不会失败。
- 建议：给 `memory-past-instant` 补文本，并至少断言 `agenda?.memoryIds` 不含它，或单独构造只含该条记忆的输入断言无 agenda。另需补：`pinned:false` 的带日期记忆、两条同 dueAt 提醒、`agendaCharacterBudget` 小到一条都放不下。

### 低

**6. 条数/篇幅上限的“最后一行”在零条容纳时会消失；篇幅统计也不含标题和最后一行**
- 文件:行：`owner-profile-service.ts:352-364`、`:417-429`
- 问题：
  - 如果所有条目都放不下，`lines` 为空，`:417` 的 `if (agenda.lines.length > 0)` 不成立，整个 agenda block 和“另有 N 项”都不会发给模型。
  - `remaining` 只减每条行的 `line.length + 3`，没有计算标题行和 `OWNER_AGENDA_OMITTED` 行，所以实际 block 可以超过 2400 字符。
- 证据：
  - `:359-362`：`if (line.length + 3 > remaining) { omitted += 1; continue; }`
  - `:417-428`：`if (agenda.lines.length > 0) ... ...(agenda.omitted > 0 ? [renderPrompt(OWNER_AGENDA_OMITTED, ...)] : [])`
- 影响：作者“放不下的条目计数，最后一行写明还有几项没列出”和“篇幅上限 2400 字符”的说法并不总是成立。
- 生产缓解：记忆文本上限是 500 字符（`apps/agent-service/src/production-memory-capture.ts:72`），所以正常生产数据第一条一定能放进去；零条容纳主要会出现在测试或异常/历史数据。仍建议 emit block 的条件改成 `agenda.lines.length > 0 || agenda.omitted > 0`，并把标题和 omitted 行计入预算。

**7. “接下来 7 天”的本地日期窗口最多覆盖 8 个日期，且 plain date 与 instant 的今天语义不一致**
- 文件:行：`owner-profile-service.ts:266-269`、`:316-321`；测试 `owner-profile-service.unit.test.ts:679-691`
- 问题：`lastDay` 是“now + 7×24h”的本地日期，和 `firstDay` 一起按包含两端比较时会覆盖最多 8 个本地日历日期；同时 plain date 的今天会被包含，而 instant 的“今天早些时候”会被 `instant <= now` 排除。
- 证据：
  - `:267-269`：`const until = new Date(now + AGENDA_HORIZON_MS).toISOString(); const firstDay = memoryLocalDate(input.now, timeZone); const lastDay = memoryLocalDate(until, timeZone);`
  - `:319`：`if (value.includes("T") && (instant <= now || instant > now + AGENDA_HORIZON_MS)) return null;`
  - 测试 `:679-691` 明确包含 `2026-10-25`（今天）和 `2026-11-01`（第 8 个日期）。
- 影响：标题“接下来 7 天”和实际发送的日期数量/口径不完全一致；不同数据表示形式（plain date vs instant）会得到不同结果。
- 建议：如果语义是“含今天共 7 天”，用 `firstDay + 6` 作为 `lastDay`；如果是不含今天，明确 `firstDay + 1`。或者改标题/文案，并把 plain date 与 instant 的今天边界写成同一规则。

**8. 评测用 `toolResults` 可以为任意工具名绕过工作目录/权限检查**
- 文件:行：`test/integration/jarvis-test/live-harness.ts:280-294`
- 问题：`#run` 先返回 `toolResults` 中按工具名命中的预设结果，之后才检查 `web_fetch/web_search` 和 `CODING_TOOLS`；对 `read`、`write`、`bash` 等工具也能通过 `toolResults` 直接返回成功，绕过 `#searchDenied` 和 `workspaceOperations` 的只读/不可读限制。
- 证据：
  - `:285-290`：`const canned = this.#toolResults.find(({ tool }) => tool === name)?.outputs ?? []; if (canned.length > 0) { ... return { text: ..., isError: false }; }`
  - `:295-308`：之后才做 `#searchDenied` 和 `executeSandboxedPiCodingTool`。
- 影响：目前只影响评测，不影响产品代码；但以后在失败透明或权限用例里错误使用会让测试假通过。工具名拼错时也会静默拿不到预设结果（`find` 返回 `undefined`）。
- 建议：把 `toolResults` 限制在 `web_search` / `web_fetch`，或至少先按 descriptors 校验工具名并让非网络工具仍走权限/工作目录检查；在 dataset 测试里校验 `toolResults[].tool` 和 `outputs` 非空。

**9. 文档/UI 与代码不一致**
- 文件:行：`apps/control-center/src/i18n/resources/zh-CN.ts:900,907`；`docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md:62`；`docs/engineering-casebook.md:2617`；`docs/backlog/BL-20261028-005-jarvis-test-remaining-seven.md:22-30`；`packages/prompt-catalog/prompt-manifest.json:174-175`
- 问题：
  - UI 仍说关闭“每次对话都带上”的记忆“只在相关时调出”，事件/健康/财务/其他也只在该类相关时调出；新增 agenda 与这句话冲突（见问题 1）。
  - ADR 0103 和案例 39 仍写“18 条用例 / 前三条场景”，当前 dataset 是 23 条、4 个场景（新增 5 条 `proactive_next_step`）。
  - `prompt-manifest.json` 里 `chat.identity` 的 reason 把“近期安排加入带日期记忆”也写在系统提示条目上，实际该改动对应 `memory.agenda.*` 条目；`changedIn: "主动提议第 0 步"` 在仓库文档里找不到对应记录。
- 建议：更新 UI 文案（或约束实现）、更新 backlog/casebook 的用例数和场景说明，并给“主动提议第 0 步”补一条可追溯的决定记录；`chat.identity` 的 manifest reason 只写系统提示本身的改动。

## 二、作者说法逐条核对

- “`#agenda` 把提醒和带日期的记忆合在一起按日期排”：**证实**，`:344-351` 有排序。
- “同一条记忆有提醒时只出现一次”：**生产上基本成立**，因为 `memory_reminders.memory_id` 是 `UNIQUE`（`0085_memory_reminder_cancelled.sql:5`），`listUpcoming` 每个记忆最多一条；但端口契约没有保证，mock/未来存储若返回同 memory 多条仍会重复。新增的 `reminded` 只按 memory id 去重提醒，不处理多条提醒本身。
- “同样的输入不论 `listActive` 返回顺序如何，输出字节相同”：**对 `listActive` 顺序成立**（日期条目用 date、memory.id、label 形成全序）；但对 `listUpcoming` 同一 dueAt 的多条提醒不成立（见问题 3）。
- “条数上限 10 条去掉了，提醒最多取 100 条”：**证实**，`:23` 和 `:277`。
- “篇幅上限 2400 字符；放不下的条目计数，最后一行写明还有几项没列出”：**部分成立**；2400 只统计条目行，不含标题和 omitted 行；零条容纳时整块和提示都不会发出（见问题 6）。
- “老对话冻结的旧系统提示文字不再在受信固定文字清单里，会被当外来内容检查；发出去字节不变”：**代码路径属实**；新增测试 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts:117-129` 确实用旧的 `CHAT_IDENTITY.text` 经生产 egress 发送并断言不变。我还核对了基线 `chat.ts`，旧文本相对新文本只少了新增那一行，且旧文本没有验证码/密码/银行卡/证件号关键词或数字，所以不必遮。测试只覆盖 `CHAT_IDENTITY` 这一段，没有覆盖完整冻结系统提示，但真正变化的正是这一段。
- “评测工具新增 `toolResults`，只影响评测”：**属实**，只在 `test/integration/jarvis-test/live-harness.ts` 和测试里被读取；但有上面问题 8 的绕过风险。
- “服务器不读日历事件”：**基本属实**。`packages/application/src` 和 `apps/agent-service/src` 里没找到日历事件读取路径；`packages/platform-node/src/gmail-source.ts:11` 只有 `CALENDAR_READONLY_SCOPE` 常量，且现有测试 `gmail-source.unit.test.ts` 断定了不调用 Calendar API。

## 三、推测 / 未核实

- **未核实**：新增 `memory.agenda.dated/ending/omitted` 三个 manifest `sha256` 是否与目录代码一致；没有运行 `check:prompt-catalog`，只能确认测试机制存在（`prompt-catalog.unit.test.ts:175-195`）。
- **推测**：生产中 `listUpcoming` 的顺序目前由 SQLite 的 `ORDER BY r.due_at, r.id` 保证，所以问题 3 在当前实现下通常不会表现；但端口契约没有写顺序，测试 mock 和未来存储可能变化。
- **推测**：正常生产数据下“零条容纳”几乎不会发生，因为记忆文本上限 500 字符、`EXTERNAL_PROPOSAL_TEXT_MAXIMUM` 是 2000，均小于 2397；问题 6 更可能在测试自定义预算或历史异常数据下出现。
- **推测**：`readText` 若对某条带日期记忆抛错，`#agenda` 会让整个 `compose` 失败；我没有找到生产 `readText` 会抛错的具体路径，但新增逻辑把读取范围扩大到了所有未来 7 天有日期的记忆，失败面比原来（只读提醒关联记忆）更大。
- **未核实**：完整旧系统提示（含工具 snippets/guidelines）在出口遮盖下是否字节不变；新增测试只验证了 `CHAT_IDENTITY` 这一段。

## 四、侧重检查

- **错误路径**：检查了 `input.now` / 时区 / `reminder.dueAt` 不合法时的路径。`Date.parse`/`toISOString`/`Intl` 失败会抛错，和改动前同类；新增的按记忆读取文本没有逐条 try/catch，单条异常会中断整轮 `compose`。`readText` 为空时条目被静默跳过，不计数。
- **不合规范/不可信输入**：记忆文本作为资料进入最后一条消息，仍由出口遮盖处理；新增模板的静态片段都很短（不足 24 字符），不会被当作受信固定文字，未引入新的遮盖信任面。旧 `CHAT_IDENTITY` 从受信清单移除后，测试证明这段旧文本不会被误遮。
- **安全/隐私**：分类上限仍然生效（`#select` 用 `modelVisibleCeiling()`）；但新增的带日期条目绕过了 pin false / “只在相关时调出”的主人选择，这是本次最实质的隐私问题。评测的 `toolResults` 能绕过权限检查，但只在测试环境。
- **资源耗尽**：提醒上限 100，agenda 输出预算 2400；但带日期记忆本身没有条数上限，`#agenda` 会对所有 `valid` 中未来 7 天有日期的记忆逐条 `readText`，即使预算已用完仍会继续读取并累计 `omitted`。正常记忆文本最多 500 字符，风险有限，但这是一条随活跃记忆数增长的串行读取路径。
- **不可撤销操作**：本次没有加工具、没有改数据库表、没有写文件或发通知；`#agenda` 只读记忆并 `storeText` 存资料块，属于可恢复的普通存储，没有不可撤销副作用。
- **规则文件/说明文档**：`.claude/rules/prompt-prefix.md` 的只追加要求基本满足；agenda 在最后一条用户消息，系统提示只对新对话生效。文档/UI 的“18 条 / 只在相关时调出”等说法与当前代码不一致（见问题 9）。

## 五、必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会改变已发出的请求开头。`pi-runtime-adapter.ts:639-657` 的 `turnPrompt` 把时间和全部资料（包括 owner-profile/owner-agenda）放在 `<himawari-context>`，然后才放 `<owner-message>`，整段是一条新的最后用户消息；`context-formation-service.ts:628-634` 把 `owner-agenda` 放进 `contextBlocks`。`thread-prompt-bundle-service.ts:190-207` 在没有工具名/模型/推理强度/回答语言/分类变化时直接复用最新的冻结 bundle，所以旧对话继续用旧系统提示。变化只来自新对话采用新的 `chat.identity` 文本，这符合“改文字只对新对话生效”。

每轮会变的值（now、时区、命中的记忆、agenda 日期标签）都在最后一条消息里；系统提示和工具定义没有加入时间、日期、记忆或其它每轮变化的值。唯一需要留意的是旧对话的 `CHAT_IDENTITY` 不再在受信固定文字清单里，可能被出口遮盖重新检查；新增测试证明这段旧文本目前不会被改字节。

**2. 同一段文字会不会在不同请求里变成不同字节？**

一般不会：日期条目按 `day`、`timed`、`instant`、`memory.id`、`label` 排序，和 `listActive` 返回顺序无关；`Intl` 输出在同一构建/时区下确定；旧系统提示的遮盖测试也断言同样输入字节不变。

但存在一个确定性问题：同一 `dueAt` 的多条提醒比较器返回 0，输出顺序取决于 `listUpcoming` 的返回顺序（问题 3）。另外 `localeCompare` 的结果理论上依赖运行环境的 locale/ICU，虽然同一部署内固定，但不如显式的字符串比较稳妥。还有一个语义变化是：同一份记忆可能因为这次 agenda 改动从“相关时才选中的记忆”变成“每轮都在 agenda 里”，字节随输入逻辑变化，但这是有意的功能变化，不是随机化。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

有：
- `owner-profile-service.unit.test.ts` 新增了正向、日期窗口反向、截止日期、提醒去重、`listActive` 顺序、预算省略等用例。
- `memory-correction-context.test.ts` 新增了真实 SQLite 上下文的正向/反向材料检查。
- `live-harness.test.ts` 新增了 `toolResults` 的正向和“没有预设结果时联网工具失败”的反向检查。
- `trusted-prompt-egress.unit.test.ts` 新增了旧 `CHAT_IDENTITY` 经生产 egress 不变的检查。
- `dataset.test.ts` 检查每个 `proactive_next_step` 用例有 `shouldPropose` 且同一问题同时有正反标签。

但反向用例有缺口：问题 5 的 `memory-past-instant` 实际没有被验证；没有 `pinned:false` 带日期记忆的反向用例；没有两条同 dueAt 提醒的顺序用例；没有“预算小到一条都放不下”的用例；`shouldPropose` 不参与评分，所以无法证明模型“该提的提了、不该提的没提”。因此，覆盖到的反向用例会失败，未覆盖的场景不会。

**4. 每个新增/修改的值，生产者和使用者两端都能接受吗？逐项核对**

- **`CaseMemory.validFrom`**：`cases.json` 产生，`context.ts:200` 转成 `attributes.validFrom`；`memoryDatesOf`/`isDateText` 接受 `YYYY-MM-DD`，SQLite 的 `validMemoryTime`（`sqlite-memory-operations.ts:173-177`）也明确接受 `DATE_ONLY`。这条链路能接受。
- **`memory.agenda.dated/ending/omitted` 的 id 和 `day`/`count` 槽**：`memory.ts:285-309` 产生，index 通过 `export *` 暴露，`owner-profile-service.ts` 消费，`renderPrompt` 的槽校验通过；`prompt-manifest.json:536-550` 有对应条目，`prompt-catalog.unit.test.ts` 会校验哈希和槽。哈希本身**未核实**（不能运行检查）。
- **`agendaCharacterBudget`**：只由 `OwnerProfileServiceOptions` 和测试产生/消费，生产代码没有配置入口；两端接受。
- **`toolResults.tool` / `outputs`**：`cases.json` 产生，`live-harness.ts:285` 按名字查找；新用例的 `web_search`/`web_fetch` 在生产工具描述里存在（`production-runtime-tools.ts:469-485`，`liveConfiguration` 又设置了 `publicSearch`/`publicFetch`），所以新用例能命中。但没有任何地方校验工具名是否真实存在，拼错会静默失败（问题 4/8）。
- **`shouldPropose`**：在 `cases.ts:57` 产生、`dataset.test.ts` 消费；评分、history、round 都不消费，属于“只有一端认”的死值。
- **`proactive_next_step` 场景字符串**：`cases.ts`、`history.mjs:4-15`、`dataset.test.ts`、`live-round.test.ts` 都接受；history 的 `SCENARIOS` 已包含。
- **`datasetVersion` 新值**：`history.mjs` 只把它当字符串比较，接受。
- **`memoryIds` 新流向**：`compose` 把 agenda 行对应的记忆放进 `profile.memoryIds`，`context-formation-service.ts:254` 用它排除选中记忆；`Set<string>` 接受，但会改变“相关记忆”选择行为，属于需要明确预期的副作用。
- **pin 规则**：`choices.get(id) === false` 是产生端，`#select` 的 profile 消费端接受；但 agenda 这个新消费端没有接受（问题 1）。
- **`memoryLocalDate` 导出**：内部消费，无外部契约。
- **`agenda.omitted` 计数**：模板接受字符串；但计数单位是“条目”而非“记忆”，同一条记忆的 validFrom/validTo 两条都放不下会算 2，文案“另有 N 项”可能和主人理解不一致。
- **新系统提示文字**：`chat.ts` 产生，`HIMAWARI_IDENTITY`、golden、manifest、trusted 测试都接受；旧对话冻结路径不受影响。

结论：`validFrom` 链路和场景/模板 id 两端基本对齐；问题集中在 pin 规则、`shouldPropose` 无消费端、`toolResults.tool` 无校验，以及 agenda 预算/标签语义。
