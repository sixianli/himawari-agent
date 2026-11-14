## 侧重检查

- **错误路径**：重点看了 `reminders` 端口缺失、提醒列表被 `LIMIT` 截断、`readText` 返回空或抛错、日期非法这几种。结论：前两种会让“这 7 天里没有提醒”变成不实陈述；`readText` 现在覆盖到所有带日期记忆，坏 payload 影响面比改动前大。
- **不合规范/不可信输入**：记忆正文仍做空白折叠；日期经 `isDateText` 校验；提醒 `dueAt` 在 SQLite 层被规范成 ISO-Z；评测里的预设网页结果只用于测试夹具。结论：没有新增加剧注入的路径，但“哪些记忆能被放进每轮上下文”与面向主人的说明不一致（见问题 1）。
- **安全/隐私**：带日期的 `event`、`health`、`finance` 记忆现在会默认进入每轮最后一条消息；而记忆页开关对这些类别是禁用/不可打开的，页面说明又写着“事件不会放进来，只在相关时才调出”。这是本次最需要产品确认的地方。
- **资源耗尽**：预算只限制输出行数，不限制读取和排序的工作量；预算耗尽后仍会为每个条目 `readText`，条目数随活跃带日期记忆数增长（最多每记忆 2 条）。`AGENDA_REMINDER_LIMIT=100`、`OWNER_AGENDA_CHARACTER_BUDGET=2400` 都是新的放大项。
- **不可撤销的操作**：没有。改动只读记忆、拼上下文、写 payload，不产生对外副作用。
- **规则/文档一致性**：`docs/agent-rulebook-inventory.md` 的 S-15 与实际 `chat.identity` 文字一致；但记忆页 i18n 说明、`memory.agenda.omitted` 的 manifest reason 与实际行为/代码不一致。`.agents/reviews/pr-452/round-1/judgments.md` 在稀疏检出中不可读，`git show` 被 records-path 保护拒绝，相关内容标「未核实」。

## 按严重度排列的问题（读代码证实的）

### 高

**1. 带日期的 event/health/finance 记忆被默认放进每轮上下文，但主人关不掉，页面说明还说不会带上**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:325-326`；`apps/control-center/src/components/memory-page.tsx:79-87,311-322`；`apps/agent-service/src/production-memory-control.ts:79-86,1389-1395`；`apps/control-center/src/i18n/resources/zh-CN.ts:891-892,906-907`
- 问题：`#agenda` 对 `eligible` 中所有类别一视同仁，只看 `reminded`/`declined`。但记忆页的 `PINNABLE` 不包含 `event`、`health`、`finance`、`other`，开关被禁用；服务端 `memory.pin/unpin` 也对这些类别直接抛 `MEMORY_NOT_PINNABLE`。因此这些带日期记忆会进入“接下来 7 天的安排”，主人无法产生 `pinned=false` 来关掉；而页面说明写着“健康、财务等敏感记忆和事件不会放进来，只在相关时才调出”。作者“主人在记忆页关掉……不再作为带日期条目进近期安排”的说法，对最主要的带日期类别（event）并不成立。
- 证据：
  - `owner-profile-service.ts:325-326`：`for (const memory of eligible) { if (reminded.has(memory.id) || declined.has(memory.id)) continue;`（没有类别过滤）
  - `memory-page.tsx:79-87`：`PINNABLE` 只有 identity/preference/relationship/goal/project/rule；`pinBlock` 对其他类别返回 `"category"`
  - `memory-page.tsx:311-322`：开关 `disabled={memory.busy || pinBlock(item) !== null}`
  - `production-memory-control.ts:1389-1395`：`if (... || !PINNABLE_CATEGORIES.has(...) ...) throw ... MEMORY_NOT_PINNABLE`
  - `zh-CN.ts:892`：`健康、财务等敏感记忆和事件不会放进来，只在相关时才调出`
  - 新测试用 `dated()` 固定 `category: "event"`（`owner-profile-service.unit.test.ts:575-590`），再直接喂 `pins: [["memory-laundry", false]]`（`:700-711`），这是生产 UI/服务端对 event 无法产生的状态，正是 I-73 说的“只看了改动，没问生产端能否产生这个值”。
- 建议：二选一——(a) 让带日期记忆的纳入范围与可关掉的类别一致，或增加单独的“近期安排”开关并让服务端允许关闭 event/health/finance；(b) 如果确实要默认带上事件，至少更新记忆页说明，并给主人一个能关掉的入口。测试应改用可产生 `pinned=false` 的类别，并补 event/health 的行为与文案用例。

