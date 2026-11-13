## 结论

这次改动（`isError: false` → `result.isError === true`）方向正确：它把 Pi 1.5.0 原生返回的失败标记传下去，使前台命令的非零退出码能经过 `formatForegroundPiResult` → runner 进程退出码 → 宿主 `termination.exitCode` → `failedCommandModelContent` 这条链，恢复 R2-T14 设计的失败提示。未发现高/中严重度的代码缺陷。以下按严重度列出我亲自读代码确认的问题，以及未核实/推测的点。

---

## 一、读代码证实的问题

### 1（低）`write` 的成功文案覆盖没有用 `isError` 约束，可能与新传播的 `isError: true` 自相矛盾

- 文件:行：`packages/runtime-pi/src/sandboxed-coding-executor.ts:69-80`
- 问题：只要 `name === "write"` 且参数里 `content`/`path` 是字符串，就无条件把 `content` 换成“Successfully wrote …”，而此时返回的 `isError` 现在会被设成 `result.isError === true`。若 Pi 的 write 将来（或某条路径）以“正常返回 + `isError: true`”报失败，模型会看到“成功写入”的文案，同时 runner 退出非零、宿主按写失败处理。
- 证据：
  ```ts
  const content =
    input.name === "write" && typeof written.content === "string" && typeof written.path === "string"
      ? [{ type: "text" as const, text: `Successfully wrote ... bytes to ${written.path}` }]
      : result.content;
  return { ...result, content, isError: result.isError === true };
  ```
  该覆盖只判断参数，不判断 `result.isError`。作者说 Pi 1.5.0 的 write 失败一律抛错（走 catch，`isError: true` 且内容为错误消息），所以当前不触发；这属于潜在的健壮性问题。
- 建议：把覆盖条件加上 `result.isError !== true`，或补一条“write 正常返回但 `isError: true`”的用例来锁定行为。

### 2（信息）新增“生产边界”用例并未真正跨过 runner/宿主，只是按同样的顺序手工组合

- 文件:行：`apps/agent-service/test/production-foreground-result.unit.test.ts:438-495`
- 问题：作者称“经 executeSandboxedPiCodingTool → formatForegroundPiResult → failedCommandModelContent”断言生产边界，但用例是手工调用这三个函数；真正受影响的链路还包括 `writeForegroundPiResult` 设置 `process.exitCode`（`apps/agent-service/src/capability-programs/pi-foreground-result.ts:7-9`）和宿主读 `termination.exitCode`（`apps/agent-service/src/production-sandbox-services.ts:2104-2112`）。这段测试无法发现这两环的回归。
- 证据：
  ```ts
  const result = await executeSandboxedPiCodingTool({...});
  const formatted = await formatForegroundPiResult({ tool: "bash", result, commandExitCode, ... });
  const notice = failedCommandModelContent(formatted.output, { operation: "bash", processExitCode: 3 });
  expect(notice).toContain("命令执行失败：命令以退出码 3 结束");
  ```
- 影响有限：我另外读到 `apps/agent-service/test/pi-coding-program.unit.test.ts:399-408` 已覆盖“工具失败/命令退出码 → 进程退出码”的映射，`test/integration/product-path-browser.test.ts:1979-1996,2015-2027` 覆盖真实产品路径（但默认 `describe.skip`）。
- 建议：把这条用例的描述改成“执行器 + 前台格式化 + 提示函数”，或补一条经过 `writeForegroundPiResult`/子进程的真实用例，避免“生产边界已直接断言”的说法误导后续维护者。

### 3（信息）I-96 把 Pi 1.5.0 的 bash 行为标成“已确认”，但本环境无法核对；新增 compat 用例也没有和 native Pi 对比

- 文件:行：`docs/incidents-and-gates.md:132`、`packages/runtime-pi/test/sandboxed-coding-executor.compat.test.ts:75-95`
- 问题：文档写“已确认……Pi 1.5.0 的 bash 工具……`bash.js` 的 `if (exitCode !== 0)` 分支”，但本检出没有 `node_modules`，无法复核该源文件。新增 compat 用例的注释说“as Pi's bash tool does”，但它只是用桩 `executeCommand` 返回 `{ exitCode }`，断言执行器与 Pi 的结果；它没有像同文件 `nativePiBashFailureText`（第 54-73 行）那样与真实 `createBashTool` 对比非零退出的输出。因此它锁的是执行器行为，不是“与 Pi 相同”这句话。
- 建议：要么加一条对照 native Pi 的非零退出用例，要么把文档/注释改成“按作者在云端核对的结果”并保留未核实标记。

---

## 二、推测/未核实

1. **（推测，低）isError 传播是全工具的，非 bash 工具的行为未核实。** `executeSandboxedPiCodingTool` 对 `read`/`find`/`grep`/`ls` 同样采用 `result.isError === true`。对于 `fixed_read` 契约，`isError:true` 会让 runner 退出 1，宿主在 `production-sandbox-services.ts:2104-2119` 把结果记为 error（`sandboxFileOperationFailureReason`）。如果 Pi 的 grep/find 对“无匹配/跳过不可读文件”返回 `isError:true`（现有宿主实现 `packages/runtime-pi/src/host-read-only-executor.ts:287,303,472` 明确返回 `isError:false` + `No matches found`/`(empty directory)`），就会出现宿主路径与沙箱路径不一致。作者只核对了 write/edit/read，未提 grep/find/ls；本检出无 Pi 源码，无法确认。建议补一条经 `executeSandboxedPiCodingTool` 的 grep/find 无匹配用例，断言 `isError:false`。
2. **未核实**：作者所述 Pi 1.5.0 源码、以及“本机 12 秒/CI 30 秒超时”“50 条通过”“63 秒降到 13 秒”等数字，本环境无法运行/无 node_modules，未验证。
3. **未核实**：`.agents/reviews/pr-465/**` 新文件因稀疏检出不在工作区，无法检查是否含会被 I-86 密钥扫描命中的样例。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、文档一致性）

