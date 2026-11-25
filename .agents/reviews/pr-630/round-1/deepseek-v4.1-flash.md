**侧重检查**

- 错误路径：核对了非零退出、被信号杀死（`child.status ?? 1`）、启动失败（`child.error` 未检查）、空输出（`tail.length === 1 && tail[0] === ""` 跳过）、`maxBuffer` 超限（`spawnSync` 置 `status=null`→按失败处理）。空输出与信号路径处理正确；`child.error`/`maxBuffer` 的情况会被误判成普通失败且丢掉真实退出码。
- 不可信输入：步骤输出被原样打印并再打印一次；含 ANSI/`::` 工作流命令时没有清洗，但改动前 `stdio: "inherit"` 也是原样输出，且 CI 摘要侧（`scripts/ci/ci-summary.mjs`）会去 ANSI、加 `| ` 前缀、遮盖，故不是新增的注入面。
- 安全：复印的内容此前已经打印过一次，`scripts/ci/execute.mjs:46-49` 写日志时整体 `redactText`，没有新增秘密泄露种类。
- 资源耗尽：每步整段输出（最多 256MB/流）驻留内存再 `split("\n")`，见意见 4。
- 不可撤销操作：本改动无。
- 规则/文档/代码一致：`ci-summary.mjs:18` 的 `FAILED_LOG_TAIL_LINES = 120` 证实作者“只显示末尾 120 行”的前提；但见意见 2、5。

未发现会破坏构建或产生错误结果的高严重度缺陷。以下按严重度列出。

### 1 中 步骤输出改为“跑完才打印”，挂起/超时/输出超限时正在运行的步骤输出全部丢失

- 文件:行：`scripts/run-all-checks.mjs:39-47`；`scripts/ci/execute.mjs:12-34`。
- 问题：原来 `stdio: "inherit"` 让每一步实时写进 CI 日志；现在用管道把整段输出收进内存，步骤结束后才 `process.stdout.write(output)`。一旦某步挂起被 CI 超时或 `execute` 的 `output_limit` 杀掉，正在运行的那一步输出从未写进 `check.log`——而它恰恰是最需要诊断的一步。
- 证据（读代码证实）：新代码 `const child = spawnSync(npm, ["run", name], { stdio: ["inherit", "pipe", "pipe"], ... }); const output = ...; process.stdout.write(output);`（39-46 行）；CI 侧 `execute.mjs` 是流式 `child.stdout.on("data", collect)`、`stderr` 同样收集，并在 `if (bytes > 32 * 1024 * 1024) stop("output_limit")`、`setTimeout(() => stop("timeout"), timeoutMs)` 后仍把已收集内容写日志。旧实现是 `stdio: "inherit"`（见基准版本第 31 行）。
- 建议：改用 `spawn` 的 `data` 回调边写 `process.stdout` 边维护一个“最后 80 行”的有界环形缓冲，既保持实时性又能在结束时复印；至少不要让诊断完全依赖子进程正常退出。

### 2 中 多个步骤同时失败时，120 行窗口仍看不到排在前面的失败步骤（原问题只解决了一部分）

- 文件:行：`scripts/run-all-checks.mjs:29-34`；`scripts/ci/ci-summary.mjs:18,255-274`。
- 问题：复印按失败顺序（即 `check:steps` 顺序）输出，每个失败最多 80 行。CI 只取 `check.log` 最后 120 行，因此只有最后一个失败步骤完整可见，更早的失败步骤输出会被挤出窗口。作者要解决的正是“排在前面”的步骤（如 `check:delivery-deploy`），但当它后面还有别的步骤失败时，仍然看不到。
- 证据（读代码证实）：`for (const { name, output } of failures) { ... log(CHECK_FAILED_OUTPUT ...); for (const line of tail) log(line); }` 是正序；`FAILED_LOG_TAIL_LINES = 120` 且 `renderSummary` 用 `.slice(-tailLines)`。`execute.mjs:47-49` 还在复印之后追加一行 JSON 结果，进一步占用窗口。
- 建议：把复印总量预算到 120 行内并按失败数均分（例如每个失败取最后 `floor(120/N)` 行，至少保留 1 行），或只输出每个失败的最后一条关键错误行 + 指向完整日志；这样每个失败步骤都能出现，而不是只保留最后一个。新增测试也只覆盖单个失败，见意见 3。

### 3 中 真正生产路径 `runStep` 没有自动检查，只有注入桩的单测

- 文件:行：`test/tooling/run-all-checks.test.mjs:38-54`；`scripts/run-all-checks.mjs:38-48`；`package.json` 的 `check:check-runner`。
- 问题：新测试只调用 `runAllChecks` 并注入 `(name) => ({status, output})` 桩，验证的是纯函数的切片/打印。`runStep` 本身（`spawnSync` 抓 stdout+stderr、写回 stdout、`status ?? 1`、`maxBuffer`）完全没被执行。若把 `return { status, output }` 写错、或漏了 `process.stdout.write`，测试仍会通过，而 CI 实际不会复印任何东西。
- 证据（读代码证实）：测试第 43-44 行用桩返回对象；`runStep` 未导出，`grep runAllChecks|stepNames` 只有本文件与测试引用；`check:check-runner` 只跑这一个测试文件。
- 建议：导出 `runStep` 或允许注入 `spawn`，并用一个真实的小子进程（同时写 stdout/stderr、退出码 1）断言：两路输出都进了 stdout、返回的 `output` 含两路、复印尾部正确。再补“空输出不出 header”“多失败都复印”的用例。

