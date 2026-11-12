## 结论

改动主体（产物→日志/作业摘要）方向可行；我读到的代码里，**轻量确认的信任边界没有被削弱**：真正能改 `scripts/ci/required.mjs` 或 `ci.yml` 的 PR，合并到 main 时会被 `pushIdentity` 的“验证目录未变化”检查挡下，改走完整 CI。但有 1 个应改的安全/健壮性问题（汇总结论里的失败原因未遮盖、未转义），以及若干文档与代码不一致。

---

## 读代码证实的问题（按严重度）

### 中-1 `scripts/ci/required.mjs:44`：作业摘要表的“原因”列没有经过 `cell` 遮盖/转义

证据（我读到的原文）：

```js
const cell = (value) => redactText(String(value)).replace(/[\p{Cc}|`]/gu, " ");

const rows = summary.checks.map(
  (check) =>
    `| ${cell(check.checkId)}/${cell(check.matrixKey)} | ${cell(check.status)} | ${check.reasons.join("；") || "-"} |`,
);
```

`checkId`、`matrixKey`、`status` 都过了 `cell`，唯独最可能包含任意外来文本的 `reasons` 没有。`reasons` 来自 `aggregate` 的失败原因，其中包含 PR 报告里可控的路径，例如 `scripts/ci/aggregate.mjs:141` 的 `Unsafe report path: ${report.path}`、`aggregate.mjs:147` 的 `Missing or modified evidence: ${report.path}`，以及 `aggregate.mjs:69` 的 `error.message`。这些内容会直接写进 GitHub 作业摘要，可造成：
- 未遮盖的密钥样字符串进入公开仓库的 job summary；
- `|`、换行、控制字符破坏 Markdown 表格，甚至伪造行；
- 与 `ci-summary.mjs` 的“先 redact 再截断”策略不一致。

建议：改成 `cell(check.reasons.join("；") || "-")`，并加一个回归用例：原因里带 `ghp_...`、`|`、换行时，摘要必须被遮盖且表格不被破坏。

### 中-2 设计文档仍声称“报告和诊断只在 GitHub 保留 1 天”，与 ADR 0243/工作流矛盾

`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:320` 仍写：

> 完整报告和诊断 screenshot/trace 都只在 GitHub 上保留 1 天（2026-11-06 起，原为 30 天和 7 天，见 ADR 0174）……

但本 PR 后 `.github/workflows/ci.yml`、`quality.yml`、`main.yml` 已没有任何 artifact 上传/下载。同文件 `:250`、`:262`、`:274` 也仍以“上传 artifact”“artifact 上传失败”“artifact 元数据读取”为现行规则。这些与 ADR 0243 决定 1/4/6 直接冲突，属于作者所说的“设计文档已同步”未做到。

另外，`docs/adr/0243-ci-uses-no-github-artifacts.md:58` 说“完整报告仍在 CI 服务器的共享目录里”，但 `quality.yml:44-49` 只做 `publish` + 两次 `ci-summary`，没有 `run-share.mjs put`；quality 的完整报告在作业结束后并不在共享目录，也没有其他持久位置。ADR 这句话至少对 `quality.yml` 不成立。

建议：把上述段落改为“完整报告不再上传 GitHub；ci.yml 的完整报告在共享目录，质量检测只保留作业摘要（最后 40 行/64 KiB）”，或明确 quality 报告是否仍需保留并补上共享目录步骤。

### 低-1 `scripts/ci/ci-summary.mjs:60`：先整文件读入内存，再判断二进制和只取尾部

证据：

```js
const tail = textTail(readFileSync(file.full));
```

`textTail` 只有在读完整文件后才检查前 8192 字节是否有 NUL。`publish.mjs` 会把 `.png/.zip/.jpeg/.webp` 诊断文件原样复制进 `.ci-output/public/`，并没有对单个诊断大小设上限。PR 代码可以生成很大的 trace/截图，`ci-summary` 在自托管 runner 上会整文件读入内存，存在内存耗尽风险。

建议：先 `stat`，超过硬上限（例如几 MiB）直接按“二进制/过大不显示”处理；文本文件只读头部样本和尾部 N 字节，或流式取尾部。

### 低-2 `scripts/ci/ci-summary.mjs:66-70`：超出上限的提示可能不准确

```js
const footer = `其余 ${files.length - shown} 个文件超出 ${limit} 字节的摘要上限，没有显示。\n`;
if (used + Buffer.byteLength(section) + Buffer.byteLength(footer) > limit) {
  sections.push(footer);
  break;
}
```

判断时把 `footer` 也算进去了。如果某个文件本身能放下，但加上 `footer` 后超限，就会显示 0 个文件并说“其余 N 个文件超出上限”，而真实原因是 footer 把预算挤爆；提示与实际不符。

建议：先判断 `used + section > limit`，再决定是否追加 footer；只在确实还有未展示文件时写 footer。

### 低-3 `scripts/ci/main-evidence.mjs:162-170`：只统计“成功的 ci/required”，不是“唯一的 ci/required 作业”

```js
const gates = jobs.jobs.filter(
  (job) =>
    job.name === "ci/required" &&
    ...
    job.status === "completed" &&
    job.conclusion === "success",
);
assert(gates.length === 1 && positive(gates[0].id), "MAIN_GATE_JOB_REQUIRED");
```

如果同一 attempt 里有两个同名 `ci/required` 作业、一个成功一个失败，代码会接受成功那个；文档/作者说法是“只认唯一一个名字是 ci/required 的作业”。实际风险很低：任何新增同名作业都要改 `ci.yml`，而这类 PR 合并时 `pushIdentity` 会因 `.github`/`ci`/`scripts/ci` 变化强制走完整 CI。但代码与文档不一致，且测试没有“一个成功一个失败”的反向用例。

建议：先按名字过滤，断言只有一个，再要求该作业结论为成功；补上对应测试。

### 低-4 `docs/adr/0243-ci-uses-no-github-artifacts.md:57`：“两次结果不一致时确认失败”没有对应实现

ADR 决定 3 写：

> 确认作业……自己再跑一次 `main-evidence.mjs discover`，`main-confirm.mjs` 照旧再核对一遍；两次结果不一致时确认失败。

代码里确认作业只重新 `discover` 并验证**自己取到的那一份**；plan 的 `candidate.json` 没有传给 confirm，confirm 也不会比较 plan 的 runId/attempt。因此“两次结果不一致时确认失败”不是实际保证，真实保证是“confirm 自己的那份必须通过同一套 verifyGate”。从安全性看这不算漏洞（verifyGate 绑定了 main push 身份、run/attempt、base/head/tested、policy、toolchain），但文档表述应改成实际行为，或真的把 plan 的 runId/attempt 通过 job output 传下去比较。

---

## 推测 / 未核实

- **GitHub 作业日志真实格式未实测**：代码能去掉 `YYYY-MM-DDTHH:MM:SS(.fraction)Z ` 前缀和开头的 BOM，也能忽略 `##[group]` 行；但 302 跳转、日志是否逐行带时间戳、是否可能换行/截断，我无法联网验证。若格式不符，`decodeGate` 会以 `MAIN_GATE_LOG_*` 失败并退回完整 CI，属于安全失败，不是误判通过。
- **`githubLog` 只处理 302**：301/303/307/308 会因 `response.ok=false` 失败并退回完整 CI；没有跟随其他 3xx 的测试。GitHub 文档和现有测试都按 302 假设，若实际返回 307，轻量路径会失效但不会误放行。
- **8 条 security exceptions 的运行时效果未跑**：我核对了 `security-exceptions.mjs` 的 `validatePublishedEntry` 路径公式、`package-lock.json` 的嵌套路径/版本/integrity/resolved，以及 `publishedRules` 里的 `bearer-token`/`jwt-token`，结构上都能通过；但 `fileSha256`、实际命中 digest/count、以及构建产物里是否真的存在这些成员，未运行扫描无法确认。
- **新例外不会在本轮立即生效（按现有设计）**：`loadReviewedExceptions` 用 `git show <context.baseSha>:ci/security-exceptions.json` 取执行用例外（`security-exceptions.mjs:232`），所以本 PR 新增的 8 条只作为候选提案校验；要等它们进入目标分支后才对后续运行生效。这与 Spec `:242` “常规例外仍从目标分支读取”一致，但意味着这个提交本身不能靠这 8 条让 security 变绿。
- **Andy 的“不等 CI”长期授权和 I-94 的计费事实**：只能从仓库文字看到，无法从代码核实原话/账单元数据。

