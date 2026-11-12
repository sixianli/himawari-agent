我先读方案引用的关键文件和规则，再逐条核对。
最后快速核对方案引用的一手来源里最关键的一条（限时自动过期的业界先例）：
# 审核结论

核对范围：方案引用的前提我逐一读了原文件（ADR 0213/0244、production-owner-rules.ts、rule-types.ts、rule-book.ts、production-mcp-rule-writer.ts、production-thread-titles.ts、sqlite-model-usage-operations.ts、pi-runtime-adapter.ts、data-export、recall、推送闸门调用点、check:egress-redaction 脚本、MODEL_USAGE_PURPOSES）；业界先例抽查了 Claude Code 定时任务文档（原文确认："Recurring tasks automatically expire 7 days after creation"、"CronCreate … whether it recurs or fires once"，https://code.claude.com/docs/en/scheduled-tasks ，与方案引用一致）。仓库是 70% sparse checkout，个别文件没读到的地方标了「未核实」。

## 证实的問題（按严重度）

**1.（高）过期的 `push_quiet_hours` 规则会变成“永久误报告警”，不是“安静失效”。**
- 问题：方案只说“所有执行点改成 `enforceableOwnerRule(row, now)`”，漏了 `unreadablePushRule`。它内部的判定是“不 retired 且 enforceableOwnerRule 返回 undefined → 看类型是不是 push_ 开头 → 是就报读不懂”（`packages/application/src/rules/rule-types.ts:426`、`:432`）。规则一过期，`enforceableOwnerRule` 返回 undefined，但类型仍是 `push_quiet_hours`，于是 `unreadablePushRule` 返回 true；推送闸门读规则时直接 throw（`apps/agent-service/src/service-main.ts:2393` `if (unreadablePushRule(row)) throw new Error("PUSH_RULE_UNREADABLE")`），按 ADR 0244 决定 7“判断器或规则读取出错，推送照发，并告警”。结果：一条到点该失效的静默规则，让它的每个覆盖类别每次推送都打 `WEB_PUSH_RULE_GATE_FAILED` 告警，直到主人手动撤销——“到点自动失效”在推送这条路上实际变成“永久告警”。
- 建议：`unreadablePushRule` 也要带 `now`，把“过期”和“参数坏掉”分开：过期返回 false（闸门安静放行），参数坏掉才报读不懂；并加反向用例（现有 `rule-type-push-quiet-hours.unit.test.ts` 只测参数坏掉，过期场景没有任何现有测试会失败）。

**2.（高）对已到期规则重新说同一句话，会报错而不是新立/恢复。**
- 问题：`#activate` 的去重只比 type+params，不看时效（`apps/agent-service/src/production-owner-rules.ts:658-661`）；命中后走 `reconfirm`，而 `reconfirm` 对 `enforceableOwnerRule(current) === undefined`（即已过期）的规则直接抛 `RULE_UNAVAILABLE`（`:864-865`）。方案说“过期规则不改数据库状态”，所以到期后主人再说一遍同一句限时要求（哪怕给了新到期时间）时：如果新 until 不进 same 比较，same 照样按旧参数命中旧规则 → reconfirm 抛错 → 主人看到“操作失败”。方案只在“32 条上限”处提了过期不计数，没有处理去重和重新确认这两处。
- 建议：去重查找、上限计数、reconfirm 统一按 `enforceableOwnerRule(row, now)` 口径；过期规则在去重时视为不存在（重新说就新立一条带新 until 的），或者允许“重新确认”带新时效恢复旧规则——二选一要写进方案，并加假时钟反向用例。

**3.（中）“数据导入遇到不认识的到期字段要拒绝”需要显式加顶层键白名单，现有解析不拒绝未知键。**
- 证据：`parseOwnerRuleParameters` 只读 type/summary/params，参数对象里的其他顶层键一律忽略（`packages/application/src/rules/rule-types.ts:379-396`）；`params` 内部的未知键倒是会被各 `parse*` 拒绝（如 `:111-112`、`:227-228`）。导出导入校验 `storedRuleProblem` 复用同一条 `ownerRuleRecord` → `parseOwnerRuleParameters` 链（`packages/persistence-sqlite/src/data-export/rules.ts:117-124`、`packages/application/src/rules/rule-version.ts:130-138`），所以只要把 `until` 校验（格式、UTC 归一、上下限）加进 `parseOwnerRuleParameters` 并同时把顶层键收紧为 `{type, params, summary, until}` 白名单，导入端自动跟着拒绝；否则一条带 `expiresAt` 的导入会静默按长期规则执行，正是方案要防的事。
- 建议：把“顶层键白名单 + until 校验进 parseOwnerRuleParameters”写明为实现要求，并在 `test/integration/data-export-rules.test.ts` 加反向用例（带未知道期的导入被拒、合法 until 往返）。

