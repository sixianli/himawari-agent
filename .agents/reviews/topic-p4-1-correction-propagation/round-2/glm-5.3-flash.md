# P4-1 方案审核报告

## 侧重检查（先读这段：我走过的流程和结论）

我沿一条最普通的使用流程走了一遍：**主人改一条规则类记忆（网关 `memory.mutate`）→ 触发器标记 → 程序展开 → 规则重检 → 主人在待确认列表处理**。

- `memory.mutate` 写入 `memory_records`（`apps/agent-service/src/production-memory-control.ts:1173`）→ 0087 触发器标规则 `needs_review`（`packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:301-361`），这条已有集成测试（`test/integration/rule-memory-review.test.ts`）。
- 方案新增的 review-items 触发器和 expand 是纯新增代码：方案第 7 节的服务层测试覆盖了触发器语义本身，但**三个挂载点（网关命令完成后、对话开始、邮件检查前）会不会真的调 expand，没有任何测试**。对照 I-05 的教训（漏声明相关测试），这段 glue 代码必须进 Layer-0 声明。
- 规则重检的判定逻辑已部分落地（`packages/application/src/rules/rule-review.ts`，本次提交 52d9eab），有单元测试。
- 待确认列表查询和四条主人命令、重试上限/节流/单飞、MCP `rule_book` 和决策链对 `suspended` 的显示，都**没有对应的测试计划**。
- 结论：方案测试一节偏“服务层语义”，缺“接线”和“消费端”覆盖，详见下文第 7 条。

## 证实的（按严重度从高到低）

**1.〔高〕应用层决策记录端口不认识新结果值 `suspended`，第一次写就会失败（I-73 同类错误）**
方案第 4 节只说重建 `decision_ledger` 的 CHECK，但应用层有一份平行清单：`packages/application/src/ports/decision-ledger.ts:57` `rule_review: ["needs_review"]`，`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:58-59` 用它校验：`if (!outcomes.includes(write.outcome)) return "Decision ledger outcome is invalid"`。expand 写 `rule_review/suspended` 决策记录会被端口拒绝。这正是 I-73（“双模型复核只看了改动，没问清单里的 id 能通过后端校验吗”）的形状：改了 DB 一端，没查程序另一端。**建议**：第 4 节明确加 `DECISION_OUTCOMES.rule_review` 增补 `suspended`，测试里加“写 suspended 决策记录成功”的正例和“漏改端口即失败”的反例。

**2.〔中高〕suspended 让主人要求悄悄失效，和 ADR 0211 的既定原则冲突，且没有任何主动通知**
ADR 0211（`docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md:51`）原话：“待重审的规则**照常执行**……规则停掉等于主人的要求悄悄失效，违背‘硬偏好必定执行’”。方案引入 `suspended`（停止执行），但第 6 节只放在“记忆页‘长期规则’一节下方列出”——主人不翻页就永远不知道自己的规则停了。方向可以是安全的（模型说规则不再成立时停比继续强），但**必须有通知**：复用现有 proactive push/收件箱通道，在规则被 suspend 的那次写一条提醒；文档也要同步改（ADR 0211 的原则段、ADR 0219 `docs/adr/0219-read-only-mcp-entry-with-static-token.md:88` “列出生效中和待重新确认的主人规则，不列已撤销的”要加 suspended）。方案第 5 节列了网页和 MCP，没列文档，也没列通知。

**3.〔中〕suspended 与现有规则命令/设置保存路径的交互没定义（每个消费点没核完）**
`apps/agent-service/src/production-owner-rules.ts:700-733` 的 `reconfirm`：第 704 行只挡 `retired`；第 705 行 `enforceableOwnerRule(current) === undefined` 抛 `RULE_UNAVAILABLE`——如果第 5 节把 `enforceableOwnerRule` 改成排除 suspended，主人从设置页“重新确认”就永远无法恢复挂起规则，而方案没说这条路由怎么走；如果忘了改它，第 710 行只认 `needs_review`，`suspended` 会走到 `changed = current`，**返回 `enforced: true` 却没复活**（对第 498-502 行 `#activate` 里 `reconfirm(same.ruleId)` 的复用路径同样成立）。设置页整套重存（ADR 0211 第 51 条描述的路径）对 suspended 规则的行为也没定义。**建议**：明确“设置页保存值 = 重新校验后回 active（同建议采纳路径）或显式拒绝并指引待确认列表”，并把 `reconfirm`/设置保存对 suspended 的用例加进第 7 节。