---

## 侧重检查（错误路径、输入信任、安全、资源、不可逆操作）

- **错误路径**：`main-evidence.mjs` 的 `main()` 捕获所有异常并写 `decision.json`（`mode: full`）；`verify` 失败也返回 full，因此 plan 不会把异常当通过。confirm 重新 discover 失败时，`main-confirm` 会在 `verify` 处失败，确认作业变红，而不是误判通过。`decodeGate` 的缺失/两段/摘要不符/非 base64 都会被拒绝。
- **不可信报告输入**：gate 本体是严格 base64 + SHA-256 + 固定 JSON 键；报告里的路径/原因不会以“原始日志行”形式进入 gate，只会进入 JSON 的 `reasons`。但正如中-1，`reasons` 会原样进作业摘要，需补 `cell`。
- **令牌/跳转**：`githubLog` 只对 `api.github.com` 带 `Authorization`；跳转后的第二次请求没有 headers，测试明确断言；令牌不会带到存储地址。未限制跳转主机是理论上的 SSRF 面，但 `Location` 由 GitHub 返回，且不带令牌。
- **信任边界**：`pushIdentity` 在 `main-evidence.mjs:101-113` 检查 `.github`、`ci`、`scripts/ci` 在 `before..after` 未变化（`MAIN_VALIDATION_CHANGED`）。因此能伪造 gate 的代码改动无法进入轻量路径；若 PR 不改这些目录，gate 由 base 的 `required.mjs` 产生，其他步骤即使打印第二段也会被“恰好一段”拒绝。
- **资源上限**：gate 256 KiB、日志 20 MB、摘要 64 KiB/40 行、每行 500 字符、每个列表 100 项；这些上限都有代码或测试。唯一明显的资源问题是 `ci-summary` 整文件读入内存（低-1）。
- **不可逆操作**：`.agents/instructions/delivery-mode.md` / `AGENTS.md` 把“CI 红了也可以合并”从需要 Andy 逐次同意改为长期授权，属于流程门槛变化；文本要求写明失败原因和与本 PR 无关的依据，但没有机械检查。授权原话与适用范围无法从代码核实，建议把该授权单独记录到 ADR/事故记录，并要求 PR 描述粘贴原话链接。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本 PR 没有改 `packages/prompt-catalog`、`packages/runtime-pi`、模型请求组装、历史存储或出口遮盖；改动只在 CI 工作流、CI 脚本、文档和扫描例外。发给模型的系统提示、工具定义、历史消息、遮盖结果都没有变化，因此“只追加、每轮变化的值只在最后一条消息”这条规则没有被触碰。CI 侧新增的 gate 也不是模型请求。

