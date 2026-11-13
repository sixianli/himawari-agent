（已达到本代理的最大步数；以下为之前只读代码得到的完整结论，未再调用任何工具，也没有运行测试。）

# 复核结论

## 一、发现（按严重度从高到低）

### 1. 高（规范/决策）：把必过检查切到 ARM 与现行 ADR 0253 明确冲突，且没有替代 ADR

- 文件:行：`ci/policy.json:13/30/120`、`.github/workflows/ci.yml:33/72/284`、`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:61/65/82`
- 问题：代码把 policy/static/security 正式放到 `ci-arm`，但仓库里仍生效的 ADR 0253 明确拒绝这件事；本范围内 `docs/adr` 没有任何新增或修改。
- 证据（我读到的原文）：
  - `ci/policy.json:13`：`"runner": "ci-arm",`（static 在 30、security 在 120）
  - `.github/workflows/ci.yml:33`：`runs-on: ci-arm`（static 72、security 284）
  - ADR 0253:61：`ARM 不进 GitHub 必过检查，也不切线上。`
  - ADR 0253:82：`| 把 linux-arm64 加进 ci/policy.json 的必过检查 | 不采用 | 测试机可能被 Oracle 回收，不能让必过检查依赖它 |`
  - ADR 0253:65：`ci/toolchain-lock.json、ci/policy.json、scripts/ci/check-policy.mjs、scripts/ci/aggregate.mjs 和工作流文件不改。`
  - 新增测试却标成 `[ADR-0260]`（`test/tooling/policy.test.mjs:1223`），而 `docs/adr/0260-memory-classification-on-the-server.md:11` 是“记忆分类”，与此事无关。
- 建议：若 Andy 确已另行批准这次切换，新增 ADR（amend/supersede 0253），写明 Oracle 机器被回收时的 `alternateArch`/fallback 方案，并把测试标签改成正确编号；否则撤回第 4 项。只改代码不改 ADR，会让后来的人按 ADR 0253 的结论处理这台机器。

