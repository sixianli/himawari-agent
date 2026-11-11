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
# P4-5 用真实数据建评测集：问题、目标、约束和已核对的事实

列出的任何做法只是参考，不要局限于这几个，请从问题本身出发，提出你认为更好的方案。

## 问题

Himawari（Andy 的个人 Agent，仓库 sixianli/himawari-agent）现有四个评测集全是人工编的合成数据：

- `evals/memory-retrieval/dataset.json`（文件自述“合成数据，不含 Andy 的真实记忆”），由 `scripts/memory-retrieval-eval/live.mjs` 跑，结果追加到 `evals/memory-retrieval/history.jsonl`。
- `evals/memory-capture/`（捕获评测，`scripts/evals/memory-capture-live.eval.ts`）。
- `test/integration/memory-evaluation.test.ts`（记忆评测）。
- `evals/jarvis-test/`（Jarvis 测试，`scripts/jarvis-test/live.mjs`，真模型层要先报费用、`--confirm-cost`）。

论文 ProAgentBench 的结论是：合成数据和真实数据上得出的结论可能相反。记忆对错无法和对照组（Meta 的 Muse）比较，因为两边记的事不同，所以要自己量。

## 目标（验收标准，不能改）

从 Andy 的对话和邮件原文自动出题、自动判分，构造两个真实评测集：

1. 记忆回忆测试：从**已确认**的记忆和它们的原话里出“关于 Andy 过去事实或偏好”的问题，标准答案就是原话；让 Himawari 作答后自动判对错。
2. 主动决策评测：从决策记录里 Andy 已评价的三类决策抽样。这一半要等决策记录里有足够评价。

另外：替换现有合成评测集的地位并重新记录基线；跑一次 LongMemEval 做行业对照。

做到什么算完：新评测集可复现、每周自动更新；旧合成集保留为对照；LongMemEval 分数写进文档。

## 约束

- 抽样要脱敏，用统一出口那套遮盖（`ModelEgress`，`packages/application/src/services/model-egress.ts`，用 `@himawari-agent/sensitive-capture` 的 `redactForEgress`）。
- 出题只用已确认的记忆和原话，不用待确认的。
- 出题和判分的模型调用走统一出口，提示词登记进提示词目录（`packages/prompt-catalog`，有 `prompt-manifest.json`）。
- 发给模型的内容只能往后追加，固定内容在前、会变的在后（`.claude/rules/prompt-prefix.md`），后台调用同样适用。
- 新加的测试要进仓库自动检查（`npm run check` / 测试层）。
- 花钱超过 0.5 美元先问 Andy；禁止经按 token 付费渠道调用 Claude/OpenAI 同价位模型；生产模型调用经 Magpie，先用套餐额度。LongMemEval 官方判分用 GPT-4o，本项目不能用。
- 真实数据在生产机上，ssh 只能由 Andy 本人执行；抽样结果要先给 Andy 确认。
- Himawari 是给别人用的产品，用户不会用编程工具；但这个评测集是开发侧质量度量。
- 不写死，能动态获取的一律动态。不写代码注释。

## 已核对的事实（main aa1b0b0）

- 记忆表 `memory_records`：`status`（active/archived/trashed/…）、`tentative`（0/1，迁移 0052 起）、`category`、`stance`、`classification`（public/private/sensitive/restricted）、`content_ref` 指向加密 payload。
- 原话：记忆历史事件带 `quoteRef`；`apps/agent-service/src/production-memory-consolidation.ts:10` 的 `quoteRefOfMemory` 取最早一条原话；`apps/agent-service/src/service-main.ts:1461` 的 `readQuote` 用 `episodeProtector.unprotect` 解密。即记忆正文和原话在生产上加密，只有生产服务进程能解开。
- 决策记录 `decision_ledger`（迁移 `0069_decision_ledger.sql`）：`kind` ∈ proactive / memory_candidate / consolidation / context_truncation / retrieval_degrade / external_read；`owner_rating` ∈ useful / unneeded / missed；`inputs` JSON、`reason_ref`/`content_ref` 加密 payload。`packages/calibration/src/index.ts` 已按组算比例和 Wilson 区间（校准周报）。另有 `decision_signals`（opened/undone/replied）。
- 生产服务有后台运行（`apps/agent-service/src/production-background-runs.ts`）和记忆检索（`DurableMemoryService.search`、`HybridMemoryProvider.search`）。
- 并行线程：P3-1 在换本机向量模型（会改 `scripts/memory-retrieval-eval/live.mjs`、`test/integration/memory-retrieval-eval/live.test.ts`、`packages/memory-engine/src/embedding.ts`、向量维度）；P3-3 在改检索融合（`packages/memory-engine/src/fusion.ts`、`hybrid-memory-provider.ts`、`durable-memory-service.ts` 的 search 加可选参数）。两者都只追加 `history.jsonl`，不动 `dataset.json`。
- LongMemEval（https://github.com/xiaowu0162/LongMemEval ，MIT）：oracle / S / M 三档各 500 题；S 每题历史约 11.5 万 token（约 40 段会话）；题型含单会话、多会话、时间推理、知识更新、拒答（`_abs`）；官方判分 `src/evaluation/evaluate_qa.py` 用 GPT-4o。

## 请你回答

- 数据集放在哪、怎样做到可复现（真实数据不宜进仓库）；每周自动更新由谁触发、在哪跑。
- “Himawari 作答”应走哪条路径（完整对话运行，还是检索加作答），各自代价。
- 出题和判分怎样防止题目泄露答案、怎样判“对”（原话是标准答案，但回答不会逐字一致）；怎样处理已被取代或已过期的记忆。
- 主动决策评测怎样从已评价决策构造、样本少时怎么办。
- LongMemEval 跑哪一档、怎样控制费用、判分模型不同时怎样说明可比性。
- 每周费用估算方法。
