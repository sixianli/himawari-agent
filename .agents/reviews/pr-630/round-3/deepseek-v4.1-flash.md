## 复核范围

- 本轮增量 `git diff d97063f..b0b80c6` 只有两个代码/测试文件：`scripts/run-all-checks.mjs`、`test/tooling/run-all-checks.test.mjs`（另有 `.agents/reviews` 记录，见末尾“未核实”）。
- 我读了两份文件的全文，以及 `package.json:26-27`、`docs/incidents-and-gates.md` 的 I-55/I-73、`.agents/instructions/prompt-prefix.md:27-28,36-37,53-54`。
- 上一轮 4 条意见的核对结论：1（预算含标题、总量 ≤100）已改好；2 的 `tail` 部分已改好，但仍有别的内存路径（见意见 2）和“字节/代码单元”名实不符（见意见 3）；3 的测试已能证伪“收集到结束再打印”；4 的 `process.exitCode` 已改好，但没有对应测试（见意见 4）。

### 1 低-中 真实 60 个 check 步骤全部失败时，重印区一条都不输出

- 文件:行：`scripts/run-all-checks.mjs:36-37`、`package.json:27`、`test/tooling/run-all-checks.test.mjs:87-107`
- 问题：失败步骤数超过 50 时 `share` 为 0，函数直接返回，`CHECK_FAILED_OUTPUT` 重印区为空。当前 `check:steps` 恰好有 60 个 `npm run` 步骤（我逐个数的），所以“所有步骤一起失败”（例如依赖缺失、环境坏掉）这一最需要看原因的场景，重印区完全为空，只剩 60 行 `CHECK_FAILED` 和一行摘要。作者“分不到 1 行就不重印”的说法与代码一致，但这是一个可以避免的诊断退化。
- 证据（读代码证实）：
  - `scripts/run-all-checks.mjs:36-37`：`const share = Math.floor((FAILED_OUTPUT_BUDGET - failures.length) / failures.length);` / `if (share < 1) return 1;`
  - `package.json:27` 的 `check:steps` 共 60 个 `npm run …`（含 `check:check-runner`）。
  - 测试把这个结果固定了下来：`it.each([25, 49, 60])` … `else expect(repeated).toEqual([]);`（`test/tooling/run-all-checks.test.mjs:87,107`）。
- 建议：预算只分给“确实有输出”的失败步骤；或者对最多 K 个步骤各给一行（可把标题和内容合成一行），对剩下的打一行 `CHECK_FAILED_OUTPUT … omitted N steps`。这样既不超过 100 行，也不会在 60 步全失败时一条原因都不留。

### 2 低 写入 `process.stdout` 不处理背压，父进程内存可随单个步骤输出无界增长（上一轮引入，本轮未修）

- 文件:行：`scripts/run-all-checks.mjs:50,54-61`
- 问题：`write(text)` 的返回值被忽略，`child.stdout/stderr` 的 `data` 事件也从不暂停。下游（CI 日志管道）读得慢时，Node 会把所有来不及写出的块堆在父进程里，内存随步骤输出总量增长。上一轮把 `spawnSync(stdio:"inherit")` 改成管道后引入了这条路径；本轮只封了 `tail`，没有处理它。另外下游提前关闭（例如 `npm run check | head`）时，`process.stdout` 的 `error` 没有处理。
- 证据（读代码证实）：`const keep = (chunk) => { const text = chunk.toString("utf8"); write(text); tail = (tail + text).slice(-STEP_TAIL_BYTES); };`、`child.stdout.on("data", keep); child.stderr.on("data", keep);`，默认 `write = (chunk) => process.stdout.write(chunk)`，无 `pause`/`drain`/`error`。
- 推测：实际是否 OOM 取决于下游消费速度和单步输出量；正常 CI 下可能不会触发，所以定为低。
- 建议：用 `child.stdout.pipe(process.stdout, { end: false })`、`child.stderr.pipe(process.stderr, { end: false })`（管道自带背压），另用 Transform 或 `data` 监听维护 `tail`；给 `process.stdout` 挂 `error` 处理。

### 3 低 `STEP_TAIL_BYTES` 实际按 UTF-16 代码单元截断，不是字节

- 文件:行：`scripts/run-all-checks.mjs:7,57`、`test/tooling/run-all-checks.test.mjs:151`
- 问题：作者说“runStep 尾部按 64KB 字节封顶”，但 `slice(-STEP_TAIL_BYTES)` 用的是 JS 字符串长度（UTF-16 代码单元）。中文输出的实际尾部可达约 192 KiB（每个 BMP 汉字 3 字节），emoji 等代理对还可能被从中间切开，产生孤立代理项/`�`。测试 `expect(result.output.length).toBe(STEP_TAIL_BYTES)` 断言的也是代码单元数，不是字节，所以无法发现这一点。另外 `chunk.toString("utf8")` 在块边界切开多字节字符会产出 `�`（这一半是上一轮就有）。
- 证据（读代码证实）：`export const STEP_TAIL_BYTES = 64 * 1024;`、`tail = (tail + text).slice(-STEP_TAIL_BYTES);`、测试里 `expect(result.output.length).toBe(STEP_TAIL_BYTES);`。
- 建议：用 `Buffer` 按字节保留（`Buffer.concat` + `subarray(-STEP_TAIL_BYTES)`），并在 UTF-8 字符边界向前调整，配合 `StringDecoder` 跨块解码；若坚持字符串语义，就把常量改名为 `STEP_TAIL_CODE_UNITS` 并修正说法。