**4.（中）数据导出/显示侧三处没跟上：计数、说明文字。**
- `enforcedRuleCount` 只看 `status !== "retired"`（`data-export/rules.ts:47-49`），过期规则会被 RULES.md 写成“正在执行”；`ownerWording`/`pushQuietWording`（`:178-196`）也不显示到期时刻。方案声称“数据导出都显示‘长期’或‘到 11-16…为止’”，这三处必须一起改，否则文档承诺与导出产物不一致。
- 建议：显示统一由 `parseOwnerRuleParameters` 解析出的 until 渲染；`enforcedRuleCount` 接收 now。

**5.（中）`SET_ARGUMENTS` 与工具 schema 的同步没有点名。**
- `ProductionOwnerRuleTools.run` 按 `SET_ARGUMENTS` 白名单校验参数名（`production-owner-rules.ts:52`、`:975-983`），descriptor 的 `required` 也要加 scope（`:328`）。方案只说“rule_set 加必填 scope”，没列这两处；漏掉任一处，主模型给的 scope 会被静默丢弃或直接报 `RULE_INPUT_INVALID`。

**6.（低）`until` 上限没有数值。**“`until` 早于现在或超过上限”里的上限没定义。建议定死（例如 90 天），写进反向用例。

**7.（低）用途白名单的反向保障没列。**`sqlite-model-usage-operations.ts:20-36` 的 `valid()` 要求 purpose 在 `MODEL_USAGE_PURPOSES`（`packages/application/src/ports/model-usage.ts:3-13`）里，没登记的用途记录直接失败。方案已列“记新用途 rule-scope”，建议再加一条反向测试（没登记时 record 失败要被测试看见），防止实现时漏加而用量静默丢失。

**8.（低）文档与代码一致性问题。**ADR 0213 决定 5 整段描述词表行为、ADR 0244 决定 5 说“这张词表对所有规则类型通用”；删除词表后这两段以及 ADR 0213“放弃的做法”要补记这次决定（按 incident-gates 流程这次不涉事故，但文档不同步正是 I-06 那类问题）。方案的测试节只字未提文档更新。

## 推测（未完全证实或需要设计决定）

**9.（中，推测）敏感级原话会让核对模型永远失败，且遮盖口径需对齐。**
- 旁路调用走 `generateTextOnce`，有数据分类门禁：descriptor 不允许该分类就抛 `*_DISCLOSURE_DENIED`（`apps/agent-service/src/production-model-composition.ts:578-582`）。主人消息若被标 sensitive，核对调用每次都失败 → 一律降级为提议。这是安全方向的降级，但方案应写明。另外主对话历史是出口遮盖后发给模型的（`.claude/rules/prompt-prefix.md` 第 5 条），模型 quote 里的敏感值是占位符；核对输入若用未遮盖原文，`evidence` 子串核对与 quote（含占位符）之间、quote 与 `quotesWholeClauses` 对原文的匹配之间，口径要统一（现状：含遮盖值的 quote 本来就过不了 `quotesWholeClauses`，只能成提议——这条链路行为需要实测确认，标推测）。

**10.（中，推测+未核实）“召回时过滤掉过期的偏好”现在并不存在。**
- 现状召回只在结果里标注 `current: true/false`，不排除（`apps/agent-service/src/production-memory-recall.ts:306-314`）；写库侧 `validMemoryTime` 接受 UTC ISO（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:173-179`），写入没问题。要落实“过滤”需改召回/投影层。偏好到底经哪条路径进提示词（档案块还是 recall 块）我没追到底，标未核实；但“现在只是标注、不是过滤”这一点是代码可证的。另外 `validTo` 在 consolidation/checkup 里语义是“被取代时刻”（`packages/application/src/services/memory-checkup.ts:302`），复用它表达“到期”要先确认整理任务不会拿它误判偏好记忆。

## 侧重检查

**走过的流程**（最普通的一条：主人说一句限时要求）：
网页发送 → 主模型（`pi-runtime-adapter.ts:628-633`，当地时间在本轮最后一条消息，符合规则）→ 调 `rule_set`（新参数 scope）→ `ProductionOwnerRuleTools.run` 参数校验（`production-owner-rules.ts:975-983`，需加 scope）→ `create()`（`:751`）→ soft 分支（`:765-786`，方案要插入核对）/规则分支（`:788-801`，删词表改核对）→ 核对模型旁路调用（全新代码，现有零覆盖，方案计划用回环模型补）→ 程序判定表 → `#activate`（`:649`）→ 去重 same（`:658`，问题 2）→ 上限（`:676`）→ 写记忆（`:680`，validTo 问题 10）→ 回执 → 网页回执卡/记忆页“长期规则”→ 执行点四个：推送闸门（`service-main.ts:2385-2396`，问题 1）、邮件检查（`proactive-mail-check-service.ts:641`）、MCP 读（`production-mcp-read.ts:306`）、rule_list（`:845-858`）。

