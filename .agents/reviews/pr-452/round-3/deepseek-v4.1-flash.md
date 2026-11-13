## 结论

这一轮的增量（“提醒全部读到”才加“这 7 天里没有提醒”、码元排序、评测环境接提醒存储、三种语言说明、新增用例）大体按作者说法实现了；未发现新增工具、表、迁移或不可逆操作。主要问题是：**纯日期记忆的窗口口径和作者“从现在起 7×24 小时”的说法不一致**，以及**用户可见说明对“哪些记忆会进近期安排”写得比代码窄**。

## 读代码证实的问题

### 【中】纯日期记忆实际按“当地日期闭区间”算，不是作者说的 7×24 小时窗口

- 文件：`packages/application/src/services/owner-profile-service.ts:274-275`、`323-329`；`packages/application/test/owner-profile-service.unit.test.ts:792-804`
- 问题：带时间的提醒确实用 `[now, now+7×24h]`；但纯日期记忆走 `dayInWindow` 的纯日期分支，只比较 `firstDay` 到 `lastDay`，不比较具体时刻。测试明确要求“包含两端”，即 `10/25`（今天）和 `11/01`（第 7 天）都进。这样实际覆盖的是 8 个当地日期标签，最后一天可包含晚于 `now+7×24h` 的日期，今天更早的时间点也会被算进来。作者说第 2 轮第 3 条（窗口跨 8 个当地日期）“判为不成立：窗口是从现在起 7×24 小时”，这只对带时间的提醒和 ISO 时刻成立，对纯日期不成立。
- 证据：
  - `owner-profile-service.ts:274-275`：`firstDay = memoryLocalDate(input.now, timeZone)`、`lastDay = memoryLocalDate(until, timeZone)`
  - `owner-profile-service.ts:326-328`：只有 `value.includes("T")` 时才检查 `instant <= now || instant > now + AGENDA_HORIZON_MS`
  - 测试 792-804：同时期望 `10/25` 和 `11/01` 出现
- 建议：先明确语义。若要求“从现在起 7×24 小时”，纯日期也应按当地日边界换算成 `[now, until]` 能覆盖的日期集合；若要求“今天起 7 个当地日”，应把窗口改成 `firstDay + 6` 或明确写“含今天共 8 个日期标签”，并补一个 `now` 接近当地午夜、日期恰好落在第 7/第 8 个当地日的边界测试。不要只用“包含两端”的测试代替边界测试。

### 【中】记忆页说明对“敏感记忆”和“所有带日期记忆”的表述与代码不一致

- 文件：`apps/control-center/src/i18n/resources/en.ts:942-943`、`ja.ts:947-948`、`zh-CN.ts:891-892`；`packages/application/src/services/owner-profile-service.ts:31-37`、`196-201`、`220-228`、`330-349`
- 问题：说明里写“健康、财务等敏感记忆和事件不会放进这里，只在相关时才调出；其中带日期、日期落在接下来 7 天里的，会另外作为近期安排带上”。但代码的近期安排没有类别过滤，`eligible` 里任何类别的 `validFrom`/`validTo` 都会进；因此带日期的 `project`、`identity`、`rule` 等也会进。另一方面，代码允许 `sensitive` 分类进入档案（`modelVisibleCeiling()` 为 `sensitive`，`factLines` 只看类别和重要度），所以“敏感记忆不会放进这里”对 `identity/preference/relationship/goal/project` 里的敏感记忆也不准确。作者第 4 条说方案原文是“带日期的记忆也进这一块”，那么是说明文字不完整；如果方案只限敏感/事件，则是代码过滤条件缺失。
- 证据：
  - 说明：英文“Sensitive memories such as health or money, and events, are never included here; ... those dated within the next 7 days are also brought in separately as upcoming plans.”
  - `owner-profile-service.ts:330-349`：`for (const memory of eligible)` 后直接取 `validFrom`/`validTo`，没有类别判断
  - `owner-profile-service.ts:220-228`：档案只按 `PROFILE_SECTIONS` 类别和重要度挑选，未排除 `sensitive`
- 建议：三语说明统一改成“带日期的记忆”并说明类别范围；若计划只允许敏感/事件，在 `#agenda` 加类别过滤并补 `project`/`identity` 的反向测试。另可区分“数据分级 sensitive”和“健康/财务类别”，避免用户误以为所有敏感记忆都不会进档案。

### 【低】历史趋势测试仍硬编码三个场景，新增场景没有进入历史报告测试

