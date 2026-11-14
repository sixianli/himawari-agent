## 结论

未发现高严重度问题；有两项中等问题（ADR 修订关系两端不一致、安全测试没有真正测到“被信号杀掉”的分支），其余是测试覆盖与文档细节的缺口。下面均按“读代码证实”和“推测/未核实”分开。

---

## 一、读代码证实的发现

### 1. 中：ADR 0266 声称修订 0253/0238，但目标 ADR 完全没动，`amends` 还漏了 0238

**文件:行**：`docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:7`、`:38`；`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:61,82`；`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:9,92`

**问题**：作者说“修订 ADR 0253 第 61、65、82 行和 ADR 0238 第 92 行”，但 `git diff 61984fb..HEAD -- 0253 0238` 输出为空，两个文件一字未改。ADR 0266 自己的元数据只写了：

```yaml
amends: "docs/adr/0253-support-linux-arm64-for-test-and-qualification.md"
```

而正文第 38 行又说“这份 ADR 同样修订这一条”（指 0238），即 `amends` 连正文声称的 0238 都漏了。结果是被修订的两份 ADR 仍原样写着相反的决定，且没有 `amended_by` 反向指针：

```md
61: 把 linux-arm64 作为测试和资格验收用的平台支持起来……ARM 不进 GitHub 必过检查，也不切线上。
82: | 把 linux-arm64 加进 `ci/policy.json` 的必过检查 | 不采用 | 测试机可能被 Oracle 回收，不能让必过检查依赖它 |
```

```yaml
# docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:9
amended_by: "docs/adr/0241-draft-prs-skip-ci-and-merge-waits-for-green.md"
```

仓库自己的约定见 `docs/adr/0031-isolated-tool-execution.md:139`：“采用双向 `amends` / `amended_by` 元数据及正文范围链接”。

**建议**：在 ADR 0266 的 `amends` 里补 0238；给 0253 加 `amended_by` 指向 0266，给 0238 的 `amended_by` 追加 0266；或在 0266 中明确写出“0253/0238 的旧正文保留，但冲突范围以 0266 为准”并确保反向指针存在。

---

### 2. 中：新增的安全测试没有测到“被信号杀掉”的分支，作者对预期错误码的说法与代码相反

**文件:行**：`test/tooling/security-process.test.mjs:167-168`、`:260-267`；`scripts/ci/check-security.mjs:74-75`

**问题**：夹具同时设置了 `error` 和 `signal`：

```js
if (state.mode === "semgrep-process")
  return { status: null, signal: "SIGKILL", error: new Error("synthetic kill") };
```

而 `execute` 先执行：

```js
assert(!result.error, commandFailure("ERROR", result.error?.code));
assert(result.signal === null, commandFailure("SIGNAL", result.signal));
```

因为 `new Error("synthetic kill")` 没有 `code`，第一条断言先抛出 `SECURITY_CMD_ERROR_UNKNOWN`，测试通过。真正的“只有信号、没有 error”的路径会走到第二条断言，得到的是 `SECURITY_CMD_SIGNAL_SIGKILL`，不是测试期望的 `SECURITY_CMD_ERROR_UNKNOWN`。因此：

- 测试名“扫描器被信号杀掉时……”与实际覆盖的分支不符；
- 删掉 `assert(result.signal === null, ...)` 这一行，该测试仍然通过，不能防信号处理回归；
- 作者“信号杀掉时错误必须是 `SECURITY_CMD_ERROR_UNKNOWN`”的说法，对真实信号路径是错的。

**建议**：增加一个只设 `signal: "SIGKILL"`、`error: null` 的夹具分支，断言 `SECURITY_CMD_SIGNAL_SIGKILL`（或统一改成真正的 UNKNOWN）；现有同时带 error 的夹具保留为“未知 error code”用例，并改掉测试名。

---

### 3. 低：`setEncoding("utf8")` 没有回归测试，且同类问题在 stderr 上仍然存在

**文件:行**：`scripts/model-review/gateway.mjs:590,623,770`；`scripts/model-review/opencode-review.mjs:884,908`；`test/tooling/request-body-decoding.test.mjs:26-27,50`

**问题**：网关响应和 opencode stdout 的改动本身正确。但现有门槛明确只扫请求体：

```js
const isRequestHandler = (source, offset) =>
  /\b(?:request|req|incoming)\s*$/u.test(source.slice(...));
```

反向用例甚至断言子进程 stdout 的旧写法不应被扫出：

```js
expect(flagged('child.stdout.on("data", (chunk) => { output += chunk; });')).toBe(0);
```

因此这次两处修复没有自动检查；`docs/incidents-and-gates.md` 的 I-82 行也如实写了“门槛不扫这两类，复发要靠代码复核”。另外同类读取仍未统一解码：

- `opencode-review.mjs:908` 的 `child.stderr.on("data", (chunk) => { stderr += chunk; })` 没有 `setEncoding`；
- `gateway.mjs:770` 的 `child.stderr.on("data", (chunk) => { stderr = \`${stderr}${chunk}\`.slice(-4000); })` 也没有。

