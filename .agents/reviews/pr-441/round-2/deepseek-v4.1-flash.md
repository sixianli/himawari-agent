# 复核结论（PR 441 第 2 轮，b9426447）

## 一、问题清单（按严重度从高到低）

### 1. 中：路径穿越的反向用例是“空转”的，删掉过滤也会通过

- 文件：`test/tooling/ci-summary.test.mjs:278-291`
- 问题：用例注册了 `../outside.json`，但只创建了 `../outside.log`；而日志一侧本来就不会读 `listFiles` 之外的文件，所以无论 `reportPaths` 的 `..`/绝对路径过滤在不在，输出都不会包含 `outside secret`。这个反向用例没有真正验证“JSON 报告路径指向目录外不读”。
- 证据（我读到的原文）：
  ```js
  "result.json": JSON.stringify({ status: "failed", reports: [
    { path: "../outside.log", kind: "diagnostic" },
    { path: "../outside.json", kind: "json" },
  ]}),
  ...
  writeFileSync(path.join(root, "..", "outside.log"), "outside secret\n");
  roots.push(path.join(root, "..", "outside.log"));
  expect(renderFailedLogs({ title: "t", reports: root })).not.toContain("outside secret");
  ```
  真正会被直接 `readFileSync` 的只有 `failedTests`（`scripts/ci/ci-summary.mjs:183-186`），而 `../outside.json` 并不存在，`readFileSync` 只会 `ENOENT` 被 `catch` 吞掉；日志侧 `renderSummary` 的候选永远来自 `listFiles(reports)`，相对路径不可能等于 `../outside.log`。
- 建议：在 `root/../outside.json` 写一个带 `testResults[].assertionResults[].failureMessages = ["outside secret"]` 的 JSON，再写 `../outside.log`，断言两者都不出现；同时加一个绝对路径（如 `/tmp/...`）用例。这样删掉 `reportPaths` 的两项过滤时用例必须失败。

### 2. 中低：“退出码非 0 的命令日志排前面”对 build / browser / security 不成立

- 文件：`scripts/ci/ci-summary.mjs:234-245, 255, 264`；`scripts/ci/run.mjs:172-183, 444-491`；`scripts/ci/build.mjs:36-39`；`scripts/ci/browser.mjs:84`
- 问题：`failedCommandLogs` 只从 `details.json` 的 `commands` 取失败命令，而 `details.commands` 只在 `run.mjs` 自己的 `command()` 里 `push`。build/browser 分支根本不调用 `run.mjs` 的 `command()`，它们各自在 `build.mjs` / `browser.mjs` 内部记录日志；security 走 `runSecurityChecks`。因此这几类作业的 `details.json` 里没有对应命令，失败日志不会被排到前面。
- 证据：
  ```js
  // run.mjs:183
  details.commands.push({ name, ...outcome });
  // run.mjs:449-465：build/browser 分支直接 await build()/runBrowser()，没有 command()
  ```
  ```js
  // build.mjs:36-39：自己建 log，只进 commandReports，不写 details
  const command = async (name, args, ...) => {
    const log = path.join(destination, `${name}.log`);
    const outcome = await execute(..., { log, ... });
    commandReports.push({ path: log, kind: "diagnostic" });
  ```
- 建议：让 build/browser/security 的失败命令结果也进入 `details.json`，或在文档/说明里明确“只有经 run.mjs command() 执行的命令会优先”，别把这条写成普遍行为。

### 3. 低：`FOOTER_RESERVE_BYTES = 512` 不一定放得下说明文字，64 KiB 可能被超出几百字节