### 2. 中：Runbook 仍写“ci.yml 没有 ci-arm、ARM 只跑试跑、没有工作流传 --remote-jobs”

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:180`、`:195`
- 问题：作者说“删除 `.github/workflows/ci-arm-trial.yml` 及引用”，但引用没有删干净。
- 证据：
  - :180：`必过的 ci.yml 里还没有任务写 runs-on: ci-arm。这两个 runner 只跑试跑工作流 .github/workflows/ci-arm-trial.yml：……结论不进 ci/required，也不往共享目录交报告`
  - :195：`**报告怎样回到汇总作业（切换之后才用，现在没有工作流传 --remote-jobs）**`
  - 实际：`ci.yml:33/72/284` 是 `runs-on: ci-arm`，`ci.yml:362` 是 `--remote-jobs policy,static,security`，试跑工作流已删除。
- 建议：把该节改成“已切换”：必过检查在 ci-arm 上跑、报告写本机共享目录、汇总作业通过 `--remote-jobs` 取报告、ARM 不在时用 `arm-fallback.sh on`；删除“试跑工作流 / 现在没有工作流传”的旧句。

### 3. 中：“正式切到 ARM”在 gate 上不可验证，x64 fallback 仍算通过

- 文件:行：`scripts/ci/aggregate.mjs:102-103`、`ci/policy.json:13-16`、`docs/runbooks/ci-vps-runner-runbook.md:199`
- 问题：这是“架构被篡改时仍通过”的实际落点。`aggregate` 对 policy/static/security 接受 `member.arch`（x64）或 `member.alternateArch`（arm64）任一；而 `arm-fallback.sh on` 会把 `ci-arm` 标签加到 x64 的 ci-vps runner 上。因此报告由 x64 生成会通过；把报告 arch 从 arm64 改成 x64 也会通过；gate 无法区分“真在 Oracle ARM 上跑”与“fallback 到 x64”。任意第三种架构（如 ppc64）会被 `ci/result.schema.json` 的 arch enum 先拒，不会走到新比较。
- 证据：
  - `scripts/ci/aggregate.mjs:102`：`if (![member.arch, member.alternateArch].includes(result.toolchain.arch))`
  - `ci/policy.json:14-16`：`"arch": "x64", "alternateArch": "arm64"`
  - `test/tooling/aggregate.test.mjs:401-411` 明确要求 arm64 报告被接受。
- 建议：如果“正式切到 ARM”是要求而不是仅提高可用性，就不应继续接受 `member.arch`（或新增“实际 runner 标签/架构来源”的独立字段并强制 arm64）；如果 fallback 明确允许，就在 ADR/runbook/测试名里写清“x64 fallback 仍算通过”，不要用“架构被篡改”掩盖。当前测试和作者说法都默认接受这种互换。

### 4. 低：`commandFailure` 只测了格式化函数，没测 `execute` 是否真的用上它

- 文件:行：`scripts/ci/check-security.mjs:74-76`、`test/tooling/security-process.test.mjs:429-437`
- 问题：把 `execute` 里三行改回旧的 `SECURITY_COMMAND_UNAVAILABLE`，新测试仍然全绿，因为测试只直接调用 `commandFailure`。
- 证据：
  - `check-security.mjs:74-76`：
    - `assert(!result.error, commandFailure("ERROR", result.error?.code));`
    - `assert(result.signal === null, commandFailure("SIGNAL", result.signal));`
    - `assert(Number.isInteger(result.status), "SECURITY_COMMAND_UNAVAILABLE");`
  - 测试 :429-437 只断言 `commandFailure("SIGNAL", "SIGKILL")` 等返回值；`semgrep-process` 用例（`security-process.test.mjs:252-259`）只断言 `status` 和“有别的扫描器通过”，不检查 error 文案。
- 建议：加一条注入 `spawnSync` 返回 `{status:null, signal:"SIGKILL", error:...}` 的用例，断言最终报告/抛出的错误是 `SECURITY_CMD_SIGNAL_*`；把 `execute` 改回旧写法时该用例必须失败。

### 5. 低：作者引用的“唯一消费者”不对，`remote-share.mjs:132` 不消费 `SECURITY_CMD_*`

- 文件:行：`scripts/ci/remote-share.mjs:132`、`scripts/ci/check-security.mjs:725/767/880`、`scripts/ci/run.mjs:277`
- 问题：`remote-share.mjs:132` 校验的是 ARM 报告发送端 JSON 里的 `error` 字段，和 `SECURITY_CMD_*` 无关。真正会因数字被丢掉的是 `check-security.mjs` 和 `run.mjs` 里的 `^[A-Z_]+$`。
- 证据：
  - `remote-share.mjs:132`：`if (typeof value.error === "string" && /^[A-Z_]{1,40}$/u.test(value.error)) fail(...)`
  - `check-security.mjs:725`：`error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED",`
  - `run.mjs:277`：`${/^[A-Z_]+$/.test(entry.error ?? "") ? ` ${entry.error}` : ""}`
- 建议：去掉数字是对的（否则内部 `^[A-Z_]+$` 会退回通用错误），但把理由改成真实消费者；“长度 ≤40”目前没有实际约束方，属于自设限制，可保留但别说成 remote-share 的要求。

### 6. 低：同一类 U+FFFD 问题仍留在 HTTP 响应体和子进程 stdout，新门槛明确放过

- 文件:行：`scripts/model-review/gateway.mjs:590-592`、`:622-624`、`scripts/model-review/opencode-review.mjs:884-886`、`test/tooling/request-body-decoding.test.mjs:50`
- 问题：新门槛只保证“请求体”先收齐字节；复核网关读 Magpie 响应、读 opencode stdout 仍是 `+= chunk`，汉字跨 chunk 时同样会变 U+FFFD。不是本次回归，但“消除复核用例随机报历史被改”的目标在这两处仍可能复发。
- 证据：
  - `gateway.mjs:590-592`：`response.on("data", (chunk) => { body += chunk; });`（`postJson` 的 `text += chunk` 同理）
  - `opencode-review.mjs:884-887`：`stdout += chunk; pending += chunk; const lines = pending.split("\n");`
  - 新测试反向用例 :50：`expect(flagged('child.stdout.on("data", (chunk) => { output += chunk; });')).toBe(0);`（有意放过）
- 建议：如果目标只是请求体，在 I-82 的“未覆盖”里写明响应体/stdout 仍逐块解码；如果要彻底消除，改用 `Buffer.concat` 或 `setEncoding("utf8")`/`StringDecoder`，并扩展门槛（至少覆盖 `response.on("data")`，排除子进程 stdout 时要说明理由）。