- **错误路径**：非零退出、超时、输出上限、write 失败、envelope 不匹配都有回退；`failedCommandModelContent` 校验 `schemaVersion`、`tool`、`isError === true`、`commandExitCode`（null→1，仅接受 1..255）、已有 `effectNotice` 时拒绝（`production-sandbox-tool-result.ts:82-118`），属于 fail-closed，未发现新漏洞。
- **不可信输入**：退出码来自运行进程且由 `job-host-main.ts:867-877` 限制为 0..255 的整数；`commandExitCode` 非法时 `failedCommandModelContent` 返回 null，回退固定文案。新增测试里的 `spawn` 只跑固定字符串，无注入面。
- **安全**：`effectNotice` 只在严格匹配后注入，不放松遮盖；命令输出仍走既有的出口遮盖。未发现新的泄露路径。
- **资源耗尽**：生产路径仍读有上限的 artifact；新测试命令输出极小且无循环；未新增无界缓冲。
- **不可撤销操作**：本改动只改“报告成功/失败”，不新增写、删、重试；`projection`/`journal` 逻辑未变。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 的“只追加、变化值放最后”未被破坏（见必答 1）。I-96 行与代码基本一致；`sqlite-run-dispatch-lease.test.ts` 的期望改动与 `2c46ca42` 把 `RUNTIME_ATTEMPT_INTERRUPTED` 加入 `RUN_EXPIRED_RECONCILIATION_SQL`（`sqlite-sandbox-tool-result-recovery.ts:72`）一致；`workspace-lifecycle-audit.test.ts` 改用 SHA-256 比较仍是等价的内容比较。

---

## 四、必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。改动只影响新产生的那条工具结果（当前轮末尾追加的 `toolResult`）；系统提示、工具定义、历史消息、已存遮盖结果都没有被重新计算。非零退出码（每轮会变的值）只出现在这条新追加的工具结果里，没有进入系统提示/工具定义/历史中间。符合“发给模型的内容只追加、会变的值放最后一条消息”。（依据：`.claude/rules/prompt-prefix.md:27-35`。）

2. **同一段文字在不同请求里会不会变成不同字节？**
   不会因本改动而变。`isError` 只由该次命令结果的退出码决定；`failedCommandModelContent` 只对这段输出文本和退出码做确定性解析/序列化（`effectNotice` 固定放在最前，其余键沿用 `JSON.parse` 保留的原顺序），没有时间、随机数或无序集合。旧历史里的工具结果已持久化，不会因新代码重新计算而改字节。

3. **有没有自动检查，反向用例是否真的会失败？**
   有。`sandboxed-coding-executor.compat.test.ts:75-95` 断言 exit 3 → `isError:true`、exit 0 → `false`；`production-foreground-result.unit.test.ts:485-495` 断言真实 bash 的 `isError:true`、`formatted.exitCode === 3` 和提示文案。把第 80 行改回 `isError:false`，这两处首个断言按逻辑都会失败（未能在此环境运行测试）。补充：`pi-coding-program.unit.test.ts:399-408` 覆盖退出码到进程退出码的映射，但新增“生产边界”用例本身没有跨进程/宿主（见问题 2）。反向失败的前提是 Pi 1.5.0 确实“正常返回 `isError:true` 而非抛错”——这一点本环境无 node_modules 未核实；若 Pi 仍抛错，原 catch 已返回 `isError:true`，新用例将无法区分第 80 行的改动。

4. **改动产生/修改的每个值，使用方都能接受吗？**
   主要值是 `isError`（布尔）及其序列化进 `pi-result.v1` 的 `isError` 字段。逐个核对：
   - `packages/platform-node/src/files/pi-host-publication.ts:97` 原样写入 envelope；`:110-114` 用它算 `exitCode`，接受布尔。
   - `apps/agent-service/src/capability-programs/pi-coding-request.ts:234` 用 `result.isError` 映射 1/0，`:245` 用 `result.isError` 决定 `writeNotStarted`，接受布尔；但 `write` 文案覆盖处有自相矛盾风险（问题 1）。
   - `apps/agent-service/src/capability-programs/pi-foreground-result.ts:9`、`pi-coding-main.ts:32`、`pi-resident-runner.ts:79` 把 `exitCode` 交给进程/帧；`packages/runtime-sandbox/src/job-host-main.ts:867-877` 只接受 0..255 的整数，`formatForegroundPiResult` 已把范围外映射为 1，两端一致。
   - `production-sandbox-tool-result.ts:61-69,82-118` 要求 envelope `isError === true` 且 `commandExitCode` 与 `processExitCode` 一致，`result.isError === true` 正好满足；不一致时回退固定文案。
   - `production-runtime-tools.ts:2164-2188` 用匹配结果生成详细提示，接受。
   - `pi-runtime-adapter.ts:390`、`pi-native-history.ts:54` 要求 `isError` 是布尔；`pi-tool-progress-guard.ts:72-80` 接受布尔。均能接受。
   结论：没有使用方拒绝 `true`；唯一需要留意的是 `write` 成功文案与 `isError:true` 的语义冲突，以及非 bash 工具 `isError:true` 的语义差异（推测项）。