**没有测试覆盖的代码路径**（对照方案第五节自列的测试）：
- 方案计划覆盖的：判定表逐行、假时钟、反向用例、`check:prompt-prefix`、工具换新——方向对。
- 方案没列、现有测试也不会拦的：(a) `unreadablePushRule`×过期（问题 1）；(b) 过期后的去重/重新确认（问题 2）；(c) 顶层未知键导入（问题 3）；(d) 导出计数与说明文字（问题 4）；(e) 网页回执卡和记忆页的时效显示——按 I-08 的教训，UI 改动必须有改坏即红的测试，方案测试节完全没提 control-center 侧；(f) 配置键缺失→不直接生效的反向用例；(g) 用途白名单反向（问题 7）。

## 如果由我来定，我会怎样改这份方案

整体框架（两个读者读整句 + 程序只做可判定核对 + 到期失效）我保留，方向和业界先例一致（Claude Code 定时任务“一次性/重复是显式结构、循环任务 7 天自动过期”，https://code.claude.com/docs/en/scheduled-tasks ；关键判断用独立轻量模型加结构化输出，https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks ）。改动：

1. 增加一节“过期规则的完整口径”：`enforceableOwnerRule(row, now)`、`unreadablePushRule(row, now)`、去重、上限、reconfirm、`enforcedRuleCount`、RULES.md 显示，七个点一个不漏，每个配反向用例（问题 1、2、4）。
2. `parseOwnerRuleParameters` 收紧为顶层键白名单 `{type, params, summary, until}` 并校验 until（格式、UTC、上限数值定死），导入导出反向用例跟上（问题 3、6）。
3. 实现清单点名 `SET_ARGUMENTS` 和 descriptor `required` 两处同步（问题 5），`MODEL_USAGE_PURPOSES` 加 `rule-scope` 并加反向测试（问题 7）。
4. 写明敏感级消息的核对策略（接受降级或先遮盖再核对，二选一），以及升级后确认旧格式提议的行为（按长期生效，接受并记录）。
5. 测试节补 control-center 回执卡/记忆页显示的用例；文档节补 ADR 0213、0244 词表段落的更新。

## 必答问题逐条回答

1. **请求开头**：不受影响，结论“仍只追加”成立。发给主模型的内容新增的只有：工具定义换新一次（规则第 6 条允许，每次留记录）、`scope` 出现在新追加的工具调用和历史里、核对结果在工具结果里（都在末尾）。每轮会变的值（当地时间）本就在本轮最后一条消息（`pi-runtime-adapter.ts:631`），本次改动没有往系统提示或工具定义里加会变的值。“赶在 PR 414 上线前合并”的判断正确：ADR 0244 已把 `rule_set` 参数结构改过一次且未上线，同批合并则老对话总共只付一次全价重建，晚于其上线就要付两次。
2. **字节确定**：程序侧判定全部可复现（UTC 归一、子串核对、枚举、取较早时刻、≤1 小时比较）；发给主模型的内容没有新增依赖前后文的遮盖或进入请求头的带时间字段。核对调用是旁路，每次输入含当前时间，但它不进主对话、不参与逐字节缓存比较，符合规则第 15 条（固定指令在前、数据居中、时间最后）。两个实现要求要写进方案：参数/提议 JSON 用固定键序（canonical 序列化，规则第 10 条）；本地时间→UTC 转换固定用时区配置（DST 歧义对东京时区无影响，但时区可配置就要写明规则）。
3. **自动检查**：方案列的集成测试、假时钟、反向用例、`check:prompt-prefix` 照跑是有的且方向对；但如上，七处“过期口径”里至少 (a)(b)(c)(d)(e)(f)(g) 没有对应测试计划，其中问题 1、2 是“反向用例不补就永远验不出来”的类型。回答：核对调用失败路径的检查在计划内，过期规则与闸门的交互检查缺失，必须补。
4. **每个值的两端核对**：`scope`——产生（主模型）↔ 使用（`SET_ARGUMENTS`/descriptor 校验、判定表、proposal JSON、parseOwnerRuleParameters、导出导入、显示），两端校验都要新增，方案部分覆盖；`until`——产生（核对模型，子串核对+边界校验）↔ 使用（四个执行点 + `unreadablePushRule`【方案漏】+ 去重/上限/reconfirm【方案漏两处】+ 导出显示【方案漏计数】+ 决策记录依据），漏点见问题 1、2、4；配置键——产生（配置）↔ 使用（descriptors 查找，缺失不直接生效，方案对）；`rule-scope` 用途——产生（调用点）↔ 使用（`MODEL_USAGE_PURPOSES` + sqlite `valid()`，方案已列，建议补反向测试）；偏好 `validTo`——产生（soft 写入处 `:609`）↔ 使用（`validMemoryTime` 写入校验、recall 标注【需改为过滤，现状不是过滤】、owner-profile-service:111 已过滤），复用字段的语义冲突未核实。