### 中

**2. “这 7 天里没有提醒”在提醒被截断或提醒端口未接时可能是假话**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:273-280,304-317,325-344`；`apps/agent-service/src/service-main.ts:2060-2084`；`apps/agent-service/src/production-real-eval.ts:589-591`
- 问题：`reminded` 只由 `listUpcoming(..., limit: 100)` 返回的提醒构建。提醒超过 100 条时，排在后面的提醒不会被看到，对应记忆仍会被打上“这 7 天里没有提醒”。另外，OwnerProfileService 的 `reminders` 是可选端口；real eval 的 `profile` 工厂没有传 `reminders`，于是所有带日期记忆都会得到这个标签，即使真实提醒存在。改动前没有提醒端口时直接返回空 agenda，不会做这种断言。
- 证据：
  - `owner-profile-service.ts:273-280`：`listUpcoming({ ..., limit: AGENDA_REMINDER_LIMIT })`，`AGENDA_REMINDER_LIMIT = 100`
  - `owner-profile-service.ts:305-317`：`for (const reminder of upcoming) { ... reminded.add(memory.id); }`
  - `owner-profile-service.ts:325-344`：只跳过 `reminded`/`declined`，之后直接渲染 `OWNER_AGENDA_DATED`/`OWNER_AGENDA_ENDING`
  - `service-main.ts:2060-2084`：real eval 的 `new OwnerProfileService({...})` 没有 `reminders`
  - `production-real-eval.ts:589-591`：`deps.profile(...).compose(...)` 会走 `#agenda`
- 建议：只有在确认提醒列表完整时才写“没有提醒”。可以检查 `upcoming.length >= AGENDA_REMINDER_LIMIT` 时改为“提醒列表不完整”或不加该标记；或者按记忆 id 逐条查询提醒；或者把 `reminders` 改成 compose agenda 的必需依赖并给 real eval 接上。补一条“提醒列表被截断/端口缺失”的反向用例。

**3. 窗口实际覆盖 8 个当地日期，不是 7 个**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:269-271,318-324`；`packages/application/test/owner-profile-service.unit.test.ts:729-740`
- 问题：`from = now`、`until = now + 7×24h`，再用 `firstDay = local(now)`、`lastDay = local(until)` 做闭区间比较。只要 `now` 不在当地 00:00，`firstDay` 到 `lastDay` 就包含 8 个当地日期；测试本身也同时包含了 10/25 和 11/01。作者说第 1 轮第 7 条“判为不成立”，但 `judgments.md` 我读不到，无法核实理由。
- 证据：
  - `owner-profile-service.ts:269-271`：`until = now + AGENDA_HORIZON_MS`；`firstDay = memoryLocalDate(input.now, timeZone)`；`lastDay = memoryLocalDate(until, timeZone)`
  - `owner-profile-service.ts:322-323`：`return day >= firstDay && day <= lastDay ? day : null;`
  - 测试 `:737-739` 同时期望 `10/25` 和 `11/1` 都出现
- 建议：先明确产品语义。若“接下来 7 天”指 7 个当地日期，`lastDay` 应取 `firstDay + 6 天`（并同步改测试）；若指 168 小时窗口，应把文案写成“接下来 168 小时”或接受跨 8 个日期并在说明里写清。当前测试把 8 个日期固化成了预期，容易掩盖这个问题。

### 低

**4. 同一时刻提醒的定序并不保证与 SQLite 的 `ORDER BY r.due_at, r.id` 一致**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:346-353`；`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:139-146`
- 问题：代码用 `left.tie.localeCompare(right.tie)` 比较提醒 id。`localeCompare` 是语言/ICU 相关排序，不保证等于 SQLite 默认 BINARY 的 `r.id` 排序；生产提醒 id 是 `reminder:memory:reminder:${key}`，MemoryId 允许大小写和 `._:-`，混合大小写或标点时两者可能不同。作者“和 SQLite 的 ORDER BY r.due_at, r.id 一致”说得过满。
- 证据：
  - `owner-profile-service.ts:346-353`：`left.instant.localeCompare(right.instant) || left.tie.localeCompare(right.tie)`
  - `sqlite-memory-reminder-operations.ts:144`：`ORDER BY r.due_at, r.id LIMIT ?`
  - `production-reminder-writer.ts:165-166`：`const memoryId = \`memory:reminder:${input.key}\` as MemoryId; const reminderId = \`reminder:${memoryId}\`;`