**4.〔中〕触发器把整理（reflect）刷新正文当成“主人改了”，cleared 原因是错的**
方案第 2 节：“被改的记忆自己若是 pending，且 content_ref 变了（主人改了它）→ cleared（owner_edited）”。但 content_ref 变有两个写入口：主人编辑和整理 reflect 重写（后者正是这套传播机制的来源）。时序：A 被改 → B 标 pending → 次日整理按新 A 重写 B 的正文 → B 被标 `cleared/owner_edited`。行为上勉强说得通（正文已刷新），但“主人改了它”是判断错误，审计轨迹里的原因也是错的（对照 0087：整理写入同样会让规则 `needs_review`，那边是“标”不是“清”）。**建议**：cleared_reason 用中性的 `content_changed`，并在方案里写明“整理刷新正文同样清除 pending（正文已与新上游一致）”；不要试图在触发器里区分写入口——分不出来。

**5.〔中〕“超上限的留 truncated，下次继续”不成立**
`readDerived`（`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:370-408`）每次从同一根重算 BFS；同一批数据下，深度 8 / 节点 200 的截断点每次相同。expand 处理完 `expanded_at IS NULL` 的项后，被截断的下游**永远**进不了列表、关联规则也永远不被标——不存在“下次继续”。**建议**：要么承认截断即终点、在列表里显示“下游超过 200 条，已截断”；要么 expand 记录 frontier 水位从断点续走。以该库的规模，前者够了。

**6.〔低〕`memory_review_items` 缺外键和清理路径**
方案没写 `memory_id`/`upstream_memory_id` 的 FK。对照本库惯例（`memory_consolidation_change_basis`，0084:2-4 都是 `REFERENCES memory_records(id) ON DELETE CASCADE`），review items 的 memory_id 应级联删除，owner/agent FK 照其他表；上游记忆被删后，`memory.review.list` 的“上游现在的状态”要处理行不存在的情况。方案没提。

**7.〔低〕测试与反向用例缺口**
- 挂载点接线（见侧重检查）；
- 重试策略：`503 → 仍 needs_review` 有，但“3 次后只列出”“隔 1 小时”没有；
- `memory.review.list` 和四条命令（含期望 revision 冲突拒绝）无测试；
- 消费端无反向：第 7 节“让 suspended 照常执行”如果只改 `ruleIsEnforced`（`packages/application/src/rules/rule-book.ts:14`），照样全绿——`enforceableOwnerRule`（`rule-types.ts:304` 只挡 `retired`）、两处 SQL（`sqlite-owner-rule-operations.ts:88`、`sqlite-proactive-operations.ts:242`）、契约枚举（`packages/gateway-contracts/src/contracts-v2.ts:1055、1359`）每处都得各有一条“忘了改就失败”的用例（I-73 的教训就是单点测试护不住多消费点）；
- MCP `rule_book` 输出、决策链文案（`apps/control-center/src/i18n/resources/zh-CN.ts:1013` 等）、校准测试 `test/integration/decision-ledger.test.ts:263` 的 kind/outcome 配对清单要同步。

**8.〔低〕方案转述 0087 触发条件不准确**
方案说“status 离开 active”，实际条件是 `NEW.status IN ('archived','trashed','deletion_pending','deleted_verified')`、与旧状态无关（0087:311-312，从 archived 改 trashed 也触发）。写新触发器时照抄 SQL，别照抄这句转述；且方案第 2 节“不限分类”是对的、与 0087（限 `OLD.category='rule'`）不同，别混。

## 推测（未核实/需实施时确认）

- **触发器内能不能读到待删依据行**：BEFORE DELETE 触发器先于行删除和级联执行、此时 basis 行还在——与 0087 删除触发器同一模式，大概率成立，但实施时应有一条“直删记忆行也能传播”的测试（方案第 7 节已有这条，好）。
- **“邮件检查读规则之前”跑重检**：重检一次最多 3 条模型调用，若同步执行会拖慢 15 分钟一拍的邮件检查。建议写明重检异步、邮件检查读的是“重检开始前”的规则状态（慢就下一拍再生效）。
- **一次请求审几条**：第 3 节没写清是每条规则一次请求还是合并。若合并，多条记忆/规则的排列顺序必须固定（按 memory_id/rule_id 排序），否则违反确定性要求（见必答 2）。