### 4 低 `process.exitCode` 修复没有自动检查

- 文件:行：`scripts/run-all-checks.mjs:76`
- 问题：第 4 条意见的修复本身正确（不再 `process.exit`，让 stdout 自然排空），但现有测试只直接调用 `runStep`/`runAllChecks`，没有任何测试运行真实脚本并检查退出时重印内容完整。把这一行改回 `process.exit(await main())` 不会让任何测试失败。作者说的“测试断言子进程结束前已写出”对应的是第 3 条（流式输出），不是这一条。
- 证据（读代码证实）：`process.exitCode = await main();`；`test/tooling/run-all-checks.test.mjs` 全文没有 spawn 这个脚本或断言退出后 stdout 完整。
- 建议：加一条集成测试，用临时 `package.json`/步骤让重印量接近预算上限，然后 spawn `node scripts/run-all-checks.mjs`，在进程退出后断言最后的重印行仍在捕获的 stdout 里；改回 `process.exit` 时该测试应失败。

## 侧重检查

- 错误路径：`spawn` 的 `error` 会 `resolve({ status: 1, output: tail + error.message })`，`close` 用 `code ?? 1`，不会挂起；但 `process.stdout` 的写错误/EPIPE 没有处理（意见 2）。`process.exitCode` 修复无测试（意见 4）。
- 不合规范/不可信输入：`stepNames` 用 `^npm run (\S+)$` 限制成单个 npm 脚本名，`spawn` 用参数数组、不过 shell，没有命令注入。子进程输出被当作纯文本记录；`lastLines` 只做线性正则和 `split`，无注入或 ReDoS。多字节字符在块边界可能被破坏（意见 3）。
- 安全：未发现秘密记录、权限或命令注入问题；输出原样包含 ANSI 转义序列，属于 CI 日志的预期行为。
- 资源耗尽：`tail` 已封顶，`failures` 保存的 `output` 上限约为 60×64 Ki 代码单元（约 3.8 MB），可接受；真正未封的是意见 2 的 stdout 缓冲。
- 不可撤销操作：这个脚本只运行检查、不写仓库文件、不删数据；未发现不可撤销操作。
- 规则/文档一致性：`docs/incidents-and-gates.md` 的 I-55 只说“跑完所有步骤、列出每个失败步骤并非零退出”，没有承诺重印，代码仍一致；但作者“64KB 字节”的说法与代码不符（意见 3），60 步全失败不重印也没有文档说明，只被测试固定。

## 必答问题

1. **不改变、不涉及。** 本改动只改本地检查脚本和测试，不组装也不发送模型请求；系统提示、工具定义、历史消息、遮盖结果都不变。按 `.agents/instructions/prompt-prefix.md` 第 1、4 条，只要不碰这些内容，就不影响“只在末尾追加”；本改动连模型请求都不产生，所以“每轮会变的值都在最后一条消息里”这一条也不涉及。
2. **不涉及模型请求的字节确定性。** 脚本输出不会发给模型。脚本自身尾部截断点可能受数据块边界影响（意见 3 的多字节字符问题），但那是本地日志，不是模型请求；同一段输出在不同运行里大多是相同字节，这一点对模型缓存没有影响。
3. **有，但只覆盖了三项。** 预算公式有反向用例：把 `share` 改回旧公式，`it.each([25,49,60])` 会因超过 `FAILED_OUTPUT_BUDGET` 而失败。`tail` 封顶有反向用例：去掉 `.slice(-STEP_TAIL_BYTES)`，长行测试会因长度不等于上限而失败。流式测试也真的能证伪“收集到结束再一次性打印”：子进程 1.5 秒后才退出，测试 1.2 秒内就要求看到 `out first` 且 `finished === false`，缓冲实现会超时失败。缺口有三处：(a) `process.exitCode` 无测试（意见 4）；(b) 预算测试全部引用同一个 `FAILED_OUTPUT_BUDGET` 常量，把它从 100 改成 1000 测试仍然通过，守不住“120 行窗口”的绝对上限，建议在测试里硬编码上限或断言常量范围；(c) 流式测试从 spawn 起等 1.2 秒，Node 启动慢于 1.2 秒时会误报失败，属于时间抖动风险，建议放大 `vi.waitFor` 超时或改成“父进程发信号后子进程再延迟”的握手。
4. **逐个核对过，没有发现 I-73 那类产生端/使用端不一致。** `STEP_TAIL_BYTES` 只被 `scripts/run-all-checks.mjs:57` 和测试 `test/tooling/run-all-checks.test.mjs:9,151` 使用；旧的 `STEP_TAIL_LINES` 已无任何引用（grep 全仓库为 0）。`lastLines` 是新导出，但只有脚本内部调用，没有外部导入。`CHECK_FAILED_OUTPUT … last N lines` 这个格式只被测试 `:59,81` 解析，测试已同步改成 `FAILED_OUTPUT_BUDGET - 1` 和 `24`，两端一致。退出码由 npm/CI 消费，`0/1` 语义不变。唯一的语义风险是 `STEP_TAIL_BYTES` 的名字暗示字节、实际是 UTF-16 代码单元（意见 3），未来若有别的使用方按字节理解会出错。

**未核实**：本轮没有运行测试（只允许读文件和五条 git 命令）；`.agents/reviews/pr-630/round-2/` 不在稀疏检出里，`git show` 也被仓库钩子拒绝（`REVIEW_GIT_REFUSED`），所以上一轮意见原文以你给的材料为准。
