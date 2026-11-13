## 复核范围

看了 `c6bbde634..45be48093` 的增量（排除 `.agents` 复核记录），并对照了 `0238`、`0253`、`0266`、`ci.yml`、`ci/policy.json`、`ci/toolchain-lock.json`、`check-security.mjs`、`run.mjs`、`host-load.mjs` 及相关测试。未运行测试，运行结果均为读代码推演。

## 读代码证实的问题

### 1.【中】ADR 0266 引用 ADR 0253 的行号全部错一行

- 文件：`docs/adr/0266-ci-policy-static-security-run-on-the-oracle-arm-machine.md:36,37,60`、`docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:8,62,66,83,84`
- 问题：本次给 0253 第 8 行新增了 `amended_by`，frontmatter 多一行，后面所有行号顺移 +1；0266 对 0253 的引用没有跟着改。提交说明里的“前提行号改正”只改了 `ci/policy.json` 的 14→15，没有覆盖这里。
- 证据：
  - 0266:36 写“第 61 行……第 82 行”；实际 0253:62 才是“ARM 不进 GitHub 必过检查，也不切线上。”，0253:83 才是“测试机可能被 Oracle 回收，不能让必过检查依赖它”。
  - 0266:37 写“同一文件第 65 行”；实际 0253:66 才是“`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。”
  - 0266:60 写“第 65、83 行写的独立锁文件”；实际应为 0253:66、84（0253:84 是“把 ARM 条目直接加进 `ci/toolchain-lock.json` | 不采用”）。
  - 0266:41 还只给了 `ci/policy.json` 第 15、16 行，但 static 的 arch/alternateArch 在 32/33 行、security 在 122/123 行；若说“这三项”，引用不完整。
- 建议：把 61→62、82→83、65→66、83→84 全部改正；更稳妥的是少用硬编码行号，改为引用小节标题+原话。0266:41 可写明“以 policy 成员为例”或补上 static/security 的行号。

### 2.【低】`run.mjs` 的 try/finally 没有覆盖 `main` 失败路径的自动检查

- 文件：`scripts/ci/run.mjs:587-602`、`test/tooling/runner-orchestration.test.mjs:789-806`
- 问题：新增测试只验证 `startHostLoad()` 的格式化结果；没有测试调用 `main()` 并让 `runCheck` 抛错后断言 `CI_HOST_LOAD` 仍写出。把 try/finally 去掉，现有测试不会红。
- 证据：
  - `run.mjs:588-602`：`let result; try { result = await runCheck(...) } finally { process.stdout.write(`${stopHostLoad()}\n`); }`
  - 测试导入的是 `startHostLoad`，只调用它构造一行字符串，没有覆盖 `runCheck` 抛错经由 `main` 的路径；全仓 `grep CI_HOST_LOAD/startHostLoad` 也只有这一处测试。
- 建议：为 `main` 抽一个可注入 `runCheck` 的包装，或用 mock 让 `runCheck` reject，捕获 stdout，断言仍有一行 `CI_HOST_LOAD`；反向用例即“删掉 try/finally 必须失败”。

### 3.【低，既有不是本次引入】ADR 0238↔0176 的双向关系仍不对称

- 文件：`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:7`、`docs/adr/0176-ci-on-ovh-vps.md:9`
- 问题：0238 的 `amends` 写了 0176，但 0176 的 `amended_by` 只有 0241、0256，没有 0238。本次补的是 0266↔0238、0266↔0253，这两组已一致；但“ADR 元数据双向一致”整体仍有一个旧缺口。且现有检查只查路径存在，不查双向。
- 证据：
  - `0238:7: amends: "docs/adr/0176-ci-on-ovh-vps.md"`
  - `0176:9: amended_by: "docs/adr/0241-..., docs/adr/0256-..."`
  - `scripts/check-adr-numbers.mjs:93-95` 只用正则找 `docs/adr/*.md` 并调用 `isRegularFile`，不解析 `amends/amended_by` 的对应关系。
- 建议：若仓库约定双向，补上 0176 的 `amended_by`；更根本的是在 `check-adr-numbers` 里增加双向一致性检查，否则同类遗漏只能靠人工。

## 推测/局限（未核实）

- **推测**：`run.mjs:600-602` 在 `finally` 里直接调用 `stopHostLoad()`；若它自身抛错（如 `os` 调用异常），会覆盖 `runCheck` 的原始错误，导致真正的检查失败原因丢失。概率低，但错误路径上应包一层 try/catch。
- **推测/局限**：作业被 GitHub 超时或 SIGTERM 杀掉时，Node 不会执行 `finally`，这时反而没有 `CI_HOST_LOAD` 行；ADR 想用它观察时长/负载，最需要它的超时场景可能拿不到。需要真实超时验证。

## 核对通过的点（不属于问题）

- 安全错误拆分正确：`scripts/ci/check-security.mjs:57-64,74-76` 分别处理 `error`、`signal`、非整数 status；`test/tooling/security-process.test.mjs:261-270` 用两个夹具分别期望 `SECURITY_CMD_ERROR_UNKNOWN`、`SECURITY_CMD_SIGNAL_SIGKILL`。若退回旧的合并 assert，两例都会得到 `SECURITY_COMMAND_UNAVAILABLE`，测试会失败，反向用例有效。
- 新错误码能被下游接受：`check-security.mjs:725` 和 `run.mjs:278` 都用 `^[A-Z_]+$` 过滤；`commandFailure` 去掉了数字和非法字符并截到 40 字符，符合这两个消费者。
- 锁文件说明属实：`ci/toolchain-lock.json` 中确有 linux-arm64 的 Node（23）、Python artifacts（75）、actionlint（133）、gitleaks（158）、Semgrep（1489）；仓库里只有这一份 toolchain 锁文件（`ci/*lock*` 仅匹配到它）。
- `ci.yml` 行号引用正确：policy 33、static 72、security 284、汇总 362；`ci/policy.json` 第 15/16 行确为 `arch`/`alternateArch`。
- 两处 `setEncoding("utf8")` 加得正确：`scripts/model-review/gateway.mjs:770`、`scripts/model-review/opencode-review.mjs:908`；`opencode-review.mjs:884` 的 stdout 本来就有解码，所以本次只补 stderr 是合理的。
- `ci-arm-trial` 已无残留引用：代码和文档里只剩测试断言其不存在。

## 侧重检查

- **错误路径**：信号分支已真测；`error` 无 code 走 UNKNOWN；`signal` 与 `error` 同时存在时优先报 `ERROR`。`run.mjs` 的失败路径能写出 `CI_HOST_LOAD`（代码上成立），但没有测试覆盖；`stopHostLoad` 抛错会覆盖原错误、SIGTERM/超时不会执行 finally，见上面的推测。
- **不可信输入**：`commandFailure` 把换行、空格、标点全部转成下划线并删数字，最后只留 `[A-Z_]`，不会让错误码注入日志或多行；长度截到 40，避免异常长的错误码撑大日志。
- **安全**：本次没有新增密钥、外连或删除操作；ADR 路径存在性由 `check:adr-numbers` 的 `ADR_PATH_MENTION` 覆盖。`--remote-jobs` 的消费端 `run-share.mjs:178` 有 `^[a-z][a-z0-9-]*(,...)*$` 校验，`policy,static,security` 能通过。
- **资源耗尽**：`host-load` 每 15 秒一个样本、数组随作业时长线性增长，正常作业规模可接受；`gateway.mjs:772` 的 stderr 只留最后 4000 字符；`opencode-review.mjs:910` 的 stderr 是无界累加（既有，不是本次引入，但本次正好改到这里，值得以后加截断）。
- **不可撤销操作**：本次增量没有。
- **文档/规则一致性**：主要问题就是第 1 条的 0253 行号；锁文件、ci.yml、policy.json、runbook 与代码一致。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次增量只动 CI 脚本、ADR、测试和复核脚本的 stderr 解码，没有改系统提示、工具定义、历史消息或出口遮盖。`CI_HOST_LOAD` 只写进 CI 作业日志（`run.mjs:601`），不进入任何模型请求；`setEncoding` 只影响错误日志/记录文本。按 `.claude/rules/prompt-prefix.md:27-28,35,84-88`，请求仍应是固定的在前、会变的值只在最后一条用户消息；本次没有触碰这条链路。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**对模型可见内容：不会。** `SECURITY_CMD_*` 由确定的输入稳定生成；ADR 内容是静态文件；`setEncoding` 反而消除了按 chunk 解码造成 U+FFFD 的不确定性。`CI_HOST_LOAD` 每次值不同，但它只在 CI 日志里，不是模型请求的一部分。

### 3. 有没有对应的自动检查，反向用例真的会失败？

- 安全错误分支：**有**。`security-process.test.mjs:261-270` 两个夹具分别断言两种错误码；退回旧的 `SECURITY_COMMAND_UNAVAILABLE` 会使两例失败。`commandFailure` 的单元测试还检查了非法字符、数字去除和 40 字符上限。
- ADR 路径存在：**部分有**。`check:adr-numbers`（`scripts/check-adr-numbers.mjs:93-95`）会检查 `docs/adr/...md` 路径存在；`test/tooling/adr-numbers.test.mjs:147-149` 有“仓库当前通过”的用例。但**不检查** `amends/amended_by` 双向一致，也**不检查**行号，所以第 1 条的情况不会红。
- `run.mjs` try/finally：**没有**。只有 `startHostLoad` 的格式化测试，删掉 try/finally 不会失败。
- `setEncoding`：**没有**。`docs/incidents-and-gates.md:120`（I-82）也写明门槛不扫复核网关/子进程输出这两类，复发靠代码复核。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

- `SECURITY_CMD_*`：产生于 `check-security.mjs:57-64`；使用于 `check-security.mjs:725`、`run.mjs:278`，两处都要求 `^[A-Z_]+$`；产生端已去数字/非法字符，能通过；测试也精确断言了这两个值。
- ADR `amends/amended_by` 路径：产生于 0238:9、0253:8、0266:7；被 `check-adr-numbers.mjs:93-95` 的存在性检查消费；三处路径均存在，能通过。但它没有“反向一致性”消费者，所以只能保证路径不写错，不能保证双向。
- `CI_HOST_LOAD`：产生于 `host-load.mjs:1-39`、`run.mjs:601`；目前只被人和 ADR/runbook 读取，没有代码解析器，格式变化不会触发下游校验。
- `--remote-jobs policy,static,security`：产生于 `.github/workflows/ci.yml:362`；被 `check-policy.mjs:578` 以 `${armChecks.join(",")}` 精确比对，也被 `run-share.mjs:178` 的正则校验；顺序和取值一致。
- `runner: ci-arm`：产生于 `ci/policy.json:13,30,120` 和 `ci.yml:33,72,284`；被 `ci/policy.schema.json:64` 的 enum、`check-policy.mjs:195-198,222-223`、`aggregate.mjs:99-106` 接受；测试覆盖了“static/security 放回 ci-vps 被拒”和“coverage 放 ci-arm 被拒”。
- `arch/alternateArch`：产生于 `ci/policy.json:15-16,32-33,122-123`；`aggregate.mjs:102` 明确接受 `member.arch` 或 `member.alternateArch`，测试覆盖了 policy/static/security 的 arm64 通过、ppc64 失败、build 的 arm64 失败。
