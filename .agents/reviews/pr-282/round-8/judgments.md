# PR 282 第 8 轮逐条判断

模型：`opencode-go/deepseek-v4.1-flash`（经 Magpie 路由，实际服务方 OpenDesign；CodeBuddy 预检失败被丢弃，见账本 `dropped=workbuddy-ai`）。本轮费用 0.1275 美元，本 PR 累计 1.0913 美元。

本轮复核的提交是 `dd7dea4d`，基准是合并进来的新 main `01873f5c`，增量基准是第 7 轮经 `--accept-low` 记账后的 `e7a5ebe5`。

这一轮的由来：第 7 轮之后 Andy 说「合并」，线程按规则先 `git fetch` 并把 `origin/main` 合进分支，发现 main 这期间多了八个已合并的 PR（`2995d535` → `01873f5c`），而仓库规则是「合并 main 之后也要再复核」，再跑一轮会让本 PR 的复核费用越过 1 美元的先问门槛。线程停下问 Andy，他说「再跑一轮，跑完之后直接合并」。

**没有高危、没有中危。**模型原话：「未发现高、中危问题。第 8 轮增量（`43416c71` 账本 + `dd7dea4d` 合并）是一次干净的并集：以 `01873f5c`（main）为基准，合并结果只多出本 PR 的 60 个文件改动；以 `43416c71`（分支）为基准，只多出 main 的 197 个文件改动。两边都改过的 8 个文件逐个核对，未发现丢改动或方向相反的回退。」它还逐项核对了 1 GiB 常量在服务装配、worker 装配和签名清单三处一致，以及事故表 I-84、I-89、I-86 三行各出现一次、门槛文件都存在。

一条低、两条提示。低的那条改了，用 `--accept-low` 记进账本；两条提示模型自己说是「可接受为现状」，列在下面给 Andy 抽查，不改。

## R8-1【低】内存上限的报数单位和仓库口径不一致，而且没有用例把生产常量送进文案 —— 部分成立，已修其中的覆盖缺口

模型原话见 `deepseek-v4.1-flash.md` 的「低 — `apps/agent-service/src/production-sandbox-tool-result.ts:163`」一节。

核对：两件事都属实。一、`limitBytes` 和 `limits` 都按十进制除以 `1_000_000` 并标 `MB`，所以 main 把工具命令的内存上限提到 1 GiB（`packages/execution-contracts/src/sandbox-memory-limit.ts` 的 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024`）之后，模型看到的是「内存 1073.7 MB」。二、所有文案用例都用 268_435_456 这类假值，没有一条把生产常量送进 `sandboxCeilingExceededMessage`。

线程的判断，和模型给的两个选项对照：

- **单位不改。**模型自己写了「若要继续用十进制单位，保持现状即可」。十进制的 MB、KB 是字节大小的通行写法，`limitBytes` 的三档（MB、KB、字节）在输出上限那边也一直是这个口径；改成 MiB 要同时动给模型的两段说明和四条现有断言里的数字（「内存 268.4 MB」「输出 2.5 MB」「输出 32.8 KB」），那是改面向模型的文案，不是低严重度意见该有的改动量。这条留给 Andy 定，列在 PR 说明的「可以更好」里。
- **覆盖缺口补上。**这是这条意见真正站得住的部分：没有任何用例把生产常量送进这段文案，所以单位口径以后改了也不会有东西拦。新增 `apps/agent-service/test/production-sandbox-tool-result.unit.test.ts` 的 `[I-84] reports the production memory limit to the model in decimal megabytes`：直接用 `SANDBOX_MEMORY_LIMIT` 和 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 调 `sandboxCeilingExceededMessage`，断言说明里是「内存 1073.7 MB」。

门槛（实测先红后绿）：把那一句的除数改成 `1_048_576`、单位改成 `MiB`，这条用例以 `expected 'SANDBOX_MEMORY_LIMIT：命令使用的内存超过上限，执行已结…' to contain '内存 1073.7 MB'` 失败；恢复后这个文件 10 条、加上 `production-runtime-tools.unit.test.ts` 共 122 条全过。

## R8-2【提示】两份白名单一致的检查只点名了两个码 —— 成立，不改

模型原话见「提示 — `test/tooling/safe-tool-reason-codes.test.mjs:20-24`」一节。

核对属实：那条检查显式断言的只有 `SANDBOX_CPU_TIME_LIMIT` 和 `SANDBOX_OUTPUT_LIMIT`，核心断言是两份名单相等，所以「两份都删掉同一个码」它拦不住。但模型自己写了「低风险。`packages/application/test/thread-execution-state.unit.test.ts:49-52` 已逐个覆盖四个码，整体门槛不缺口」——四个码是否真的能投影出来由那条用例管，这条检查管的本来就是「只改一份」。两道门槛加起来没有缺口，不改。

## R8-3【提示】不可恢复标记的键前缀在写入端和查询端靠隐含约定对齐 —— 成立，不改

模型原话见「提示 — `packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts:23-24`」一节。

核对属实：写入端用 `sandboxUnrecoverableResultOperationKey(invocationId)` 生成完整键，查询端用 `sandboxUnrecoverableResultOperationKey("")` 拼前缀再接 `json_extract`，两端一致依赖「这个函数就是前缀加原样 id」。模型自己说「可接受为现状……现有 `stream-candidate-unrecoverable` 用例会覆盖两端不一致的情况，风险不高」。线程同意：真改了分隔符或后缀，那条用例会失败。另外仓库规则禁止代码注释，所以模型建议的「在契约里补注释」不能采纳；要更稳的做法是给 SQL 一个只取前缀的显式常量，属于结构改动，列给 Andy 当「可以更好」。

## 模型自己标明没核实的

- 它不能运行测试和脚本，所以线程报的「162 个文件 3051 条全过」「各道门槛通过」「`validate_docs.py` 仍是 main 原有 11 条」都未核实。这些是线程实测的，结果写在提交说明和 PR 说明里。
- 仓库钩子不让它 `git show` 本 PR 的 `usage.jsonl`，所以账本里四条 R7 finding 的 `from`／`head` 它没核对；`--assert-reviewed` 会按链重算这两项，第 7 轮记账时已通过。
- 事故表三行的列数它没有逐字符数（读取时超长行被截断）；`npm run check:incident-gates` 实测通过，85 条、0 错。