### 7. 低：浏览器门槛只查“scripts 顶层没有直接监听”，不保证 7 个脚本真的接上 `watchPageErrors`

- 文件:行：`test/tooling/browser-page-errors.test.mjs:89-99`
- 问题：扫描用 `readdirSync(scriptsDirectory)`，只覆盖 `scripts/*.mjs`；正则只找 `.on("pageerror")`。如果某个脚本把 pageerror 收集整段删掉（既不直接监听，也不调用 `watchPageErrors`），测试仍通过；`scripts/ci/browser-observation.mjs:84` 和 `test/qualification/sandbox-production-browser.mjs:18` 也仍直接监听（前者只写 observation，不判失败，所以不是红 CI 的直接原因）。
- 证据：
  - `browser-page-errors.test.mjs:89-99` 只对顶层文件名做 `directPageErrorListener.test(...)`。
  - `scripts/ci/browser-observation.mjs:84`：`page.on("pageerror", (error) => { append({...}) });`
  - 我另外确认 `scripts/qualify-control-center-browser.mjs:157` 已用 `watchPageErrors` 收集失败，所以 browser 作业实际判红路径是覆盖到的。
- 建议：把门槛扩到 `scripts/**` 并对“只记录不判失败”的 observation 文件做显式 allowlist；或直接断言这 7 个脚本都 import/调用了 `watchPageErrors`，避免“删掉收集”也能过。

---

## 二、侧重检查

按错误路径、不可信输入、安全、资源耗尽、不可逆操作、规则/文档一致性逐项查过：

- **报告没取到**：`run-share.mjs:125-144` 对缺失只记入 `missing`，collect 命令本身仍 exit 0；但 `required.mjs:23-29` 把缺失成员交给 `aggregate`，`aggregate.mjs:174-178` 对每个缺失成员记 failure，`required.mjs:78-81` 以退出码 1 结束。结论：fail-closed，不会误绿。
- **报告取错**：`run-share.mjs:93-113` 的 `get` 复制后重算 `treeDigest` 并与 `needs` 输出的摘要比较，不一致就删副本并报 missing；`remote-share.mjs:124-156` 校验 `run/name`、文件路径、重复路径、大小上限。换一份内容或换一轮的报告都会被摘要/名称挡下。
- **远端输入不可信**：`parseRemoteReport` 有 `safeRelativePath`、文件数 500、单文件 16 MiB、合计 64 MiB、响应 96 MiB、SSH 2 分钟总时限；`pullRemoteReport` 先写 staging 再 rename，`flag:"wx"`（`remote-share.mjs:16-23/124-156/158-188`）。
- **架构被篡改**：见发现 3。schema 只允许 x64/arm64，任意第三种架构在 `validateRecord` 就失败；真正的“篡改”只在 x64↔arm64 之间，而两者按当前策略都是合法成员。
- **命令失败错误码**：`commandFailure` 去掉数字、只留 `A-Z_`、`slice(0,40)` 并去掉尾部下划线；detail 只来自 spawnSync 的 code/signal，没有注入风险。
- **不可逆操作**：`ci.yml:369-371` 的 `run-share.mjs remove` 仍 `always()` 执行；删除 `ci-arm-trial.yml` 本身不可逆，测试和 runbook 是主要残留（发现 2）。
- **规则/说明文档**：发现 1、2。I-82/I-101 的文档新增条目与代码一致；`.claude/rules/prompt-prefix.md` 没有受影响。
- **合并进来的 PR 478（job-host gateway control）**：抽查了 `job-host-gateway-control.ts` 的 `controlRoot` 校验、目录名正则、`path.dirname(directory) === controlRoot`、`realpath`/symlink 检查（`job-host-gateway-control.ts:26-47/82`、`job-host-gateway.ts:35-39/202-224`）；未发现明显的路径穿越。但生产代码里 `jobHostAccount`/`jobHostControl` 只在测试注入，`apps/agent-service/src/production-sandbox-control.ts:178` 默认 `localJobHostRiskControl()`，新 gateway 路径是否已在生产启用**未核实**，我也没有完整审计。

---

## 三、读代码证实 vs 推测