- 文件：`test/tooling/jarvis-test-history.test.mjs:21`；`scripts/jarvis-test/history.mjs:4-15`
- 问题：生产脚本的 `SCENARIOS` 已加 `proactive_next_step`，但历史报告测试自己维护的三场景列表没加。`summarize/compare/renderTrend` 对新场景的分支不会被这些测试覆盖；将来 #9 的标签、排序或汇总写错，测试仍可能通过。
- 证据：`test/tooling/jarvis-test-history.test.mjs:21` 是 `const SCENARIOS = ["memory_correction", "state_discipline", "failure_transparency"];`
- 建议：测试直接从 `history.mjs` 导入 `SCENARIOS`，或在本地列表同步加 `proactive_next_step`，并构造一条带 #9 用例的记录。

### 【低】“敏感分类的带日期记忆进入近期安排”没有正向测试

- 文件：`packages/application/test/owner-profile-service.unit.test.ts:767-776`；`memory` 辅助函数在 `:18-44`
- 问题：新增的“lists dated health and finance memories”用例使用的是 `dated()` 默认分类；`memory()` 默认 `dataClassification: "private"`。它验证了类别，但没有验证 `sensitive` 分类的带日期记忆在 `maxClassification: "sensitive"` 下会进入近期安排。说明文字声称“敏感记忆会另外带上”，这条关键路径目前只有“敏感被 private ceiling 排除”的反向测试，没有正向测试。
- 证据：`memory()` 第 32 行固定 `dataClassification: "private"`；新用例 `:767-776` 未覆盖 `dataClassification: "sensitive"`。
- 建议：加一条 `dated(..., { dataClassification: "sensitive" }, "health")` 且 `agendaText("sensitive")` 的正向用例，同时保留现有 private ceiling 反向用例。

## 推测 / 待确认

### 【中/低·推测】纯日期 `validTo` 等于今天时，永远显示不出“截止今天”

- 文件：`packages/application/src/services/owner-profile-service.ts:114-119`、`323-329`
- 推断：`currentlyValid` 用字符串比较 `attributes.validTo > now`。当 `validTo = "2026-10-25"`、`now = "2026-10-25T12:00:00.000Z"` 时，`"2026-10-25"` 是 `now` 的前缀，比较结果为假，记忆被过滤掉。因此新加的“截止”标签对“截止当天”的纯日期记忆不会出现；带时区偏移的 ISO `validTo` 用字符串比较也可能与真实时刻不一致。
- 建议：`currentlyValid` 对纯日期按当地日结束时刻比较，或统一先解析成时刻再比较；补 `validTo` 为今天、带 `+09:00` 偏移的边界测试。

### 【低·推测】同一记忆同时有开始和结束日期时会生成两条近期安排，可能重复计数

- 文件：`packages/application/src/services/owner-profile-service.ts:333-349`
- 推断：同一个 memory 的 `validFrom` 和 `validTo` 都在窗口内时，会 push 两条 entry；当天计划会显示两次原文，`omitted` 也可能按两条计数（“另有 2 项”实际是一条记忆）。现有测试没有覆盖“同一条记忆同时有起止日期”。
- 建议：明确期望是一个区间条目还是两条；若要两条，补测试并说明省略计数；否则按 memory 去重。

### 未核实

- 方案文件 `proposed-actions-plan.md` 在当前检出中不存在，无法核对 Andy 对“所有带日期记忆都进”的原始批准范围。
- `prompt-manifest.json` 的 SHA 无法在只读限制下重算；只能确认 id 已加、旧 id 已清、源码与 manifest 的条目对应。
- 未运行测试；以上“反向用例会失败”的判断来自读代码和断言，不是实际运行结果。

## 侧重检查