这不会影响发给模型的请求，但同一类“多字节字符被切块”的损坏仍可能出现在错误诊断里。

**建议**：给两个 stderr 也加 `setEncoding("utf8")`；在 I-82 门槛里增加“响应/子进程输出”一类扫描，或明确接受只靠复核。

---

### 4. 低：`CI_HOST_LOAD` 在部分失败路径不会输出，且定时器在这些路径上不会被 stop；测试只覆盖格式化

**文件:行**：`scripts/ci/run.mjs:587,598,96,136,513-548`；`scripts/ci/host-load.mjs:24-26`；`test/tooling/runner-orchestration.test.mjs:790-806`

**问题**：正常路径和普通检查失败路径没问题，因为 `runCheck` 的 `try/catch`（`run.mjs:136`、`:513`）会吞掉检查失败并返回结果。但 `runCheck` 在进入 `try` 之前还会抛错，例如：

```js
if (existsSync(directory)) throw new Error("CI_OUTPUT_ALREADY_EXISTS");
```

这种路径下 `main` 的 `stopHostLoad()`（`:598`）不会执行：既不会写 `CI_HOST_LOAD`，15 秒定时器也不会被 `clearInterval`。因为 `host-load.mjs:25` 调用了 `timer.unref()`，进程仍能退出，不会挂住作业；但“每个检查作业结束时都写一行”的说法在这些基础设施失败上不成立，而这类失败恰恰是想观察负载的时候。

测试只直接调用 `startHostLoad` 并断言字符串格式，没有覆盖：

- `run.mjs` 成功/失败时是否真的输出该行；
- `stop()` 是否清掉定时器；
- `runCheck` 抛错时是否仍能输出/清理。

**建议**：用 `try/finally` 包住 `runCheck`，在 `finally` 里 stop 并输出；补一个 `runCheck` 抛错时仍输出 `CI_HOST_LOAD` 的用例，以及 stop 后不再采样的用例（可用 fake timer）。

---

### 5. 低：浏览器门槛新增的“必须调用 watchPageErrors”没有反向用例，判定比名字宽

**文件:行**：`test/tooling/browser-page-errors.test.mjs:117-126,129-134`

**问题**：新判定是：

```js
/\.launch\(/u.test(source) &&
!OBSERVE_ONLY.has(path) &&
!/watchPageErrors|collectPageErrors/u.test(source)
```

`/watchPageErrors|collectPageErrors/` 只看标识符是否出现在文件任意位置，单纯 `import { watchPageErrors } ...` 而不调用也会通过，与测试名“都调用”不符。`.launch(` 也匹配不到 `.launchServer(`、`.launchPersistentContext(` 或 `.launch (`。现有反向用例 `:129-134` 只测旧的 `directPageErrorListener` 正则，没有构造一个“启动浏览器但不调用 watch”的样本验证新判定会失败。

**建议**：反向用例直接喂一段 `chromium.launch(...)` 且不含 `watchPageErrors` 的源码给新判定，断言被识别；正则至少覆盖 `launchServer`/`launchPersistentContext`，并要求是调用而非仅 import（例如匹配 `watchPageErrors(` / `collectPageErrors(`）。

---

### 6. 低：ADR 0266 前提 6 的行号写错

**文件:行**：`docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:41`；`ci/policy.json:14-16`

**问题**：ADR 说“`ci/policy.json` 第 14、16 行，原话 `"arch": "x64"`、`"alternateArch": "arm64"`”。实际：

```json
14:           "os": "linux",
15:           "arch": "x64",
16:           "alternateArch": "arm64",
```

第 14 行不是 `arch`，应为第 15、16 行。

**建议**：改成“第 15、16 行”。其余引用我逐条核对过：0253 的 61、65、82 行，0238 的 92 行，`ci.yml` 的 33、72、284、362 行都与 ADR 0266 的引用一致。

---

### 7. 低：ADR 0253 第 65 行“ARM 工具链放独立锁文件”与现状不一致，ADR 0266 未记录这一变化

**文件:行**：`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:65,83`；`ci/toolchain-lock.json:23,75,133,158,1102`

**问题**：0253 写着“ARM 的工具链放在独立的锁文件里……`ci/toolchain-lock.json`……不改”，选项表还说“把 ARM 条目直接加进 `ci/toolchain-lock.json` 不采用”。但现状是仓库只有 `ci/toolchain-lock.json` 一个锁文件，里面已有 `linux-arm64` 的 Node、Python、actionlint、gitleaks、Semgrep wheel。这是改动前就存在的偏差，但 ADR 0266 声称修订 0253 第 65 行时只引用了“文件不改”那一句，没有记录“实际已把 ARM 条目放进主锁文件”。

**建议**：若这是有意的，应在 ADR 0266 或单独 ADR 中写明该决定已变更，并同步 0253 的 `amended_by`；否则应恢复独立锁文件。

