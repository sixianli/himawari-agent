你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 980322bc5a658b89be4964b70c02ea1300e51b31。
问题、目标和约束：
# P4-1 记忆纠正传播：问题、目标、约束、已核对的事实

## 问题

Himawari 是一个个人 Agent，有长期记忆和由程序执行的硬规则（规则手册）。主人改一条记忆后，由它推出的记忆和由它派生的硬规则可能不再成立，但现在系统不会跟着处理。

## 目标（主人原文，不能改）

- 记忆被编辑、取代或删除时，沿完整依据链找出所有由它推出的记忆，沿规则对应关系找出所有由它派生的硬规则，都标为「待重审」。
- 生成一份待确认列表（能自动改的给建议值，拿不准的只列出）。
- 待重审的硬规则自动重新检验；不通过的挂起（不执行）并留一条决策记录，通过的自动解除待重审。
- 做到什么算完：三层推论链（A 推出 B，B 推出 C）上游改动后，下游全部进入待重审；无关记忆不受影响；改动上游事实后相关硬规则检验失败并挂起（要有自动测试）。
- 只标待重审和检验，不自动改记忆正文。

## 主人已经定的事

- 2026-11-11 主人选定“重新检验”的方式：规则的来源记忆被改后，用和立规则时同样的说明，请便宜模型（DeepSeek V4.1 Flash）把改后的原话重新译成规则（类型、参数、是否仍是长期规则），再由程序逐项和现有规则比较：相同就自动恢复；类型或参数变了就挂起，并在待确认列表给出新参数作建议值，主人点头后按新参数生效；改成“不用了”就挂起等主人确认；模型调用失败就保持待重审、照常执行、只列出。
- 放弃的方式：“检查规则参数是否仍出现在记忆正文里”——规则参数是模型从原话扩写的变体（例如 isa.go.jp、出入国在留管理庁），本来就不在原话里，会误挂起；“重跑规则自带的正反例”——正反例是程序按参数生成的，与记忆正文无关，永远通过。

## 约束（仓库规则）

- 发给模型的请求必须走仓库统一的出口；新加或改动的提示词必须登记进 `packages/prompt-catalog`；系统提示按对话冻结，会变的值只能放最后一条用户消息里（`.claude/rules/prompt-prefix.md`）；后台调用固定的在前、会变的在后。
- 识别敏感内容的规则只能写在专门的包里。
- 不写代码注释。新测试要进 `npm run check`。
- 改表结构要排队（同一时间只允许一个改表的任务），迁移号连续。
- 花钱超过 0.5 美元先问主人；按 token 付费只能用 DeepSeek V4.1 Flash 这类低价模型。
- 产品原则顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`）。尽量不让主人人工介入。
- 每个用户一套独立实例；用户不会写代码。

## 已核对的事实（请自己读代码核实）

1. 依据链：`docs/adr/0194-record-the-whole-basis-chain-of-a-memory-tidy-up.md`；表 `memory_consolidation_change_basis`（迁移 0084）按记忆编号有索引；`packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts` 的 `readBasisChain` 只往上游走。整理动作有 merge、supersede、archive、reflect、hold（迁移 0089），只有 reflect 产生新记忆（`packages/memory-engine/src/consolidation.ts`）。
2. 规则与记忆的对应：`docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md`；`rule_book_rules.source_memory_id`；迁移 0087 的触发器 `memory_rule_needs_review` 只在“规则类记忆本身”被改、取代、移除、改分类时把规则标 `needs_review`（照常执行），写历史和 `rule_review` 决策记录（结果值数据库约束只有 `needs_review`）。
3. 主人规则：`docs/adr/0213-*.md`；`apps/agent-service/src/production-owner-rules.ts`；规则类型注册表 `packages/application/src/rules/rule-types.ts`；`rule_set` 工具描述在 `packages/prompt-catalog/src/tools.ts`；规则来源记忆是 rule_set 直接写的主人原话（`memory:rule:<key>`），不是整理推出的。
4. 规则状态数据库约束：`rule_book_rules.status IN ('active','needs_review','retired')`；`ruleIsEnforced` 在 `packages/application/src/rules/rule-book.ts`。
5. 记忆历史表 `memory_history_events`（迁移 0065）。
6. 后台模型调用的现有出口：`apps/agent-service/src/production-run-composition.ts` 的 `auxiliaryMemoryGeneration`，记忆整理（`apps/agent-service/src/production-memory-consolidation.ts`）在对话运行开始时顺带触发，每小时最多一次。
7. 决策记录：`docs/adr/0143-decision-ledger-for-model-gate-decisions.md`，`packages/application/src/ports/decision-ledger.ts`。

## 请回答

请从问题本身出发给出你的完整方案：数据怎么存、何时标记、怎么往下游找、检验怎么跑和何时跑、挂起与恢复、待确认列表、决策记录、测试怎么证明“做到什么算完”，以及你看到的风险和边界情况。
