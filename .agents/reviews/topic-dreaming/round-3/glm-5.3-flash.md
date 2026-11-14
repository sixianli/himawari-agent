我先看仓库结构和方案引用的关键文件。
# 审核结论：线程方案 v2（每天回看）

## 证实的（按严重度从高到低）

### 高-1　`add` 走整理账本时 basis 无处安放——落库校验会拒绝（I-73 同型问题）
方案说「每条改动复用现有动作：新建用 reflect……契约、导出、页面都不用改」，只核对了 CHECK（0054_memory_consolidation.sql:26 确实允许 `reflect`），没核对账本写入端的校验：整理账本要求 `basisMemoryIds` 非空且**全部是 memory_records 里属于该 owner/agent 的记忆**，否则报 `PORT_INVALID_OPERATION "Memory consolidation basis is not in the change scope"`（packages/persistence-sqlite/src/sqlite-memory-consolidation-operations.ts:44-60）。回看的证据是**对话原话**，不是记忆记录：`update` 有旧记忆可当 basis，`add` 没有。照方案实现，要么落库直接失败，要么被迫把新记忆自己当 basis（语义错、依据链错，readBasisChain 会把新记忆标成自己的依据）。这正是 I-73 的教训：产出的值要送进下游校验器过一遍。
**建议**：二选一并写进方案——(a) `add` 不进整理账本，走 memory-capture 的 createProposal 路径，把消息序列放进 `sourceRefs`；(b) 保留 `reflect` 但在方案里明确 basis 记什么，并给 `insertConsolidationWrite` 的校验补反向用例。

### 高-2　「失败 1 小时后可重试」「重试时复用模型输出」与现有 run 生命周期冲突
- `begin` 是 `ON CONFLICT (owner_id, agent_id, day) DO NOTHING`，返回 `changes === 1` 才继续（sqlite-memory-consolidation-operations.ts:172-186；consolidation.ts:209-225 得 false 即静默返回 null）。
- `finish` 失败时**只有 changeCount === 0 才删行**，写过改动的失败 run 永远留在那里（:215-227）。
所以「失败后重试」只在「还没写任何改动就失败」时成立；回看一旦写过几条再失败，当天就再也进不去。另外「模型输出按运行编号存一份」没有落点：方案同时承诺「不加表、不加列」，只能进 payload store（有先例 `consolidationPayloads.put`，service-main.ts:1487-1488），方案没写。
**建议**：明确复用输出的存储位置（payload ref，如 `memory-consolidation-output:<runId>`）；重试语义要么改 `begin`/`finish` 允许重开 failed run（要加用例），要么如实写「写过改动后失败则当天不重试，明天窗口照常」。

### 高-3　回看查重看不见 tentative，会反复补记
相关旧记忆用检索取得，而 `DurableMemoryService.search` 的 `includeTentative` 缺省 false（packages/application/src/services/durable-memory-service.ts:415、427）——方案自己「没采纳的」一节也承认「待确认的记忆模型看不到」。于是「add 先查重，重复就跳过」查不到已有 tentative 条目：同一归纳第二天可能再存一条；昨天回看存的 tentative 今天也看不见。现有整理不需要面对这个问题（它比的是记忆互相之间，且跳过 tentative，consolidation.ts:242），回看是「对话 vs 记忆」，躲不开。
**建议**：回看检索显式 `includeTentative: true`（仅用于查重与「两条不一样」判断，不作为证据），并在硬规则里写明 tentative 条目参与比对。

### 中-1　`brief-plan.md` 不存在
方案开头引用它（含对它的「更正」），仓库 checkout 6d70648 里没有这个文件（read/glob 均找不到）。审核依据缺失，方案的「问题、约束、现状、业界资料」无法核对。
**建议**：把 brief-plan.md 提交进仓库，或把其中约束并入本文档。

### 中-2　对 P3-8 / P4-6 的依赖在仓库中不可核实
全仓 grep 只有 ADR 0219 提到 P3-6、P5-1（docs/adr/0219-read-only-mcp-entry-with-static-token.md:28）；P3-5、P3-8、P4-6 及其「取代规则」「周清单」「置信度门槛 850」都不在仓库里。「等 P3-8 合并后再动工」是必要前提但不充分：若 P3-8 的规则变了，本文档没有守。**建议**：把 850、绝对日期、更晚三个条件直接写进本文档并加测试，P3-8 只作为共享函数的出处引用。

### 中-3　检索分数若进提示词，字节不保证确定
方案说按 `(分数, id)` 稳定排序——这只保证并列时顺序稳定，不保证分数本身跨请求相同（分数来自向量服务，见 episodes.ts:219-252 的 RRF 和 durable-memory-service.ts:456-458 的排序）。计划中的「同一窗口两次运行提示词逐字节相同」测试能抓到，但 SQLite 桩测不出，要在真 embedding 服务上跑。**建议**：分数不进提示词字节，只写排序后的「日期、编号、文本」。