**读代码证实：**
- `ci/policy.json` 三处 runner 是 `ci-arm`；`ci.yml` 三处 `runs-on: ci-arm`，汇总步骤确实是 `--remote-jobs policy,static,security`。
- `check-policy.mjs:193-198` 的 `runnerLabelFor`、`:373-380` 的 `validatePolicy`、`:575-588` 的 collect 命令校验与新的 `armChecks` 一致。
- `aggregate.mjs:99-103` 对 node/os 精确比较，对 arch 允许 `[member.arch, member.alternateArch]`。
- `run-share.mjs` 的 collect 对缺失/摘要不符记入 missing；required/aggregate 会把 missing 判失败。
- 两处假模型服务器已改为 `Buffer.concat(chunks).toString("utf8")`；新测试 `request-body-decoding.test.mjs` 有真实分块送达用例和反向字符串用例。
- `browser-page-errors.test.mjs` 的扫描只覆盖 `scripts/*.mjs` 顶层；`scripts/ci/browser-observation.mjs` 仍直接 `page.on("pageerror")`。
- `security-process.test.mjs:429-437` 只测 `commandFailure` 本身。
- runbook 第 180/195 行仍写“没有 ci-arm / 只跑试跑 / 没有工作流传 --remote-jobs”。
- ADR 0253 仍 active、`superseded_by: ""`，第 61/82 行明确拒绝把 ARM 放进必过检查；ADR 0260 是记忆分类。

**推测/未核实：**
- 没有运行任何测试；“33 个用例仅因 Node 22.23.4 与 22.22.3 不同而失败”**未核实**。
- 没有在真实 CI/Oracle 机器上跑；remote-share 的 SSH、ARM 报告路径、fallback 行为只按代码推断。
- `gateway.mjs`/`opencode-review.mjs` 的响应体或 stdout 是否真的出现跨块汉字、是否已造成实际错误，**未复现**；只确认模式仍是 `+= chunk`。
- PR 478 的 job-host gateway 控制是否会在生产接线、是否有跨 job 的 control 目录写权限问题，**未完整审计**。

---

## 四、必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。**
不会。本范围改动落在：假模型服务器解码（测试工具）、浏览器检查脚本、`check-security.mjs`、CI policy/workflow。没有改 `packages/runtime-pi`、`packages/prompt-catalog`、出口遮盖、历史存储或提示词组装；没有任何新值被插入系统提示/工具定义。发给模型的内容仍然只在末尾追加；每轮会变的值仍应只在最后一条用户消息里（这部分没有改动）。依据：`.claude/rules/prompt-prefix.md:27-35`；本次 diff 不涉及这些代码路径。注：没有运行 `check:prompt-prefix`，这是代码层面的判断。