补充：轻量确认的信任边界没有因为“改成读日志”而变弱。真正的保证来自 `pushIdentity`：任何改 `.github`/`ci`/`scripts/ci` 的合并都走完整 CI；在轻量路径里 gate 由基线 `required.mjs` 产生，日志中的其他步骤即使打印 `GATE_BEGIN` 也会造成“两段”而失败，不能只留一段伪造结论。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**对模型请求：不涉及。** 本 PR 没有模型请求，也没有新的时间戳、随机值或无序集合进入提示。

对 CI gate：编码是确定性的（`JSON.stringify({context, summary})` + base64 + SHA-256），gate 内不含时间字段；读取时先去掉外部日志时间戳；`ci-summary` 按相对路径排序，测试也断言同一输入输出相同。`encodeGate` 的键顺序依赖 JS 对象插入顺序，但这份 gate 只做单次 encode/decode，不用于跨请求字节比对；若以后要缓存或比较这份字节，建议显式固定键顺序。

### 3. 有没有自动检查，反向用例会不会失败？

有：
- `test/tooling/main-evidence.test.mjs`：时间戳日志解码、`ci/required` 作业选择、日志下载只带一次令牌、非 HTTPS/带账号/无效跳转、无 gate/两段 gate/摘要不符/截断日志等反向用例。
- `test/tooling/gate-lifecycle.test.mjs`：`required.mjs` 打印的 gate 能被 `decodeGate` 解回同一 `context/summary`，失败 gate 也能解码。
- `test/tooling/ci-summary.test.mjs`：排序、遮盖、行长截断、总量上限、四反引号、缺失目录、缺参数。
- `test/tooling/policy.test.mjs`、`ci-optimization.test.mjs`、`quality-policy.test.mjs`：三个工作流重新加入 `actions/upload-artifact`/`download-artifact`、删掉 gate 打印步骤、删掉摘要步骤、恢复 handoff/`ci_run_id` 等反向用例。
- `test/tooling/toolchain.test.mjs`：锁定 action 集合不再包含两个 artifact action。