### 低-1　「水位用 lastCompleted 的 startedAt」舍近求远
`finish` 完成时已把 `reviewedThrough = startedAt` 写进 run 行（consolidation.ts:371），语义就是「已整理到哪」。直接用 `reviewedThrough`，别再从 lastCompleted 绕。

### 低-2　评测集没有落点，必答 3 打折
仓库现有评测只有静态数据集（evals/memory-capture、evals/memory-retrieval），没有「多轮对话→调模型→断言」的 harness（未核实是否有仓库外脚本）。20 条评测集若不进 `npm run check`/CI，就退化为一次性手工验证。**建议**：先用模型桩把硬规则的反向用例做成可运行测试进 check，真模型评测另行跑并记费用。

## 推测

- hold 路径的终点：主人再说一次只走 `confirm()` 清 tentative（durable-memory-service.ts:304-324），**不会**自动 supersede 旧条——「两条说法不一样」的旧条会一直 active 且被模型使用。方案交给 P4-6 可以接受，但验收应加一条反向用例确认这是接受的。
- 主人几天不说话时窗口积压：有 20 段上限兜住，可接受，但验收没这条用例。

## 侧重检查

走的流程（主人发消息 → 当天第一轮触发整理 → 现有整理 → 回看 → 落库 → 记忆页展示/撤销）中，方案未提且无测试覆盖的路径：
1. `insertConsolidationWrite` 的 basis scope 校验失败路径（高-1）；
2. 同日失败重试被 `begin` 冲突挡住（高-2）；
3. tentative 查重盲区（高-3）；
4. 回看写的 quoteRef 若 payload 缺失，`quoteRefOfMemory`（production-memory-consolidation.ts:10-27）与记忆页依据链的表现；
5. 评测 harness 本身（低-2）。

文档与代码一致性：方案对现状的三处引用全部核实无误——摘要 1200 字符上限（episodes.ts:25）与提示词 300 字（packages/prompt-catalog/src/memory.ts:56,61）；重叠门槛 0.5（consolidation.ts:38、317）；RETRY_AFTER_MS 1 小时（production-memory-consolidation.ts:8）。`brief-plan.md` 缺失是唯一文档问题。

## 必答问题

1. **不会改变已见请求开头。**回看是独立一次性后台调用，不碰主对话的系统提示、工具定义、历史、遮盖；它产出的记忆只影响之后各轮「每轮选中的记忆」，而那按规则放在最后一条用户消息。回看提示词顺序「固定指令→旧记忆→原话→当地日期」符合规则第 15 条（固定在前、会变的在后，.claude/rules/prompt-prefix.md:67）。合规。
2. **基本不会，一处要补。**原话、日期、编号都是库内确定值；遮盖走现有 placeholderTable + 构建内固定的 TRUSTED_PROMPT_TEXTS，同进程重试字节相同。例外是检索分数（中-3）：不要把分数写进提示词。
3. **部分有。**有评测集和字节测试的计划，方向对；但评测集没有可运行的 harness/门槛落点，落库端校验（basis scope、begin 冲突）没有反向用例，「去掉防护就失败」需对每条硬规则各写一条并进 `npm run check`。
4. **逐个核对：**action（reflect/supersede）CHECK 与 undo 分支都接受（0054:26、consolidation.ts:411-418），但 add 的 basis 过不了账本校验（高-1）；新记忆 id 沿用 `${consolidationId}:...` 格式可过 createMemoryId（identifiers.ts:109-111），具体格式方案没写；真实 generation 走 `generations.request` 与 capture 一致（production-memory-capture.ts:884），undo 读路径经 `jobs.listByMemory` 能找到（service-main.ts:1454）；quoteRef 有读取方和 put 先例，可行；置信度门槛 850 挂在 P3-8 上，**未核实**；tentative 两端一致地不可见——但这让查重失效（高-3）。

## 如果由我来定

方案主体（每天一次、原话为证据、模型只给候选、复用动作和撤销账本）方向正确，保留。动工前先补：① add 的落库路径（进 capture 的 createProposal 走 sourceRefs，或给账本校验开特例+用例）；② 重试与输出复用的存储落点和 run 状态机改法；③ 检索显式含 tentative 用于查重；④ 水位直接用 `reviewedThrough`；⑤ 分数不进提示词；⑥ 把 850 等参数写进本文档并用模型桩把硬规则反向用例做成 check 门槛；⑦ 提交 brief-plan.md。然后再动工。