- 建议：用码点比较（`left.tie < right.tie ? -1 : left.tie > right.tie ? 1 : ...`）或显式指定与 SQLite BINARY 等价的比较器；测试补一个大小写/标点不同的提醒 id 用例。

**5. “预设结果只对 web_search/web_fetch 生效”的反向用例其实不会在限制被去掉时失败**

- 文件/行：`test/integration/jarvis-test/live-harness.test.ts:120-125`；`test/integration/jarvis-test/live-harness.ts:285-295`
- 问题：反向用例用的是 `toolsFor("6a")`，而 6a 没有 `toolResults`。即使把“只对 web 工具查预设结果”的判断删掉、对任何工具都查 `this.#toolResults`，6a 查到的仍是空列表，测试照样通过。它验证的是“没有预设结果时 web_search 失败”，不是“预设结果不会漏给别的工具”。
- 证据：
  - `live-harness.test.ts:120-125`：`const { run } = await toolsFor("6a"); ... expect(result.outcome).toBe("failed");`
  - `live-harness.ts:285-295`：`const canned = name === "web_fetch" || name === "web_search" ? (...) : []; if (canned.length > 0) { ... }`
- 建议：新增一个直接构造 `FixtureRuntimeTools`、给 `read` 等非 web 工具准备 `toolResults` 的用例，断言这些预设结果被忽略；或者让 dataset 允许一个“非 web 工具预设结果”的反向夹具。