- **错误路径**：`#agenda` 对 `listUpcoming` 没有 try/catch，存储异常会让整个上下文组装失败；这是改动前就有的路径。新增日期读取由 `memoryDatesOf`/`isDateText` 过滤，非法 `validFrom`/`validTo` 会被当作 `null`，不会因新日期路径崩掉。若存储返回非法 `dueAt`，`memoryLocalDate`/`Intl` 仍可能抛错，也是改动前提醒路径已有的风险。
- **不合规范或不可信输入**：记忆正文仍按普通资料处理，没有新增“资料当指令”的路径；测试用 `toolResults` 只对 `web_search`/`web_fetch` 生效，`read` 的预设被测试明确忽略。`validFrom`/`validTo` 来自记忆属性，有格式白名单。
- **安全 / 隐私**：带日期的 `sensitive` 记忆现在会自动进入每轮近期安排，分类上限仍由 `modelVisibleCeiling()` 控制；主人关掉的记忆不会进日期条目，但已有提醒仍保留（新测试 `owner-profile-service.unit.test.ts:755-765` 固化了这一点）。作者说明这是既有行为，且不要拿“没有开关”再报缺陷；我按此处理，只报告了说明文字的范围问题。
- **资源耗尽**：`AGENDA_REMINDER_LIMIT` 从 10 提到 100、`OWNER_AGENDA_CHARACTER_BUDGET` 从 800 提到 2400，`gateway-judges.ts:101` 的 `max_tokens` 从 2000 提到 8000；近期安排还会遍历所有带日期记忆并逐条 `readText`，即使预算已用完也继续读取以统计省略数。整体有上限，但每轮请求大小、解密次数和评测裁判费用都上升了，建议在 PR 说明里记录这些是有意取舍。
- **不可撤销操作**：没有。改动只读记忆/提醒并生成文本，没有写入业务表或执行工具。
- **文档与规则一致性**：`docs/agent-rulebook-inventory.md` 的 S-15 已同步新规则；记忆页说明存在上述范围不准确；ADR 0112/0193 仍是历史决定，没有同步“带日期记忆进近期安排”的新行为（不一定是本 PR 必须改，但建议在相关 ADR 或方案里留记录）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 对已有对话，不会：系统提示和工具按对话冻结（`thread-prompt-bundle-service.ts:190-207` 只在工具、模型、推理强度、语言、分类等变化时换新），`CHAT_IDENTITY` 的新句子只进入新对话或手动换新的对话；`production-run-policy.ts:102-123` 用当前身份创建/复用系统指令。历史消息不变。每轮变化的近期安排通过 `pi-runtime-adapter.ts:639-657` 的 `turnPrompt` 放在最后一条用户消息的 `<himawari-context>` 中，仍然只在末尾追加。新增 `CHAT_IDENTITY` 句子会改变“固定文字”清单，但 `trusted-prompt-egress.unit.test.ts:116-127` 验证了旧身份的原文可以原样发出、无拦截记录；旧文字没有可被误认成敏感值的数字。结论：**已有请求开头不变；新对话会使用新系统提示；每轮变化值都在最后一条消息里。**
2. **同一段文字会不会在不同请求里变成不同字节？** 近期安排的排序已全部换成码元比较（`byCodeUnit`，`owner-profile-service.ts:351-358`），不再依赖 `localeCompare`；提醒列表先排序再输出，集合顺序固定；日期和时间使用固定 locale 和配置时区，不受请求顺序影响。唯一会随请求变化的是最后一条消息里的日期、提醒数量和“这 7 天里没有提醒”后缀，这是允许的每轮变化。`#select` 里仍有 `byImportance` 的 `localeCompare`，但它不用于近期安排。未发现会改变已有前缀字节的新逻辑。
3. **有没有对应自动检查，反向用例会失败吗？** 有：`owner-profile-service.unit.test.ts:695-716` 覆盖没接存储/提醒被截断时不写“没有提醒”，`:755-765` 覆盖关掉开关后提醒仍在，`:778-790` 覆盖同一时刻按提醒编号码元排序，`live-harness.test.ts:105-131` 覆盖预设搜索结果和 `read` 预设被忽略，`dataset.test.ts:20-43` 覆盖 `shouldPropose` 标签，`trusted-prompt-egress.unit.test.ts:116-127` 覆盖旧系统提示不被改动。按代码推断这些反向用例会在相应回归时失败。缺口是：历史报告测试的三场景硬编码、没有敏感分类带日期记忆的正向测试、没有纯日期窗口/截止当天的边界测试；已在上文列出。
4. **每个新值两端都能接受吗？** 已逐个核对：
   - `memory.agenda.ending`、`memory.agenda.unreminded`：源码 `memory.ts:285-302` 产生，manifest `prompt-manifest.json:537-551` 登记，`owner-profile-service.ts:340-347` 使用；旧的 `memory.agenda.dated` 已从源码和 manifest 清除，仓库中未发现残留引用。
   - `OWNER_AGENDA_OMITTED` 使用 `count` 槽，和 `renderPrompt` 的槽校验一致。
   - `CaseMemory.validFrom`：`cases.ts:20` 接受，`context.ts:200` 消费为 `validFrom: memory.validFrom ?? memory.recordedAt`，日期格式由 `memoryDatesOf` 再校验，能被接受。
   - `shouldPropose`：只在 `dataset.test.ts` 和 `live-round.test.ts:192-204` 使用，未进入评分；`history.mjs` 的 `validateRecord` 不校验额外字段，能被接受。
   - `toolResults`：只由 `FixtureRuntimeTools` 消费，且只对 `web_search`/`web_fetch` 生效；`read` 预设被忽略的测试已覆盖。
   - `Scenario` / 历史场景：`cases.ts`、`history.mjs`、`dataset.test.ts` 都接受 `proactive_next_step`；但 `test/tooling/jarvis-test-history.test.mjs:21` 的自有列表没有同步，这是测试覆盖缺口，不是生产值被拒绝。
   - `datasetVersion`：只作为记录和比较字段，没有后端格式校验；新值可接受。
   - manifest 的 SHA 无法在本次只读环境重算，标记为未核实。
