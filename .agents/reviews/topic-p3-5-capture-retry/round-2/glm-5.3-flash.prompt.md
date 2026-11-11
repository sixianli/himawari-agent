你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 aa1b0b0b551f5d7843ac0f7120f649f74bf12e5f。
待审核的方案：
# P3-5 线程方案 v2（已吸收两个模型独立方案）

## 前提（来源 + 原话）
1. 抽取阶段失败只审计+日志：`apps/agent-service/src/production-memory-capture.ts:855-857` `} catch (error) { audit("extraction_failed"); throw error; }`；`start()` `.catch(this.options.onFailure)`（:677）。
2. 已有重试只认一个错误码：`apps/agent-service/src/production-model-composition.ts:633` `error.message !== "AI_GATEWAY_TOOL_CALL_UNSUPPORTED"`，标题/捕获/episode/整理共用。
3. 准入要当前运行的执行租约：`apps/agent-service/src/production-run-composition.ts:197` `if (... || !scope.executionLease) return undefined;`；同一 invocationId（logical slot）再次 begin 会被当成重放/冲突（`packages/application/src/services/model-invocation-admission-service.ts:425-446`，模型独立核对）。
4. **决策记录的 outcome 在数据库里也有 CHECK**：`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:48-55` `(kind = 'memory_candidate' AND outcome IN ('kept', 'discarded', 'pending_approval'))`。（v1 草稿和给 Andy 的第一条消息说“只在代码里校验、不用重建表”，是错的。）
5. 网页把不认识的 memory_candidate outcome 显示成“待批准”：`apps/control-center/src/components/proactive-reminders.tsx:331-336`；校准分组 `packages/calibration/src/index.ts:263` 只认 discarded，其余落 memory_pending。
6. 记忆 id、generationId 由原 runId 确定性派生：`production-memory-capture.ts:784` `createMemoryGenerationId(\`memory-capture:${runId}\`)`。
7. 迁移号：协调者转告 0087 给 P2-2（PR 366 未合）、0088/0089 预留给 P2-3/P2-5（未核实到文件，开工前看 main）。

## 对标与根因
- ChatGPT/Claude：记忆写入是后台步骤，失败对用户不可见，用户只看到“已更新记忆”或什么都没有；业界后台任务通用“有限次重试 + 持久化队列 + 超限死信”（Sidekiq retry/dead set、AWS SQS DLQ）。
- 根因修补：现在失败后直接丢弃，本块让失败可重试、可补做、可见。I-63 的根因（模型回工具调用）不在本块，它的门槛仍缺。

## 做法
### A. 同轮重试一次
- `#capture` 的抽取阶段（generate + parse）最多跑 2 次；**复用同一份提示词字节和遮盖表**，只换 invocationId（`memory-capture:<runId>` → `memory-capture:<runId>:retry`）。
- 不重试：`*_DISCLOSURE_DENIED`、`*_ADMISSION_UNAVAILABLE`、`*_MODEL_UNAVAILABLE`、失去执行权（assertActive）、主人暂停。其余（含 RESPONSE_INVALID、RESPONSE_INCOMPLETE、TOOL_CALL_UNSUPPORTED、PORT_CONFLICT、超时）都重试。重试前再 assertActive。
- `generateText` 加选项关掉内层 I-63 重试，记忆捕获用它，避免一轮最多 4 次调用；标题/episode/整理不变。

### B. 再失败 → 持久化待补队列
- 新表 `memory_capture_backlog`：主键 generation_id（`memory-capture:<原 runId>`，天然幂等）；owner/agent/thread、source_run_id、source_message_id（外键 thread_messages ON DELETE CASCADE，删消息/删对话即消失）、attempts、last_error_code、created_at、updated_at。不存提示词、不存原文。
- 迁移号按 P2-2 合并后的 main 取号；同一迁移里重建 decision_ledger 加新 outcome（见 C），照 0069 的做法处理引用它的子表，迁移契约测试查 foreign_key_check、行数和评分不丢。

### C. 决策记录（每次失败一条）
- kind `memory_candidate`，新 outcome `capture_failed`（代码 `DECISION_OUTCOMES` + 数据库 CHECK 同改）。reasonCode = 这次失败后的去向：`retrying`（同轮还会重试）、`queued`（已进待补队列）、`gave_up`（补做第 3 次仍失败或不可重试错误）、`source_gone`（补做时原消息已删）。subjectRef = generationId；inputs.memoryIds/ruleIds 空（不沿用把 reasonCode 塞进 ruleIds 的旧写法，和 P2-7 方向一致）；错误码进审计和日志。id 由 `generationId + 第几次尝试` 确定性派生。
- 成功（同轮重试成功或补做成功）照常写 kept/discarded/pending_approval 记录。
- 网页：`capture_failed` 显示新标签“这轮没记成”（三种语言），可评“useful / unneeded / missed”中合适的；每日评价、校准分组加 `memory_capture_failed` 组；gateway 契约同步。

### D. 下一轮补做
- `start()` 本轮捕获拿到准入后，取本 owner/agent 最旧的一条待补项补做（**每轮最多 1 条**，不限线程：记忆是主人级的，只按线程补会让不再继续的对话永远补不上）。
- 用**本轮**请求的 runId/租约准入，invocationId `memory-capture:<本轮 runId>:backlog`；用原 runId 读来源，generationId 不变（记忆 id 不变，不会重复）。按当前记忆状态重建提示词（列表排序已固定）。
- 补做不再同轮二次重试。成功 → 删行；原消息/对话不在 → 删行 + `source_gone`；主人暂停 → 跳过、保留；失败 → attempts+1 + 记录 `queued`；第 3 次补做失败 → 删行 + `gave_up`。

### E. 测试（`[P3-5]`，进自动检查）
- 集成测试 `test/integration/production-memory-capture.test.ts`：首次失败重试成功（记忆在、1 条 capture_failed/retrying）；首次 JSON 不合法重试成功；两次失败 → 入队 + capture_failed/queued，下一轮补做成功（记忆 id 不变、行删除）；补做 3 次失败 → gave_up；DISCLOSURE_DENIED 不重试直接 gave_up；暂停时不补做；删消息后行级联消失；补做与本轮 invocationId 不同。
- 迁移契约测试；网页标签测试；校准分组测试。
- 新增 `check:memory-capture-retry` 加进 `npm run check`（现在 `npm run check` 不跑集成测试）。
- 不改提示词文字、系统提示、敏感规则；补做走同一个 generateText 出口。

## 需要 Andy 定的
1. 为了让“失败”在决策记录里有自己的名字，要重建 decision_ledger（新 outcome）。替代：沿用 discarded + reasonCode，零迁移，但网页会显示成“已跳过记忆”，重试成功的那轮也会出现一条“已跳过”，会误导。推荐重建。
2. 上限：同轮 1 次重试；每轮补 1 条；每条最多补 3 次。
