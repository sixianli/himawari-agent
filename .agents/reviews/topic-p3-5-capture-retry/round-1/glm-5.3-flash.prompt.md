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
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
问题、目标和约束：
# P3-5 记忆捕获失败后重试和补做：问题、目标、约束、已核对的事实

## 问题
Himawari 每轮对话后，会用一次辅助模型调用从主人（Andy）的话里抽取记忆候选（下称“记忆捕获”）。这次调用失败时，这一轮的记忆就丢了：只写一行服务日志和一条审计，不再处理。

## 目标（验收标准，不能改）
- 捕获的模型调用失败时同轮重试一次；首次失败、重试成功时，这轮记忆照常保存。
- 重试也失败，就把这轮放进待补队列，下一次运行（下一轮对话）时补做。
- 两种情况都留决策记录（`decision_ledger` 表，主人可在网页一键评价的那张表），现在只写审计不写决策记录。
- 以上都要有测试，并进 `npm run check` / 测试套件。

## 约束
- 发给模型的请求必须走仓库统一的出口（`generateText`，`apps/agent-service/src/production-model-composition.ts`）。
- 新加或改动的提示词要登记进 `packages/prompt-catalog`；系统提示按对话冻结，会变的值只放最后一条用户消息（`.claude/rules/prompt-prefix.md`）。
- 识别敏感内容的规则只能写在 `packages/sensitive-capture`。
- 改表结构要新迁移；迁移号由别的线程占用到 0089，开工前按 main 最新取号；同一时间只允许一个改表结构的块进行。
- 不需要兼容旧数据（Andy 11-09 定）。不许写死能动态获取的值。
- 花钱敏感：重试会多花模型调用费用。
- 模型调用必须在一个活着的运行里经准入（admission，`ModelInvocationAdmissionService`，需要当前运行的执行租约 `executionLease`），已结束的运行不能再申请准入。

## 已核对的事实（main aa1b0b0）
- 捕获入口：`apps/agent-service/src/production-memory-capture.ts` 的 `ProductionMemoryCapture.start()`（约 662 行），在本轮第一条助手消息出现时由 `production-titled-runtime.ts` 调用；`#capture()` 里 `try { assertActive; 组提示词; externalTag; generate; parseMemoryCandidates }`（约 819–857 行），catch 里 `audit("extraction_failed")` 后重新抛出；`start()` 用 `.catch(onFailure)` 吞掉，`onFailure` 只写日志 `memory-capture.failed`（`service-main.ts` 约 2003 行）。
- 之后 `AutomaticMemoryService.processCommittedRun` 写记忆，记忆 id 是确定的 `memory:${generationId}:${ordinal}`，`generationId = memory-capture:${runId}`。
- 已有一层重试：`production-model-composition.ts` 约 624–638 行 `generateText` 只在错误信息等于 `AI_GATEWAY_TOOL_CALL_UNSUPPORTED` 时重调一次（事故 I-63 的缓解，标题、记忆捕获、episode、整理共用）。
- 生产里见过的捕获失败码：`AI_GATEWAY_TOOL_CALL_UNSUPPORTED`（I-63）、`MEMORY_CAPTURE_RESPONSE_INVALID`（输出 JSON 解析失败，parse 在 245/291/293 行抛）、`PORT_CONFLICT`（10-30，发生在抽取阶段，确切位置未查）。其他可能：`MEMORY_CAPTURE_RESPONSE_INCOMPLETE`、`MEMORY_CAPTURE_DISCLOSURE_DENIED`（模型不允许该数据分级，重试无用）、`MEMORY_CAPTURE_ADMISSION_UNAVAILABLE`、运行失去执行权（`assertActive` 抛）。
- 决策记录：`packages/application/src/ports/decision-ledger.ts`，kind 有 `memory_candidate` 等六种，数据库 `0069_decision_ledger.sql` 对 kind 有 CHECK（新增 kind 要重建表）；outcome 只在代码里校验（`DECISION_OUTCOMES`），`memory_candidate` 现在是 kept/discarded/pending_approval。网页 `apps/control-center/src/components/proactive-reminders.tsx` 约 331 行把不认识的 memory_candidate outcome 显示成“待批准”。另一个线程（P2-7）计划让 `inputs.ruleIds` 只指向真实规则。
- 主人可以暂停自动记忆（`capturePaused`），捕获开头会检查。
