# PR 282 第 7 轮逐条判断

模型：`opencode-go/deepseek-v4.1-flash`（经 Magpie 路由，实际服务方 OpenDesign；CodeBuddy 预检失败被丢弃，见账本 `dropped=workbuddy-ai`）。本轮费用 0.1120 美元，本 PR 累计 0.9638 美元。

本轮复核的提交是 `89481242`，增量基准是第 6 轮复核过的 `17556568`，其间只有 `89481242` 一个提交。

这一轮是 Andy 2026-11-08 11:25 说「批准再跑一轮」的那一轮，也是第一次越过「单个 PR 复核累计 1 美元先问」门槛前他明确批准的一轮（跑之前已花 0.8518，批准额度按 1.2 美元登记）。

**没有高危、没有中危。**模型原话：「**未发现高危或中危的运行时缺陷**；发现三处低危的“门槛/说明与实现不完全一致”，以及一处测试覆盖缺口。」它还逐条核实了第 6 轮线程给出的事实：`finish()` 无条件带 `exitCode`、`resource_limit` 在进程自己退出之后才被观察到的状态可达、资源上限文案已改、三语门槛已加、假日志 `bind` 已接上生产校验；并确认期限超时的「已被终止」仍然正确，因为那一支只在 `exitCode === null` 时走到。

四条低危全部成立，三条已改，一条按模型给的第二个选项处理（见 R7-4）。按 `.agents/instructions/model-review.md`，低危改动够小时用 `--accept-low` 记进账本、不再复核。

## R7-1【低】三语门槛的「必须出现新说法」只做了整组 `some()` —— 成立，已修

模型原话见 `deepseek-v4.1-flash.md` 的「低 1」一节。

核对：`apps/control-center/test/i18n-runtime.unit.test.ts` 第 6 轮加的那条用例，禁用词是逐条查的，但「必须出现新说法」写成 `ceilings.some((message) => message.includes(text))`。四个上限原因词里只要还有一条带着新说法，另一条被改成既不含禁用词也不含新说法的文案就能通过。

改法：`required` 从字符串数组改成「消息 id → 必须包含的那一句」的表，逐个断言；禁用词继续逐条查，并补上「在终止前」。断言都带上 `${locale} ${id}` 的说明，失败时直接看出是哪一条。

门槛（实测先红后绿）：把 `ja` 的 `toolMemoryLimit` 改成只剩「コマンドのメモリ使用量が上限を超えました」（去掉后半句，不含任何禁用词，另外三条照旧），改前的整组写法会通过，改后的逐条写法失败，报 `ja chat.reason.toolMemoryLimit: expected 'コマンドのメモリ使用量が上限を超えました' to contain '実行は終了し、後処理は完了しています'`；恢复文案后 117 条用例全过。

## R7-2【低】给模型的资源上限文案没禁「已终止」 —— 成立，已修

模型原话见「低 2」一节。

核对：`apps/agent-service/test/production-runtime-tools.unit.test.ts` 的资源上限用例禁了「已被终止」和「在终止前」，没禁「已终止」，所以「命令已终止，执行已结束并完成清理」这种写法会绿。输出上限那一组同样只禁了「已被终止」。

改法：两组都加 `not.toContain("已终止")`，输出上限那一组再补上「在终止前」，和 i18n 门槛的禁用词对齐。

门槛（实测先红后绿）：把 `sandboxCeilingExceededMessage` 的资源上限那一句改成「${crossed}，命令已终止，执行已结束并完成清理」，CPU、内存、资源三条用例全部失败；恢复后全过。

## R7-3【低】事故表把 `bind` 的绑定环境也说成「取已存事实」 —— 成立，已修

模型原话见「低 3」一节。

核对：`bind` 这一刻还没有已存事实。生产 `packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts` 的 `bindAndStart` 用 `environment: input.facts.environment`，假日志用 `command.facts.environment`，两边一致；只有 `append` 和 `operation` 才取已存事实里的那一份。第 6 轮改动本身是对的，错的是事故表那句话把 `bind` 也带进去了。

改法：`docs/incidents-and-gates.md` 的 I-84 行拆成两句写清楚哪一处取传入的、哪一处取已存的，并按模型的建议补齐生产 `bindAndStart` 在契约校验之外另有的六项检查（序号必须是 1、结果必须为空、副作用必须是未知、资源观察序号必须是 2、监管状态必须是 `initializing`、观察时刻不得晚于当前时刻），连同 `operationOnly` 的三项，一共九项假日志都没有复刻。模型只列了四项，另两项（序号必须是 1、观察时刻不得晚于当前时刻）是线程读 `:1167-1173` 补上的。

## R7-4【低】SRT 路径的上限接线没有用例 —— 成立，按模型给的第二个选项处理

模型原话见「低 4」一节。模型自己把它标成「属于覆盖缺口，不是已证实的缺陷」，并给了两个选项：加一个用假 session 的 worker 层用例，或者在事故表里写明这一支只有判定函数级单测、不要让人读起来像已覆盖。

线程选第二个，理由是第一个要造的假替身太多：`runInSrtEnvironment` 在走到那个分支之前要过主机绑定、`resolve` 调用、作用域校验、工作区根目录解析和 `srtSessionRequest`，这些都得造替身，属于新建一套 worker 层 SRT 夹具，不是低危意见该有的改动量；而且 `test/integration/production-srt-task-environment.test.ts` 用真实进程，里面没有任何越过上限的用例，加一条要真正把 CPU 或输出顶过上限。

改法：事故表的未覆盖一栏改成写明三件事——SRT 这一支把 `resource_limit` 和 `output_limit` 写成 `error` 的接线没有用例；这一支里「上限优先于 `knownExit`」的排序也没有用例；上面的单测覆盖的只是「越了哪一项上限、对应哪个原因码」，不是 SRT 分支自己的接线，所以这两处只有读代码的证据。原来那句「三条路径走的是同一个有界失败判断」读起来像已覆盖，已删掉这个说法。要补 worker 层用例得另出方案，已写进同一栏。

## 本轮另外自己发现并修掉的一处（不是模型提的）

跑 `apps/agent-service/test` 全套时，`apps/agent-service/test/prompt-catalog.unit.test.ts` 的 `finds no prompt-like literal outside the catalog` 失败：`PROMPT_OUTSIDE_CATALOG apps/agent-service/src/production-sandbox-tool-result.ts:162 只输出`。那道门槛扫 `apps/*/src`、`packages/*/src` 下所有字符串字面量，提示词标记词出现在提示词目录之外就失败，而第 5 轮改写的输出上限说明里有「请改成只输出需要的部分」。这是本 PR 自己引入的，三轮模型复核读的是改动差异都没发现，第 0 层的推导也找不到这道门槛（它按路径扫源码，不 import 被改的文件）。已把那句改成「请缩小输出范围后重试」，门槛恢复通过；教训记进 `docs/lessons.md` 的「第 0 层漏跑直接相关的测试文件」一节。

## 模型自己标明没核实的

- 它不能运行测试，所以「改回旧值会失败」「用例全过」都只是按断言静态判断。本轮三条的红绿都由线程实测，结果写在各条里。
- 它说仓库没有 `origin/main` ref，所以「`origin/main` 没有变化」未核实。线程这边 `git fetch` 后核对过。
- 它提的 `listPending` 长期累积，事故表已写成保守代价，模型也说没发现它会导致本轮主诉的「等原始期限」；要不要加一条关闭 `effect=unknown` 有界失败的路径，留给 Andy 定。
