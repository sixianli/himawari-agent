你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 dd7dea4d4ace674c3ddaba1fa37e5bd540eb9220。
对比基准是 01873f5c26c536750090ffbc3772ee0cc95bf3fc，先运行 git diff 01873f5c26c536750090ffbc3772ee0cc95bf3fc..dd7dea4d4ace674c3ddaba1fa37e5bd540eb9220 看改动。
上一轮复核到 e7a5ebe5ce541250d0a214b6f2181ea225bd113b，先看 git diff e7a5ebe5ce541250d0a214b6f2181ea225bd113b..dd7dea4d4ace674c3ddaba1fa37e5bd540eb9220 的增量，但可以读任何文件。
作者的说法（可能有错，请核对）：
# PR 282 第 8 轮代码复核材料

## 这个 PR 在修什么

生产上一轮对话停在「结果未确认」，要等这一轮的原始期限（约 31 分钟）才收尾，停止按钮一直转。根因是三道互相等待的锁，这个 PR 修其中两道，加上同一类的「输出过多」，第三道（预算账户被记成 `reconcile_required`）另出方案。

## 这一轮（第 8 轮）要复核的改动

第 7 轮没有高危、没有中危，四条低严重度意见全部成立并改完，按 `--accept-low` 记进账本。之后 Andy 说「合并」，线程按规则先把 `origin/main` 合进分支，发现 main 在这期间多了八个已合并的 PR（#293、#297、#299、#302、#303、#305 等，`2995d535` → `01873f5c`），而仓库的规则是「合并 main 之后也要再复核」。Andy 说「再跑一轮，跑完之后直接合并」，这就是这一轮。

所以**这一轮的增量只有两件事**：

1. `43416c71`：只改 `.agents/reviews/pr-282/usage.jsonl` 一行，记下第 7 轮四条低危的 `low-fix`。
2. `dd7dea4d`：把 `origin/main`（`01873f5c`）合进分支的合并提交。只有一个文件冲突：`docs/incidents-and-gates.md` 的事故表。线程的解法是三行并存——本 PR 的 I-84 行接在 I-83 之后，main 新来的 I-89、I-86 两行按 main 里的顺序排在它后面，没有改动任何一行的内容。

本 PR 自己的代码和测试改动在第 1 到第 7 轮都已复核过（最后一次复核的提交是 `e7a5ebe5`），这一轮不需要重看，除非它和 main 带进来的改动有冲突。

## 本 PR 改过的东西（供判断有没有和 main 撞上）

- `apps/execution-worker/src/production-sandbox-execution-v2.ts`：资源上限和输出上限一律记成明确失败（`kind: "error"` 加原因码），并且「上限越过」优先于 `knownExit`，上限越过时副作用一律 `{ kind: "unknown", reasonCode }`。
- `packages/execution-contracts`：新增 `SANDBOX_OUTPUT_LIMIT`、`isSandboxOutputLimitReason`、`isSandboxCeilingExceededReason`，这个码加进 `isSandboxBoundedToolFailure`。
- `apps/agent-service/src/production-sandbox-tool-result.ts`：`sandboxCeilingExceededMessage`（原名 `sandboxResourceLimitMessage`）给模型的上限说明，数值从本次生效的上限读，不写死；不再声称命令被终止。
- `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts` 和 `apps/agent-service/src/production-tool-result-recovery.ts`：结果永远找不回的轮次写 `sandbox-tool-result-unrecoverable:<invocationId>` 痕迹记录，候选判定排除带着这条记录的执行。
- 两份 `SAFE_TOOL_REASON_CODES`（`packages/application/src/services/thread-execution-projection.ts` 和 `thread-execution-state.ts`）各加三个资源上限码和一个输出上限码；`test/tooling/safe-tool-reason-codes.test.mjs` 核对两份一致。
- `apps/control-center/src/i18n/resources/{zh-CN,en,ja}.ts`：四个上限原因词的三语文案。

## main 这次带进来的、和上面有重叠的部分

线程已经看过，列出来供复核判断：

- `packages/application/src/services/thread-execution-projection.ts`：main 也改过（执行实时流相关），`git merge` 自动合上了。
- `apps/agent-service/test/production-runtime-tools.unit.test.ts`：main 也改过，自动合上了。
- `apps/control-center/src/i18n/resources/{zh-CN,en,ja}.ts` 和 `message-ids.ts`：main 新增了别的消息 id（记忆页、周报），自动合上了。
- `packages/execution-contracts/src/index.ts` 和新增的 `sandbox-memory-limit.ts`：main 把工具命令的内存上限从 256 MiB 提到 1 GiB（PR #302），这和本 PR 的「内存上限越界要记成明确失败」是同一块逻辑的两端。
- `apps/agent-service/src/production-run-composition.ts`、`service-main.ts`、`apps/execution-worker/src/production-worker-composition.ts`：main 改过装配，自动合上了。
- `scripts/model-review/opencode-review.mjs`：main 改了复核脚本本身（加了 `low-fix` 之外的东西），不影响产品代码。

## 这一轮请重点看

1. 合并本身有没有把任何一边的改动弄丢或弄错：尤其 `thread-execution-projection.ts` 的 `SAFE_TOOL_REASON_CODES`、三语文案文件、`production-runtime-tools.unit.test.ts` 这几个两边都改过的文件。
2. main 把内存上限提到 1 GiB（`packages/execution-contracts/src/sandbox-memory-limit.ts` 和签名清单）之后，本 PR 读「本次生效的上限」给模型报数、以及资源上限原因码的选取，还对不对。
3. 事故表的冲突解法：I-84、I-89、I-86 三行并存，有没有行数、列数、锚点或 `npm run check:incident-gates` 会挑出来的问题；三行的内容有没有互相矛盾的说法。
4. 合并之后，本 PR 的门槛是否仍然真的挡得住它要挡的东西：有没有哪条用例因为 main 的改动变成永真或永假。
5. 整个合并结果里，还有没有「测试绿了但生产写不进去」或者「说明和实际行为不一致」这一类两端不一致的地方。

## 已跑过的验证（供参考，不必重复）

合并之后线程跑过：`apps/control-center/test`、`apps/agent-service/test`、`test/integration/sandbox-v2-worker-lifecycle.test.ts`、`test/integration/sqlite-sandbox-execution-v2.test.ts`、`test/integration/sandbox-execution-v2.test.ts`、`packages/execution-contracts/test`、`packages/application/test`、`test/tooling/safe-tool-reason-codes.test.mjs`，共 162 个文件 3051 条全过；`npm run lint`、`typecheck`、`check:boundaries`、`check:incident-gates`、`check:glossary`、`check:instruction-links`、`check:prompt-prefix` 全过；`validate_docs.py . --strict` 仍是 main 上原有的 11 条错误，没有新增。
