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
仓库就是当前目录，已检出 8855e042ce27b81107c99e9e585f231338e12165。
对比基准是 8dfd31e5611dceb4d0388265ed05dfc9e8acbff0，先运行 git diff 8dfd31e5611dceb4d0388265ed05dfc9e8acbff0..8855e042ce27b81107c99e9e585f231338e12165 看改动。
作者的说法（可能有错，请核对）：
# PR 312 代码复核材料（第 1 轮）

## 这个 PR 做什么

PR 282 修完生产事故 I-84（一轮工具调用停在「结果未确认」，要等到原始期限才收尾）之后，复核里留下几条「可以更好」的意见。Andy 问「这几个建议采纳哪些」，确认后做了三条改动。本 PR 只有这三条，不改表结构，不动生产机。

改动范围：
- `apps/agent-service/src/production-sandbox-tool-result.ts`
- `apps/agent-service/src/production-run-composition.ts`
- `apps/agent-service/src/production-tool-result-recovery.ts`
- `packages/application/src/services/thread-execution-state.ts`
- `packages/application/src/services/thread-execution-projection.ts`
- 两个测试文件、删掉一个测试文件、改了 `docs/incidents-and-gates.md` 里 I-84 那一行

分支里还有两个提交和它们的 revert（`c0ec60d0`、`e9d91a87`、`8855e042`），那是一次已经撤回的格式化改动，净改动为零，不属于本 PR 要复核的内容。

## 三条改动各自的来由和已核对的事实

### 一、给模型看的字节上限换算方式

事实（已核对）：
- `packages/execution-contracts/src/sandbox-memory-limit.ts:1` 把沙箱内存上限写成 `1024 * 1024 * 1024`。
- `apps/agent-service/src/service-main.ts:166` 把输出上限写成 `48 * 1024`。
- 改动前 `apps/agent-service/src/production-sandbox-tool-result.ts` 的 `limitBytes` 按 `1_000_000` 和 `1_000` 换算，内存那一段另外写了一次 `/ 1_000_000`。
- `apps/control-center/src/delivered-files.ts:54-55` 给人看的文件大小按 `1024` 和 `1024 * 1024` 换算，单位写 `KB`、`MB`。

改动：`limitBytes` 改成按 1024 换算（单位名仍写 `KB`、`MB`），内存那一段改成调用 `limitBytes`。换算后同样的上限读作「内存 1024 MB」「输出 48 KB」。

### 二、工具失败原因白名单的两份拷贝

事实（已核对）：
- `packages/application/src/services/thread-execution-state.ts` 和 `thread-execution-projection.ts` 改动前各有一份内容完全相同的 `SAFE_TOOL_REASON_CODES`。
- 改动前由 `test/tooling/safe-tool-reason-codes.test.mjs` 保证两份一致：它用 `readFileSync` 读这两个源码文件，从 `const SAFE_TOOL_REASON_CODES = new Set([` 到 `]);` 之间按逗号切分取出字符串再比较。
- 投影那一侧改动前已经 `import { projectThreadExecutionState } from "./thread-execution-state.js"`。
- `packages/application/test/thread-execution-state.unit.test.ts` 有 `projects only allowlisted tool failure reasons`，断言白名单里的原因码能投影出来。

改动：把常量从 `thread-execution-state.ts` 导出，投影侧改成 import，删掉 `test/tooling/safe-tool-reason-codes.test.mjs`，并从 `docs/incidents-and-gates.md` 的 I-84 那一行去掉对这个已删文件的引用（`npm run check:incident-gates` 会拒绝引用不存在文件的已关闭行）。

### 三、`recordUnrecoverable` 这个开关

事实（已核对）：
- 改动前 `apps/agent-service/src/production-tool-result-recovery.ts` 返回的函数第二个参数是 `purpose?: { readonly recordUnrecoverable?: boolean }`，写「结果不可恢复」记录的那个 `if` 的第一个条件是 `purpose?.recordUnrecoverable !== false`。
- 全仓库只有一处传这个参数：`apps/agent-service/src/production-run-composition.ts` 的 `authorizeAuthorityChange`，传 `{ recordUnrecoverable: false }`。`apps/agent-service/src/production-run-dispatcher.ts:336` 那一处不传。
- 写记录的那个 `if` 还要求 `options.resultUnrecoverable` 存在。
- 这个开关没有任何测试覆盖；`docs/incidents-and-gates.md` 的 I-84 那一行在改动前写着「延续授权那条路「只判断不写记录」没有用例」。
- 同一个函数里，`options.recoverMissingResult`（恢复结果）在写记录的判断之前执行，并且写记录要求这条调用的 `facts.result` 的 `kind` 不是 `result` 也不是 `error`。
- `test/integration/sqlite-sandbox-execution-v2.test.ts` 的 `loss-unrecoverable` 断言这种轮次会写下恰好一条记录；同一文件的 `late` 走的是恢复成功、带着已知工具结果重新上场的那条路。
- 这个文件里的 `batch` 变体加进去的是纯本地探针工具，不进沙箱执行日志。

改动：`production-run-composition.ts` 另建一个不带 `resultUnrecoverable` 回调的恢复实例给 `authorizeAuthorityChange` 用，`createProductionToolResultRecovery` 的 `purpose` 参数和那个条件一起删除。

## 目标和约束

- 这三条改动都不应改变任何对用户和模型可观察的行为，除了第一条有意改变给模型的那句文案里的数字读法。
- 只能往后追加发给模型的内容（`.claude/rules/prompt-prefix.md`）。
- 事故表里已关闭的行必须引用真实存在的门槛文件（`npm run check:incident-gates`）。
- 不许写代码注释（Andy 的全局指令）。

## 已经跑过的检查

- `apps/agent-service/test/production-sandbox-tool-result.unit.test.ts`、`production-runtime-tools.unit.test.ts`、`prompt-catalog.unit.test.ts`、`service-orchestration.unit.test.ts`、`packages/application/test/thread-execution-state.unit.test.ts`、`thread-execution-watch.unit.test.ts`：共 277 条通过。
- `test/integration/sqlite-sandbox-execution-v2.test.ts`：765 条通过。
- `test/integration/production-queued-run-restart.test.ts`（11 条）、`thread-run-lifecycle.test.ts`、`thread-resource-projection.test.ts` 通过。
- `npm run typecheck`、`npm run lint`、`npm run check:incident-gates`（incidents=85 errors=0）通过。
- `document-governance` 的 `validate_docs.py --strict` 仍是 main 上原有的 11 条 Runbook 哈希错误，没有新增。
- `npm run format:check` 在 main 上本来就失败（来自 `c7685e77`），本 PR 没有改变这一点；PR 306 在修它。

## 请回答的问题之外，特别想知道的

- 第一条改了给模型的文案里的数字。这句文案出现在给模型的工具结果里。请判断它和「发给模型的内容只能往后追加」有没有冲突。
- 第二条删掉了一个原本挂在事故 I-84 名下的门槛文件。请判断删它之后，I-84 这一行声称的保护是否还站得住，事故表那一行现在的措辞和代码是否相符。
- 第三条的理由里有一处推断：「单个沙箱调用的轮次不可能同时满足『已经恢复出结果』和『还有一个结果未知且永远恢复不了的调用』」。请核对这个推断，以及去掉开关之后有没有哪条路径的行为变了。