**6. 没有测试“关掉开关不影响提醒”这条作者明确声称的行为**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:305-317,325-326`；`packages/application/test/owner-profile-service.unit.test.ts:700-711`
- 问题：代码确实让提醒绕过 `declined`（提醒循环在 `declined` 判断之前），但测试只覆盖“带日期条目被关掉”，没有覆盖“同一条记忆被关掉但仍有提醒时，提醒仍然出现”。以后如果有人把 `declined` 也套到提醒上，现有测试不会失败。
- 证据：`:305-317` 的提醒循环没有检查 `declined`；`:326` 的日期循环检查 `declined`；`:700-711` 只断言带日期条目。
- 建议：加一条 `pins: [[id, false]]` 且有 `reminders` 的用例，断言提醒行仍在、日期行不重复。

**7. 预算只限制输出，不限制读取和遍历；省略提示本身也不计入预算**

- 文件/行：`packages/application/src/services/owner-profile-service.ts:354-367`
- 问题：`readText` 在预算判断之前执行，且预算耗尽后仍 `continue` 遍历为每个条目读文本、累加 `omitted`。条目数最多约为活跃带日期记忆数的 2 倍，没有上限；`（另有 N 项……）` 这行还额外增加字符，不受 `agendaCharacterBudget` 约束。对资源受限/记忆很多的账户，这会放大每轮开销。
- 证据：
  - `:357-364`：`const text = (await this.#options.readText(entry.memory))...; ... if (line.length + 3 > remaining) { omitted += 1; continue; }`
  - `:427-429`：省略提示直接追加，不扣 `remaining`
- 建议：先按预算截断条目数再 `readText`，或预算耗尽后不再读文本、只计数剩余条目；把省略提示的长度也纳入预算；考虑给“参与排序的带日期记忆”设一个上限并在日志里记录。

**8. `memory.agenda.omitted` 的 manifest reason 与条目用途不符**

- 文件/行：`packages/prompt-catalog/prompt-manifest.json:547-551`
- 问题：这一轮把 `memory.agenda.omitted` 的 reason 改成了“对话里提下一步之前先查清楚……”，但这条 prompt 的用途是“放不下时告诉模型还有几项没有列出”。dated/ending 的 reason 是准确的，omitted 这条不是。manifest 测试只校验非空，不会发现。
- 证据：`prompt-manifest.json:550`：`"reason": "...对话里提下一步之前先查清楚，再提一个可以直接点头的具体做法并说出依据"`；同一条 prompt 的 `purpose` 是“近期安排放不下时，告诉模型还有几项没有列出”。
- 建议：把 reason 改回描述省略计数行为（或至少同时提到），保持清单说明与代码一致。

**9. “round.json 每条用例带 shouldPropose”不成立；且该字段没有参与评分**

- 文件/行：`test/integration/jarvis-test/live-round.test.ts:192-198`；`test/integration/jarvis-test/dataset.test.ts:20-43`
- 问题：只有 `proactive_next_step` 用例带 `shouldPropose`；其他场景在 round.json 里会被省略，测试还明确要求它们必须 `undefined`。另外，`shouldPropose` 只写进 round.json，评分仍只看 `answer.expectations`/judge，不在代码里用于判定“该不该提”。所以“每条用例带 shouldPropose”与代码和测试都不一致。
- 证据：
  - `live-round.test.ts:197`：`...(item.shouldPropose === undefined ? {} : { shouldPropose: item.shouldPropose })`
  - `dataset.test.ts:40-42`：非 proactive 用例 `expect(item.shouldPropose, item.id).toBeUndefined()`
- 建议：把材料里的说法改成“每条 proactive 用例带 shouldPropose”；如果希望它参与自动判定，需要在 grader 里显式使用它，否则明确它只是分析用的元数据。

## 推测 / 未核实

- **未核实**：我无法运行测试（工具限制），以上“反向用例会/不会失败”是静态推断，实际执行结果未核实。
- **未核实**：`.agents/reviews/pr-452/round-1/judgments.md` 不可读（稀疏检出里没有该文件，`git show` 被 records-path 保护拒绝），所以作者关于第 1 轮第 7 条“判为不成立”的理由未核实。
- **未核实**：`prompt-manifest.json` 的 sha256 是否与当前 catalog 完全一致未计算；代码里存在 `PROMPT_MANIFEST_STALE` 检查（`apps/agent-service/test/prompt-catalog.unit.test.ts:187`），但我没有执行它。
- **推测**：`localeCompare` 不指定 locale，在不同 LANG/ICU 的部署上可能给出不同顺序，跨实例时同一内容可能出现不同字节；同一进程内是确定的。
- **推测**：生产 `readText` 在 `production-run-composition.ts:273-284` 没有 try/catch，新增的“读取所有带日期记忆”会让单个损坏 payload 更容易中断整轮 compose；改动前只有高重要度/置顶记忆和提醒会读文本。
- **待产品确认**：一条高重要度带日期记忆可能同时出现在 `owner-profile`（带 dateNote）和 `owner-agenda`，因为 `#select` 和 `#agenda` 是两条独立选取路径。代码上能证实重复可能出现，但是否算问题取决于产品预期。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会改变已发出历史的内容。
- 新的 agenda 文字通过 `contextBlocks` 进入 `turnPrompt`，而 `turnPrompt` 只渲染最后一条用户消息（`packages/runtime-pi/src/pi-runtime-adapter.ts:639-657`；`context-projection-service.ts:403-435`）。上一轮的最后一条消息在历史里按发送时的内容保存，不会被重写。
- 新增的 `chat.identity` 一句话是系统提示文字，属于按对话冻结的开头。已有对话由 `thread-prompt-bundle-service.ts:201-207` 直接返回旧 bundle（工具不变时），不会换成新文字；只有新对话从开始就使用新系统提示。这符合 `prompt-prefix.md` 第 6 条“改了提示词文字，只对新对话生效”。
- 每轮会变的 `now`、`declined`（pin 选择）、提醒列表、日期标签都只在最后一条用户消息里。
- 一个细节：agenda 块在最后一条消息内部是插在 `owner-profile` 之后、`thread-summary`/选中记忆/能力/运行环境之前，并不是该消息的最末尾；但整条消息本身就是请求的末尾，所以不影响前缀缓存，也不改变已发出的历史。
- 旧的 `chat.identity` 文字从 `TRUSTED_PROMPT_TEXTS` 移除后，旧对话冻结的系统提示会被当成外来内容检查；新增测试 `apps/agent-service/test/trusted-prompt-egress.unit.test.ts:117-129` 验证了紧邻的上一版文字原样发送、不会被遮盖。按规则第 11 条，只有旧文字里含会被认成敏感信息的数字时才会变一次；这段旧文字没有这种数字，测试也覆盖了该具体版本。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

同一部署、同一进程内基本不会，且改动把数据库返回顺序的影响消除了：`entries.sort` 有 `day/timed/instant/tie/label` 的完整比较，提醒和带日期条目不再依赖 `listUpcoming` 的返回顺序；`new Set` 去重也沿着已排序的 `lines` 走。遮盖逻辑没有新增依赖前后文的分支。
- 但定序用了 `localeCompare`（`owner-profile-service.ts:348-352`），顺序依赖运行时的默认 locale/ICU；跨部署或跨实例时同一组 id 可能排成不同字节。这是唯一明确的确定性问题。
- `Intl.DateTimeFormat` 的输出也依赖 ICU 版本，但同一部署内稳定。
- agenda 内容本身会随 `now`、pin、提醒变化，这是允许的，因为它只在最后一条消息里。

**3. 有没有对应的自动检查？反向用例是否真的会失败？**

有检查，但我没有执行，实际通过情况「未核实」。静态看：
- `owner-profile-service.unit.test.ts:700-711`（关掉的记忆被排除）在移除 `declined` 后会失败。
- `:713-727`（同一时刻提醒定序）在把 `tie` 改回空串后会失败。
- `:682-698`（过去/未来/无日期/超分级）在去掉窗口或分级过滤后会失败。
- `:771-780`（一条都放不下也发块并计数）在把条件改回 `lines.length > 0` 后会失败。
- `dataset.test.ts:20-43` 会守住 `shouldPropose` 的布尔值和同 prompt 双标签。
- 但有三个缺口：问题 5 的“预设结果只对 web 工具生效”反向用例不会失败；问题 6 没有“提醒不受关开关影响”的用例；问题 2 没有“提醒列表被截断/端口缺失时不写没有提醒”的用例。`round.json` 的 `shouldPropose` 只在 `LIVE` 用例里写出（默认跳过），也不是评分输入。

**4. 每个新值/修改值，两端是否都能接受？**

- `declined`（`ReadonlySet<MemoryId>`）：产生端是 `listProfilePins` 的 `pinned=false`，消费端是 `#agenda`；值本身是合法 `MemoryId`。但生产端 `memory.pin/unpin` 只允许 `PINNABLE_CATEGORIES`，对 event/health/finance 无法产生 false（问题 1）。
- `agendaCharacterBudget` / `OWNER_AGENDA_CHARACTER_BUDGET=2400`：只在 `#agenda` 使用，可选，测试有覆盖；生产未配置，使用默认值，能接受。
- `AGENDA_REMINDER_LIMIT=100`：传给 SQLite `listUpcoming`，SQLite 限制 `0..200`（`sqlite-memory-reminder-operations.ts:74-77`），100 合法。
- `memoryLocalDate` 导出：所有调用点已改用新名字，`memoryDateNote` 行为不变。
- 新增 prompt id `memory.agenda.dated/ending/omitted`：都在 `memory.ts`、`index.ts` 和 `prompt-manifest.json` 里；manifest 有 digest/缺失检查（未执行）。
- 新增 `shouldPropose`：`JarvisCase` 接受，`dataset.test` 校验；`history.mjs` 的 `validateRecord` 不拒绝额外字段；round.json 消费方 `live.mjs` 只读 `cases/trials`。但“每条用例都带”不成立（问题 9）。
- 新增 `toolResults`：`CaseToolResult` 被 `FixtureRuntimeTools` 使用；`dataset.test` 限制 `tool` 只能是 `web_search/web_fetch`，与 `FixtureRuntimeTools` 的检查一致。
- 新增 `validFrom`：`context.ts:200` 传给 `attributes.validFrom`；生产捕获只接受 `YYYY-MM-DD`，SQLite `validMemoryTime` 也接受 date-only（`sqlite-memory-operations.ts:175-178`），两端一致。
- 新 scenario `proactive_next_step`：`cases.ts` 的 union、`history.mjs` 的 `SCENARIOS`/`SCENARIO_LABELS` 都已加；`test/tooling/jarvis-test-history.test.mjs:21` 还维护着只含三个场景的本地列表，但只用于构造测试记录，不会导致现有断言失败，属于维护性不一致。
- `memory.agenda.omitted` 的 manifest reason 与用途不一致（问题 8）。

## 总体结论

方案方向（不破坏请求前缀、把变化放在最后一条消息）成立，`declined` 和 `omitted` 的核心逻辑也有基本反向测试。但最严重的问题是：新 agenda 默认把 event/health/finance 等“主人关不掉、页面也说不会带上”的带日期记忆送进每轮上下文；其次是“没有提醒”标签在提醒列表被截断或提醒端口缺失时可能不实。建议先解决这两点，再补测试缺口和文档/文案一致性。