### 4 低-中 整段输出缓冲 + 256MB `maxBuffer`：内存放大，且可能把正常失败变成 infrastructure_failed 并丢掉末尾复印

- 文件:行：`scripts/run-all-checks.mjs:43-45`；`scripts/ci/execute.mjs:27-30`。
- 问题：`maxBuffer: 256 * 1024 * 1024` 且两个流分别缓冲，拼成字符串后又 `split("\n")` 成行数组；极端情况下内存远大于单步输出，且 `maxBuffer` 超限会把原本 `status=0` 的步骤当成失败。CI 侧 `execute` 全日志上限只有 32MB，复印产生的额外字节可能把总输出推过线，触发 `output_limit` 杀死进程，而末尾复印恰好被截掉——功能失效。
- 证据（读代码证实）：`spawnSync(..., { maxBuffer: 256 * 1024 * 1024 })`、`const output = ...`、`output.replace(...).split("\n")`；`execute.mjs` `if (bytes > 32 * 1024 * 1024) stop("output_limit")`。
- 推测：需要单步输出非常接近上限才会触发，日常检查不太可能；但这是资源路径上的真实退化。
- 建议：与意见 1 合并为环形缓冲（只保留最后 80 行 + 边写边出），把 `maxBuffer` 降到与 CI 上限同量级（如 32MB），并显式检查 `child.error` 后报出 `CHECK_STEP_OUTPUT_LIMIT` 而不是伪装成退出码 1。

### 5 低 输出标签与文档行号已和代码不一致

- 文件:行：`scripts/run-all-checks.mjs:32`；`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:160`；`docs/incidents-and-gates.md`（I-55 条目）。
- 问题：header 固定写 `last 80 lines`，但输出不足 80 行时实际打印的是全部行，标签会误导；另外 ADR 0265 引用 `scripts/run-all-checks.mjs:31`，改动后第 31 行已变成 `if (tail.length === 1 ...)`，不再是清单/汇总逻辑；I-55 里“最后列出每个失败的步骤”现在也不再字面成立（汇总之后还有复印）。
- 证据（读代码证实）：第 32 行 `log(\`CHECK_FAILED_OUTPUT ${name} last ${FAILED_OUTPUT_LINES} lines\`)`；ADR 原文“`npm run check` 只跑这里列出的步骤，`scripts/run-all-checks.mjs:31`”。
- 建议：标签改成实际打印行数（`last ${tail.length} lines`），并顺手更新 ADR/I-55 的措辞；文档尽量引用符号而非行号，避免下次再漂移。

**必答问题**

1. 不会。改动只在 `scripts/run-all-checks.mjs` 及其测试里；`grep runAllChecks|stepNames` 显示除自身外只有测试引用，没有任何提示词/模型请求组装或出口遮盖路径引用它。发给模型的内容（系统提示、工具定义、历史、遮盖结果）完全未动，因此不存在“开头被改”或“会变的值不在最后一条消息”的问题；只追加规则不适用。

2. 不会影响模型请求的字节。该改动不在请求路径上，不产生或修改任何发给模型的内容；`replace/split/slice` 本身是确定性的，不依赖前后文、时间或无序集合。被复印的步骤输出本身可能含耗时等变化，但那是命令输出固有的，不是本次改动引入的“同一段文字变成不同字节”。

3. 有，但不完整。新增用例（`test/tooling/run-all-checks.test.mjs:38-54`）验证“汇总后复印最后 80 行、passing 步骤的 `fine` 不被复印”；按逻辑它在改代码前必然失败（旧代码没有 `CHECK_FAILED_OUTPUT`，且对象返回会被当成失败，`CHECK_SUMMARY 1 of 2` 也不会出现）。缺口：`runStep` 的真实子进程路径、空输出跳过、多失败场景都没有自动检查（见意见 3）。我受工具限制没有运行测试，“实际通过”未核实。

4. 逐个核对过：新字段 `{status, output}` 的生成处是 `runStep`（`run-all-checks.mjs:47`），唯一使用处是 `runAllChecks` 的 `typeof result === "number"` 兼容分支（20-21 行），旧数字返回值仍可用；新标识行 `CHECK_FAILED_OUTPUT ...` 只被新测试消费，仓库内没有其他解析器；原有 `CHECK_FAILED`/`CHECK_SUMMARY` 仍照常输出，位置在复印之前。`FAILED_OUTPUT_LINES` 只在模块内使用，测试独立硬编码 80（改常量会同时要求改测试）。无数据库约束、配置键或后端校验涉及。唯一发现的不一致是 ADR 0265 的行号引用漂移（意见 5）。