- 文件：`scripts/ci/ci-summary.mjs:20, 117-124`
- 问题：footer 最多列 5 个文件名，每个取 `safeName(...).slice(0, 40)`。`slice` 按 UTF-16 码元截断，40 个汉字约 120 字节，5 个约 600 字节，再加说明文字已超过 512。检查逻辑在“加 section 前”只预留 512，之后无条件 `sections.push(footer)`，因此最终可能比 `limit` 多出约 100–400 字节。
- 证据：
  ```js
  const FOOTER_RESERVE_BYTES = 512;
  ...
  const omitted = files.slice(shown, shown + 5)
    .map((entry) => `\`${safeName(entry.relative).slice(0, 40)}\``).join("、");
  const footer = `其余 ${files.length - shown} 个文件...（${omitted}...）。\n`;
  const reserve = remaining > 0 ? FOOTER_RESERVE_BYTES : 0;
  if (used + Buffer.byteLength(section) + reserve > limit) { sections.push(footer); break; }
  ```
- 建议：先用实际 `Buffer.byteLength(footer)` 参与判断（或把 reserve 改成“footer 实际长度 + 余量”），并加一个多字节文件名的边界用例。

### 4. 低：文档与代码不一致

- ADR `docs/adr/0243-ci-uses-no-github-artifacts.md:58` 仍写“放不下的文件只报数量”，但 `renderSummary` 现在对所有摘要（包括诊断）都会列前 5 个文件名（`ci-summary.mjs:118-122`）。
- 设计文档 `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:250` 写“遮盖后的命令日志（每个 `.log` 文件的最后 120 行）”，实际只显示 `result.json` 登记为 `diagnostic` 的 `.log`（`ci-summary.mjs:254, 263`），未登记的、`artifact` 的 `.log` 都不显示。
- 测试标题 `test/tooling/ci-summary.test.mjs:59` 仍叫“放不下的只报数量”，与断言里要求列出名字不符。
- 建议：同步 ADR 第 4 条、设计文档第 250 行和测试标题。

### 5. 低：用例名/文件名路径不过滤不可识别的私钥标记

- 文件：`scripts/ci/ci-summary.mjs:159-162`（cleanLine）对比 `:164-166`（failureMessage）和 `:73`（textTail）
- 问题：`failureMessage` 和 `textTail` 遇到 `-----BEGIN … PRIVATE KEY-----` 会隐藏内容；但 `cleanLine`（用于 `failure.file`、`failure.test`）不做这个判断。若测试名里塞入 SSH2/PGP 私钥（`redactText` 不认），私钥正文会以“换行变 `?`”的形式打印到作业摘要和日志。
- 建议：让 `cleanLine` 也走同一个私钥标记判断（命中则整条名字替换为占位符）。

### 6. 低：命令日志没有去掉 ANSI 颜色码，与“ANSI 颜色码去掉”的说法不完全一致

- 文件：`scripts/ci/ci-summary.mjs:74-78`（`textTail` 只把控制字符换成 `?`，ESC 变成 `?`，`[31m` 留下来）；测试 `test/tooling/ci-summary.test.mjs:75` 明确期望 `last ?[31mred?`。
- 说明：`cleanLine`/`failureMessage` 会删除 ANSI，但命令日志不会。若说法指的是全部输出，需补 `textTail` 的 ANSI 清理；若只指失败用例名/报错，应在说明里写清楚。

### 7. 低：资源上限只加在 vitest JSON 单文件上，其他读取没有上限，失败列表全量驻留内存

- 文件：`scripts/ci/ci-summary.mjs:139-146`（`result.json` 无大小上限）、`:234-245`（`details.json` 无大小上限）、`:178-211`（先收集全部失败再在 `renderFailedTests` 里截断）、`:137`（单报告 64 MiB）
- 问题：`failedTests` 会把所有 JSON 报告的所有失败对象（含完整 `failureMessages` 字符串）先放进数组，之后才只显示 30 条；报告数量/总大小也没有上限。极端情况下（超大失败消息、多个报告）会明显拖慢或占用大量内存。由于 `publish` 会校验 sha256、且报告结构由 vitest 产生，实际可利用性有限，但仍是未设界的路径。
- 建议：给 `result.json`/`details.json` 加大小上限；在 `failedTests` 里达到 `FAILED_TESTS_SHOWN` 后再多取少量即可停止，或先截断 `failureMessages[0]` 再存入。

### 8. 低（推测）：符号链接中间目录与未 lstat 的 `result.json`/`details.json`

- 文件：`scripts/ci/ci-summary.mjs:139-146, 183-186, 234-245`
- 事实：`listFiles` 用 `lstat`（`:27`），`failedTests` 对最终文件也用 `lstat`（`:184`）；但 `result.json`、`details.json` 直接 `readFileSync`，`failedTests` 只 `lstat` 最后一级，若 `reports/` 里存在指向外部的“符号链接目录”，拼出的路径仍会被读取。
- 判断：正式流程中 `publish` 用 `realpathSync` 限制在输出目录内（`run.mjs:51-67`），所以这更像纵深防御缺口，而非可利用漏洞。建议对 `reportPaths` 的最终路径做一次 `realpath` 是否仍在 `reports` 内的检查。

### 9. 低：新增硬规则和说明数字缺少真正的反向保护

- `--failed-logs` 的精确路径只在 `check-policy.mjs:563` 逐字比对，`policy.test.mjs:685-701` 的反向变体只有 missing/duplicated/only-on-success/wrong-folder/wrong-title，没有“改错 `--failed-logs` 路径”或“漏掉 `--failed-logs`”的用例。
- `FAILURE_MESSAGE_LINES=20`、`FAILED_LOG_TAIL_LINES=120`、`FAILED_TESTS_SHOWN=30` 在测试里都用常量本身做期望（`ci-summary.test.mjs:218, 236` 等），把常量改成 200/1000/40 测试仍会通过，而文档写的是 20/120/30。
- 建议：补一个“去掉 `--failed-logs` 必须失败”的 policy 反向用例；在测试里写死 20/120/30 或单独断言这些常量。

---

## 二、读代码证实的 / 推测的

**读代码证实的**

- `reportPaths` 的过滤逻辑本身是对的：先统一分隔符，再排除绝对路径和含 `..` 的段（`ci-summary.mjs:148-155`）；在 Linux 上反斜杠不会被当成路径分隔符，拼出的仍是 `reports` 内的文件名，不能穿越。
- `failedTests` 的结构访问都有守卫：`reports` 必须是数组、`report?.testResults` 必须是数组、`assertionResults`/`failureMessages` 非数组时降级为空（`:142, 190-200`），字段类型不对不会抛异常。
- `failureMessage`/`textTail` 会先 `redactText`，再检查私钥标记（`:73, 165-166`）；用例名里的反引号、U+2028/U+2029、控制字符会被替换（`:159-162, 221`）。
- `logLines` 给每一行加 `| `，且 `gate-log.mjs:30-31` 只匹配行首的 `HIMAWARI_GATE_BEGIN/END`，所以伪造标记的防护是成立的。
- 生产/消费两端对 `kind` 是一致的：`run.mjs:182, 224` 产生 `diagnostic/json/junit`，`ci/schemas/result.schema.json:216` 的枚举包含 `diagnostic`，`publish.mjs` 把 `.log` 留在 `reports/` 并保留原 `kind`，消费者按 `diagnostic` + `.log` 取用。
- `details.json` 的结构（`commands[].name/exitCode`）与 `run.mjs:120-124, 183` 一致；`result.json` 写到 `reports/result.json` 也是发布侧的固定布局。
- 现有诊断摘要的排序未受影响：`renderSummary` 默认 `first=()=>false`，分区后仍是 `listFiles` 的路径序（`ci-summary.mjs:100-104`）。

**推测**

- 失败用例名/路径里若含 `redactText` 不认识的密钥（如 SSH2/PGP），可能被打印出来（见问题 5）。
- 中间目录是符号链接时，`failedTests` 可能读到 `reports` 外的 JSON（正式发布路径已用 realpath 挡住，见问题 8）。
- 失败消息进入公开作业日志，扩大了 `redactText` 覆盖范围之外文本的暴露面；这是设计取舍，不是确定的缺陷。

---

## 三、侧重检查

- **错误路径**：`result.json` 缺失/坏 JSON/无 `reports` 时返回一句说明（`:249-251`）；目录不存在返回空（`:248`）；单个报告读失败/超限/非文件时 `continue`（`:182-189`）；`details.json` 读失败返回空集合（`:242-244`）。均不会抛异常。唯一未包守卫的是 `renderSummary` 内部 `readdirSync/lstatSync`（沿用旧代码）。
- **不可信输入**：结构字段均有类型守卫；字符串内容做遮盖、控制字符/行分隔符替换、反引号/四反引号处理。命令日志不做 ANSI 清理（见问题 6）。
- **安全**：`| ` 前缀能阻止 `::add-mask::` 一类命令和伪造 gate 标记；`gate-log.mjs:30-31` 按行首匹配，证实前缀有效。路径过滤对普通路径有效；符号链接中间目录和 `result.json`/`details.json` 的直接读取是纵深防御缺口。
- **资源耗尽**：单报告 64 MiB、`renderSummary` 256 KiB 尾部读取、输出行/行数截断都已存在；但 `result.json`/`details.json` 无上限、失败列表全量收集、报告总数无上限（见问题 7）。
- **不可撤销操作**：本改动只读文件并 `appendFileSync` 追加 `GITHUB_STEP_SUMMARY`，没有删除/覆盖；`appendFileSync` 失败时 `write` 不会执行，但也不会破坏已有摘要。
- **规则/文档一致性**：ADR 第 4 条、设计文档第 250 行、测试标题与代码有出入（见问题 4）；`check-policy`、`quality-policy`、`main-workflow` 的工作流期望与实际 YAML 一致（`ci.yml`/`quality.yml`/`main.yml` 的 `ci-summary` 调用已核对）。

---

## 四、必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。这个改动只在 CI 侧：`scripts/ci/ci-summary.mjs` 写 `GITHUB_STEP_SUMMARY` 和 stdout，调用方只有 `.github/workflows/{ci,quality,main}.yml`、`scripts/ci/{check-policy,quality-policy,main-workflow}.mjs` 和测试；没有任何模型请求组装代码引用 `ci-summary`/`renderSummary`/`logLines`。因此系统提示、工具定义、历史消息、遮盖结果的序列化都不受影响，仍是“只在末尾追加”。如果云端线程把作业日志当作工具结果读取，那也是在对话末尾追加的新内容，不是请求开头；同一次运行内摘要只写一次，不会中途改写。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会（就本脚本而言是确定的）。`listFiles` 按路径排序，`reportPaths(...).sort()` 排序，`first` 只是稳定分区，`failedCommandLogs` 最终是 `Set` 的成员判断，不依赖 `details.commands` 的顺序；没有时间戳、随机数或对象遍历顺序参与输出。相同的输入文件会得到相同字节。`file.size`、失败条数这类值每次运行可能不同，但它们来自本次输入，且不在模型请求前缀里。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有较完整的正向用例和部分反向用例（通过/失败、坏 `result.json`、`..` 路径、恶意字符、行前缀、空参数），但：
   - 路径穿越反向用例是空转的（问题 1），删掉过滤仍通过；
   - `--failed-logs` 精确路径没有专门的反向用例（问题 9）；
   - 20/120/30 这些说明数字没有被写死的断言保护（问题 9）；
   - 合并后的 64 KiB 边界、多字节文件名 footer、符号链接路径没有用例。

4. **每个新值/改动的两端都能接受吗？**
   已逐个核对：
   - `--failed-logs`：`ci.yml` 6 处产生 → `check-policy.mjs:563` 逐字校验 → `main` 的参数白名单（`ci-summary.mjs:284`）和 `path.resolve`；一致。`quality.yml`/`main.yml` 不传，符合预期。
   - `reports[].path`：`run.mjs:51-67` 用 `realpath` 生成相对 POSIX 路径并禁止目录外 → `publish.mjs` 重算保留 → 消费者过滤后用 `path.join` 读取；一致。
   - `reports[].kind`：生产侧 `json`/`junit`/`diagnostic`/`artifact` → schema 枚举包含 `diagnostic`（`result.schema.json:216`）→ 消费者按 `json`/`diagnostic` 取用；一致。
   - `details.json.commands[].name/exitCode`：生产侧 `run.mjs:183` 写入 → 消费者拼 `${name}.log` 并用 `basename` 匹配；对 run.mjs 的 `command()` 一致；但 build/browser/security 不写这条记录（问题 2）。
   - 新增常量 `FAILED_TESTS_SHOWN`/`FAILURE_MESSAGE_LINES`/`FAILED_LOG_TAIL_LINES`/`REPORT_JSON_LIMIT_BYTES` 只在脚本和测试中使用，没有其他消费端。
   - stdout 新增输出：唯一会解析日志的是 gate 解析（`gate-log.mjs:30-31`），按行首匹配，`| ` 前缀可接受。

5. **`first` 排序有没有影响原有诊断顺序？**
   没有。只有 `renderFailedLogs` 传了 `first`；其他所有 `renderSummary` 调用使用默认 `first=()=>false`，`files` 就是 `listFiles` 的原路径序，诊断显示顺序不变。

6. **文档和代码是否一致？**
   不完全一致：ADR 第 4 条“放不下的文件只报数量”已过时；设计文档第 250 行“每个 `.log` 文件”与实际“只取登记为 `diagnostic` 的 `.log`”不一致；测试标题也过时。其余（30 条、20 行、120 行、64 KiB、`--failed-logs` 路径、`| ` 前缀、U+2028/2029）与代码一致。