---

## 二、推测 / 未核实

- **未核实**：Oracle ARM 上两个 runner 是否在线、三项检查真实时长和失败率。ADR 0266 前提 7 自己也标了“未核实”；我只能读代码确认 `runs-on: ci-arm` 和远端取报告的代码存在，无法确认机器状态。
- **未核实**：作者说本机 Node 22.23.4 下改动前已有 33 个用例失败、改动后无新增。环境里不能运行测试，我没有复现这一比对。
- **推测**：`CI_HOST_LOAD` 目前没有机器消费者，只进作业日志；若将来有人把作业日志喂给模型，其中的负载、耗时是每轮不同的值。但这属于复核/诊断数据，不在产品模型请求里，当前不构成 prompt-prefix 问题。

---

## 三、侧重检查

- **错误路径**：检查了 `runCheck` 的异常边界（见发现 4）、安全扫描器的 signal/error 分支（发现 2）、网关和 opencode 子进程的 stderr 解码（发现 3）。普通检查失败不会漏 `CI_HOST_LOAD`；`runCheck` 进入 try 之前的抛错会漏。
- **不可信/不合规范输入**：浏览器门槛的文件列表来自 `git ls-files`，路径由 Git 索引提供，未接受用户输入，未发现路径穿越风险；`OBSERVE_ONLY` 五个路径都存在且精确匹配。`setEncoding` 处理的是上游/子进程输出，属不可信输入，按 UTF-8 统一解码是正确的。
- **安全**：本增量没有扩大网络面；远端取报告的 ssh 限制、只读钥匙等代码未改。ADR 中“ARM runner 账号读不到测试数据”的说法属于基础设施保证，未核实。
- **资源耗尽**：`host-load` 每 15 秒采样一次，`timer.unref()` 且正常路径 `clearInterval`，不会阻止进程退出；没有新增无界累积。`git ls-files` 只在测试中同步执行一次。
- **不可撤销操作**：本增量没有新增删除、覆盖、上传等不可撤销操作。
- **规则/文档/代码一致**：发现 1、6、7 是文档与代码/元数据不一致；ADR 0266 的其余来源行号和 `ci.yml`、`policy.json` 引用核对通过。

---

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   **不会（就本增量而言）。** 本增量没有改 `apps/`、`packages/` 里的产品请求组装，也没有改系统提示、工具定义、历史或遮盖逻辑。唯一与模型调用有关的是复核脚本读取上游响应和 opencode 子进程输出，这属于“读结果”，不是“改请求”。因此对现有会话而言，仍然是只在末尾追加，每轮变化的值仍只在最后一条消息里；复核脚本本身另有 ADR 0178 的 prompt-prefix 例外，但这次改动不依赖它。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   **不会。** `setEncoding("utf8")` 只是让响应/子进程输出按 UTF-8 正确解码，修复的是被切块汉字变成 U+FFFD 的问题，反而减少了不一致。`CI_HOST_LOAD` 里的负载、内存、秒数是每次不同的值，但只写进 CI 作业日志，不进入模型请求。ADR 日期固定，未引入依赖遍历顺序的集合。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   - 策略/汇总/测试标签：有对应测试，且既有断言覆盖了“写回 ci-vps、coverage 上 ARM、`--remote-jobs` 缺失/不全”等反向情况。
   - `setEncoding`：**没有**；I-82 门槛明确只扫请求体，且反向用例把子进程 stdout 排除在外。
   - `CI_HOST_LOAD`：只有格式化单测，**没有** `run.mjs` 集成测试、定时器清理测试，也没有异常路径反向用例。
   - 浏览器新门槛：旧 `directPageErrorListener` 有反向用例；**新的“启动浏览器必须调用 watch”没有反向用例**。
   - 安全信号用例：**有测试但测不到信号分支**，删掉信号断言仍会通过。
   - ADR 行号/修订元数据：没有自动检查，本次也确实有一处行号错误和两处修订关系缺失。

4. **每个新产生/修改的值，两端的产生处和使用处都能接受吗？**
   - `startHostLoad` 的导出和参数：产生于 `host-load.mjs`，使用于 `run.mjs:587` 和测试；默认参数与测试显式参数一致，格式断言与实现一致。
   - `CI_HOST_LOAD` 字段：目前只有测试作为消费者，测试精确匹配实现输出，没有后端校验问题。
   - `OBSERVE_ONLY` 五个路径：与 `git ls-files` 产出的仓库相对路径一致，均存在。
   - `[ADR-0266]` 标签：ADR 0266 存在，改名后测试中已无残留 `[ADR-0260]`（该编号现在是记忆分类 ADR，原标签本来就是错的）。
   - ADR 修订关系：**两端不一致**——0266 的 `amends` 漏 0238，0253/0238 没有指向 0266 的 `amended_by`，这是本次最明确的“产生端/消费端不一致”。
   - ADR 0266 前提 6：行号 14 与 `ci/policy.json` 实际内容不符。