## 方案里判断正确、值得保留的

- “SQLite 触发器里不能用 WITH”是对的：sqlite.org/lang_with.html §5 原话 "The WITH clause cannot be used within a CREATE TRIGGER."（https://www.sqlite.org/lang_with.html ）。触发器标直接下游 + 程序 BFS 展开是合理的替代。
- `purpose` 确实有 CHECK（`0068_model_usage_observations.sql:6-11`，STRICT 表，要重建），方案的条件式写法应改为确定要做。
- 比较逻辑现状（`rule-review.ts:23-25`）与方案一致：两侧都过 `parseOwnerRuleParameters`，`parseMailMatch` 去重排序、键序固定（`rule-types.ts:86、109-115`），比 type+params 不比 summary，是确定的。
- 决策记录结果值准确说是 `outcome` 列（0087:71 `kind='rule_review' AND outcome='needs_review'`），`verdict` 对 rule_review 恒为 NULL，别改错列。

## 如果由我来定

1. 保留“触发器标直接下游 + 程序展开”骨架（change feed 是必需的：主人编辑不写 consolidation_changes 表，没有触发器就没有变更来源）。
2. **砍掉 decision_ledger 重建**：`reason_code` 是 1-64 自由文字（0087:35），重检结果写 `reason_code = 'review_suspended'/'parameters_changed'`，`outcome` 保持 `needs_review`，规则状态事实已在 `rule_book_history.change_reason`。这次重建是 decision_ledger 第三次重建（0087、0089 之后），风险最大、收益最小。
3. suspended 必须带主动通知（复用 proactive push），并同步改 ADR 0211/0219 的相关表述。
4. expand 去掉“truncated 下次继续”的假承诺，截断即终点并在列表显示。
5. 第 7 节补：挂载点接线、每消费点一条反向用例、列表与命令、重试上限；新增后台调用的确定性用例（同输入两次请求逐字节相同、固定部分在前——注意 `docs/kv-cache-guide.md:70` 记录后台调用顺序“没有统一检查”）。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。对话请求的组装一行没动；待重审记忆照常展示（记忆本就按规则在最后一条用户消息里，如 `MEMORY_DATE_*` 均为 `layer: "last-user-message"`，`packages/prompt-catalog/src/memory.ts:128`）；suspended 只影响邮件检查执行、`rule_book` 工具结果（每次调用新追加的工具结果，不是改历史）。新模型调用只有 rule-review 后台调用，固定指令在前、数据在后、无时间字段，符合规则第 15 条。结论：仍是只追加，每轮会变的值都在最后一条消息里。
2. **同一段文字会不会变字节？** 重检请求不含时间/修订号/编号（好）；数据部分经 `parseMailMatch` 规范化（排序、去重、键序固定），确定性成立。遗留两点：多条合并一次请求时排列顺序要写死；记忆正文若带敏感值会经出口遮盖，遮盖本身是确定的（规则第 11 条）。
3. **有没有自动检查、反向用例会不会真失败？** 服务层语义有计划且合理；缺口是接线层（挂载点）、策略层（重试/节流）、消费端（列表/命令/显示/枚举）都没有，且“让 suspended 照常执行”必须按消费点拆成多条，否则改漏一处照样全绿。
4. **每个新值两端核对了吗？** `suspended`（规则状态）：方案列了大部分消费点，漏 `reconfirm`/设置保存路径（第 3 条，会出 `enforced:true` 假象）和 ADR 文档。`suspended`（决策 outcome）：漏应用层端口 `DECISION_OUTCOMES`（第 1 条，运行时必炸）。`rule-review` purpose：两端都核了（0068 CHECK 有约束，需重建；`modelUsagePurpose` 有回退 "other" 兜底）。`memory_review_items`：缺 FK 定义。`memoryReview.expand` 持久层新操作：需照 `readDerived` 本次提交的做法在 `durable-adapters.ts:939` 和端口同步登记，方案未提。