**2. 会不会让同一段文字在不同请求里变成不同的字节（依赖前后文的遮盖、带时间的字段、无序集合）？**
不会。解码修复把“逐块 toString”改成“收齐 Buffer 后一次 utf8 解码”，只会让观察端不再产生 U+FFFD，不会改变客户端实际发出的字节；也没有引入时间、随机数或依赖后文的值。CI 侧新增的值是固定字面量（`ci-arm`、`policy,static,security`），`publishedMembers` 还按名称排序（`run-share.mjs:115-123`）。遮盖逻辑未动。遗留的同类风险只在响应体/stdout（发现 6），那是“观察端仍可能被切坏”，不是“同一段文字被改成不同字节发给模型”。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
有，但完整度不一：
- 改动 1：`request-body-decoding.test.mjs` 有真实分块用例、仓库扫描和反向字符串；换回旧写法会使扫描和分块用例失败。但只覆盖“请求体 + request/req/incoming”这一种写法，响应体和子进程 stdout 被明确放过。
- 改动 2：`browser-page-errors.test.mjs` 有扫描和反向正则；把某个 `scripts/*.mjs` 改回直接监听会失败。但它不验证脚本仍调用 `watchPageErrors`，且只扫顶层。
- 改动 3：只有 `commandFailure` 的单元测试；把 `execute` 的接线改回去，测试不会失败（发现 4）。
- 改动 4：`policy.test.mjs` 覆盖了错误 runner、旧写法升级、`ci.yml` 的 `runs-on`、collect 命令；`aggregate.test.mjs` 覆盖了 arm64 被接受、build arm64 被拒。反向方面：`ppc64` 那条其实是 schema 先拒，不是新 arch 比较在起作用；真正有效的反向是 build arm64。没有 CI 级别的“远端报告缺失/失败 → required 失败”端到端用例，但 `remote-share.test.mjs` 和 `aggregate` 的单测覆盖了各段。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐个核对：
- `runner: "ci-arm"`：产生于 `ci/policy.json:13/30/120`；消费于 `check-policy.mjs:193-198`（`runnerLabelFor`）、`:373-380`（`validatePolicy`）、`:527-531`（`ci.yml` 单作业 `runs-on`）、`run.mjs:70-71`；全部接受。`ci/policy.schema.json:64` 的 enum 也已加入。
- `alternateArch: "arm64"`：消费于 `validatePolicy:377`、`run.mjs:71`、`aggregate:102`、`aggregate.test.mjs:401-416`；全部接受。`ci/result.schema.json` 的 arch enum 只允许 x64/arm64，第三方架构会被 schema 拒。
- `--remote-jobs policy,static,security`：产生于 `ci.yml:362` 和 `check-policy.mjs:578` 的精确字符串；消费于 `run-share.mjs:152-159/177-188`、`remote-share.mjs:35-47/158-188`；接受。
- `SECURITY_CMD_*`：产生于 `check-security.mjs:57-64`；消费于 `check-security.mjs:725/767/880` 和 `run.mjs:277`，两处都是 `^[A-Z_]+$`，去掉数字是必要的；长度 40 目前没有真实消费者（作者引用的 `remote-share.mjs:132` 不消费它）。
- 删除 `ci-arm-trial.yml`：`run.mjs:251-256` 和测试已更新，但 `docs/runbooks/ci-vps-runner-runbook.md:180/195` 仍引用（发现 2）。
- `watchPageErrors` 的 7 个调用点：导入路径 `./browser-page-errors.mjs` 相对于 `scripts/` 正确，签名 `(page, onError)` 与实现一致。
- 结论：代码层的消费者都接受新值；不接受的只有文档/ADR，以及“用 ARM 作为必过架构”这一目标本身。

---

## 五、作者说法核对

- “四处改动”：不准确。范围内还包含 PR 478 的 runtime-sandbox/job-host gateway 合并（`b839a239d`），未列入四处。
- “删除 `.github/workflows/ci-arm-trial.yml` 及引用”：文件删了，但 runbook 第 180/195 行仍引用，且仍写“没有工作流传 `--remote-jobs`”。
- “remote-share.mjs 第 132 行只接受 `^[A-Z_]{1,40}$`”：行号对，但该行不是 `SECURITY_CMD_*` 的消费者；真实消费者是 `check-security.mjs` 与 `run.mjs` 的 `^[A-Z_]+$`。
- “ci/policy.json 的 runs-on 改为 ci-arm”：policy.json 里的键是 `runner`，`runs-on` 在 ci.yml；代码结果一致，只是措辞。
- “aggregate.mjs 的架构检查改成允许成员的 arch 或 alternateArch”：属实（`aggregate.mjs:102-103`）。
- “check-policy.mjs 校验 collect 命令与 armChecks 一致，旧写法自动升级成 ci-arm”：属实（`:200-225`、`:575-588`）。
- “policy.projects 仍是 `["tooling"]`”：属实。
- “测试里 33 个用例仅因本机 Node 22.23.4 与锁定的 22.22.3 不同而失败”：**未核实**（未运行测试）。

---

## 六、总体结论与建议

就“报告没取到/取错”而言，现有代码是 fail-closed 的：缺失或摘要不符最终都会让 `ci/required` 失败，没有找到能让必过检查误绿的逻辑缺口。主要问题是：

1. 第 4 项与现行 ADR 0253 和 runbook 冲突，缺少决策记录（高）。
2. “正式切到 ARM”的意图在 gate 上不可验证，x64 fallback 仍算通过（中）。
3. `commandFailure` 的接线没有反向测试（低）。

建议下一步：先补一份 supersede/amend ADR 0253 的决定并更新 runbook；明确“x64 fallback 是否允许”；给 `execute` 的失败路径加一条会真实失败的反向用例；再决定是否要把这三项的 `aggregate` 架构检查收紧为 arm64。

**未完成的剩余工作**：运行本机/快速测试确认 33 个失败用例的说法；在真实 CI 上验证 remote-share 拉取路径；完整复核合并进来的 PR 478 runtime-sandbox 代码；核实生产是否已接线 `jobHostControl`/`jobHostAccount`。