从代码阅读看，这些反向用例会抛出预期的具体错误（如 `github-artifact`、`job-summary`、`GitHub artifacts are not used...`）。**但我不能运行测试**（本次工具只允许读和少数 git 命令），所以“实际绿/红”未实测。

覆盖缺口：
- 没有测试 `reasons` 里的密钥/`|`/换行会被 `cell` 处理（正是中-1）。
- 没有测试超大诊断文件的内存/上限行为。
- `githubLog` 未覆盖 301/303/307/308、缺失 `Location`、超大响应体；BOM 也未单独覆盖。
- “`ci-summary.mjs` 只能用 Node 内置模块和 `redact-text.mjs`”目前只是运行时事实，没有静态检查；以后若误加 `yaml`/`ajv`，`main.yml` 的 plan 作业才会在运行时失败。

### 4. 每个产生/修改的值，使用方都能接受吗？

逐项核对结果：

| 值 | 产生处 | 使用处 / 结论 |
|---|---|---|
| `candidate` 新增 `jobId`，去掉 `artifactId` | `main-evidence.mjs:172-180` | `verifyGate` 只取 `before/after/head/tree/runId/attempt`；`main-confirm.mjs:131-133` 只用 `pr/runId/attempt`。`jobId` 未被校验但无害；没有残留读 `artifactId` 的代码。 |
| `gate/{context,summary}.json` | `main-evidence.mjs:256-258` | `verifyGate` 经 `main-evidence.mjs:264-265` 读取并逐字段校验。两端一致。 |
| `run_id`/`artifact_id` job outputs | 已删除 | 工作流中已无引用；`GITHUB_OUTPUT` 只剩 `mode`。 |
| `ci_run_id` 输入 | 已删除 | `quality-policy.mjs` 的 expected events 与 `quality.yml` 一致；无调用方。 |
| 摘要标题和 `--from` 字面量 | 三个工作流 | `check-policy.mjs`、`quality-policy.mjs`、`main-workflow.mjs` 逐字比对；我核对了实际 `.github/workflows` 与期望字符串一致。 |
| `REQUIRED_GATE_COMMAND` | `check-policy.mjs:40` | 与 `ci.yml:366` 完全一致；反向用例覆盖缺失/条件/改输出目录。 |
| `retentionDays` | `ci/policy.json`、`ci/quality-policy.json` | 仍被 `upgradeArtifactRetention` 和 `export-evidence.mjs:110,161` 使用，字段本身不误导；但文档 `:320` 的“保留 1 天”已不适用（中-2）。 |
| `toolchain-lock.actions` 删两项 | `ci/toolchain-lock.json`、`install-tools.mjs` | `validateToolchainLock` 期望恰好 3 项；`toolchain.test.mjs` 验证新增未知 action 会失败；三个工作流已无 artifact action。两端一致。 |
| 8 条 security exceptions | `ci/security-exceptions.json` | 我核对了 `validatePublishedEntry` 的路径公式、`package-lock.json` 的嵌套路径/版本/integrity/resolved、以及规则名；结构上通过。实际 `fileSha256`/命中 digest/count 与构建产物是否包含这些成员未运行验证。另：运行期从 base 读取例外，新条目不会让添加它的这一轮变绿（与 Spec `:242` 一致）。 |

结论：代码层面的生产/消费两端目前是对齐的；没有发现删掉 handoff 后仍引用 `ci_run_id`、`artifact_id`、`handoff-` 产物或 artifact action 的残留代码。
