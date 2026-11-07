## 读代码证实的问题

### 中｜任务清单里预留的 ADR 编号已被本轮合入的 main 占用

- 位置：`.agents/tasks/hermes-runner/items.json:370`
- 问题：HR-16 的 `done_when` 指向 `docs/adr/0177-quality-on-ci-vps.md`，但 `3da9e6ec` 合入 main 时已经带进 `docs/adr/0177-gitleaks-exact-value-allowlist.md`（PR 275）。现在 0177 这个编号已被占用，`docs/adr/0177-quality-on-ci-vps.md` 不存在；将来做 HR-16 时若按清单创建，会出现两个 0177 或文档校验找不到路径。这正是 I-73 那类“清单里的 id 能否通过后端/下游校验”的问题。
- 证据（亲自读到/运行）：
  - `.agents/tasks/hermes-runner/items.json:368-371`：
    ```json
    {
      "type": "doc",
      "path": "docs/adr/0177-quality-on-ci-vps.md",
      "quotes": "G21"
    }
    ```
  - glob `docs/adr/0177-*` 只返回 `docs/adr/0177-gitleaks-exact-value-allowlist.md`。
  - `git diff 1214b1da..3da9e6ec --stat` 显示 `docs/adr/0177-gitleaks-exact-value-allowlist.md | 114 ++++++++++++++`，是这一轮合并带进来的。
  - 同类先例在 `.agents/tasks/hermes-runner/plan.md:35`：上次合入 main 后 ADR 编号 0154、0155 被占用，就把 HR-7 的路径改成 0156。
- 建议：把 HR-16 的路径改成 `docs/adr/0178-quality-on-ci-vps.md`（或注明开工时再取号），并在 `plan.md` 补一行“合入 main 后 0177 已被 gitleaks ADR 占用”。如果任务工具有 `doc` 类型的存在性校验，先跑一次。

### 中｜作者对“合入了哪些 main 提交”的说法与代码不符

- 位置：提交 `3da9e6ec`（合并说明）/ PR 描述
- 问题：作者说合入的 main 只有 PR 275、PR 276，并且把“出口遮盖的固定文字修复”算到 PR 276。实际 `git log --no-merges 1214b1da..3da9e6ec` 还包含 **PR 274**（`64165971`，“去掉整段拦下 PR2：发给模型的工具结果、网页结果交给出口遮盖”），而 PR 276 只改了 `docs/engineering-casebook.md`（案例 85），不是代码修复。PR 274 是对模型可见行为的实质改动（withhold 整段 → 就地遮盖），只读 `40d53396..HEAD` 增量的人会误以为这是一次 CI-only 合并。
- 证据：
  - `git log --oneline --no-merges 1214b1da..3da9e6ec` 第一条是 `64165971 ... (#274)`。
  - `git diff 5cedac65..7281d941 --stat` 只有 `docs/engineering-casebook.md`（外加复核记录），证明 PR 276 是文档 PR。
  - `git diff 1214b1da..3da9e6ec --stat` 含 `packages/application/src/services/model-egress.ts`、`packages/sensitive-capture/src/redaction.ts` 等，证明合并把 PR 274 带进了分支。
  - 但 `git diff f0478c4d..3da9e6ec -- packages/application/src/services/model-egress.ts packages/sensitive-capture/src/redaction.ts ...` 为空：相对目标基线 `f0478c4d`，PR 274 已经在 main 里，不是本 PR 的净改动。
- 建议：把 PR 描述改成“合入 main 的 274/275/276；其中 274 是 base 已有的出口遮盖改动，本 PR 相对 base 只有 CI 搬迁”。这样既不会漏看行为变化，也不会把 base 已有的改动算到本 PR 头上。

### 低｜coverage 的 Chromium 安装没有静态回归检查

- 位置：`scripts/ci/check-policy.mjs:402-422`
- 问题：`check-policy` 对 coverage job 只断言了“下载 artifact”和“`scripts/ci/run.mjs --check coverage ...`”两步，没有断言 Playwright 安装步骤。删掉 `.github/workflows/ci.yml:410-411` 这两行，policy/tooling 单测不会失败，只会在 coverage 真跑 PG-12 时失败（本轮就是这样发现的）。
- 证据（`check-policy.mjs`）：
  ```js
  const downloads = job.steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  ...
  const executions = job.steps.filter((step) => step.run?.includes("scripts/ci/run.mjs"));
  ```
  只检查这两类，`test/tooling/ci-optimization.test.mjs` 也只查缓存和 artifact retention。
- 建议：在 `check-policy.mjs` 或 `test/tooling/ci-optimization.test.mjs` 增加断言：凡是执行 `--check coverage`/`--check test`/`--check node-floor` 的 job 必须包含 `node_modules/playwright/cli.js install --only-shell chromium`；再加一条“删掉该步骤必须报错”的反向用例。顺带确认 coverage 的 60 分钟 timeout 是否够“下载 Chromium + 覆盖率跑集成测试”。

## 推测的问题（未测量）

### 低｜合并进来的 PR 274 在超大输入上可能放大 CPU

- 位置：`packages/application/src/services/model-egress.ts:410-420`、`packages/sensitive-capture/src/machine-secrets.ts:105-121`
- 推测：`maskTree` 现在对每个匹配 `BASE64_DATA_URL` 的字符串执行 `scanMachineSecrets(value)`，此前是 `value.startsWith("data:")` 直接放行；`maskKeyTails` 对每个 `-----END PRIVATE KEY-----` 都在最多 `120 * 160 = 19200` 字符的窗口上跑正则，END 标记数量没有上限。如果工具输出很大且包含大量 `-----END PRIVATE KEY-----` 或超大 `data:` 字符串，可能出现 CPU 放大。
- 证据：
  ```ts
  if (BASE64_DATA_URL.test(value) && scanMachineSecrets(value).length === 0) return value;
  ```
  ```ts
  for (const marker of input.matchAll(KEY_END)) {
    const from = Math.max(floor, marker.index - KEY_TAIL_WINDOW);
    ...
    const tail = KEY_TAIL.exec(input.slice(from, marker.index));
  ```
- 建议：先按输入长度/END 标记数量短路或设上限，或做一次大输入基准。注意这是 PR 274 的代码，已在 base `f0478c4d` 中，不是本 PR 的净改动。

## 未核实

- “文档严格校验 11 个错误，与基线相同”：只读且不能运行 `validate_docs.py`，无法复现。未核实。
- `docs/runbooks/ci-vps-runner-runbook.md:5` 的 `contract_sha256:30c89bb3...`：无法计算 SHA-256，未核实。好消息是 `510a445d`、`37832531` 这两次改脚本的提交都同时改了 runbook，模式上像是一起更新了。
- `ci/toolchain-lock.json:1222` 的 `ci/rules/gitleaks.toml` sha256：同样无法计算。但 `scripts/ci/install-tools.mjs:332-339` 的 `verifyRuleFiles` 会在 `--check` 时逐文件核对，值错了 CI 会失败。
- `.agents/reviews/pr-273/round-[14]/deepseek-v4.1-flash.md` 是否真的存在：当前是 94% 稀疏检出，`.agents/reviews/pr-273` 没有落到工作区，未核实。gitleaks 的真实仓库扫描会在 CI 里验证这条路径。

## 侧重检查

- **错误路径**：
  - `pi-output-export.ts:41-50` 的 UTF-8/非 UTF-8 分支、`PI_OUTPUT_SECRET_DROPPED` 只在 `pi-host-publication.ts:126` 被消费，生产/消费匹配。
  - `model-egress.ts:223-237` 的 `assertMachineSecretFree` 失败路径会把整次请求的所有 sighting 标成 `withheld` 并拒绝发送，符合“整段未发”的语义。
  - `install-runner.sh` 的 `BACKUP`/`restore_backup` ERR/INT/TERM/HUP trap、`prepare-vps.sh` 的 64/68/69/70/71/72/73 退出码、`check-policy.mjs` 的升级只认完整旧写法，均与 runbook/ADR 一致。
  - 未发现新增的未处理错误码/未匹配的异常分支。
- **不可信输入**：
  - 新增私钥片段规则只作用于 untrusted 文本（`redaction.ts:297-300` 在 `redactUntrusted` 内），trusted span 先被填充符替换，不会误改 Himawari 自己的固定文字。
  - `BASE64_DATA_URL` + `scanMachineSecrets` 比原来“所有 `data:` 直接放行”更严格，方向是收紧。
  - gitleaks 白名单仍是“规则 + 单一路径 + 精确值”，没有放宽成目录或字符类；测试里有“改一个字符就不放行”的反向用例。
- **安全**：
  - runner 不给 docker 组、`ProtectHome=yes`、`InaccessiblePaths` 藏另一个 runner 目录和 docker.sock、nft 拒绝私有网段/元数据地址/本机监听端口，和 ADR 0176 一致。
  - 注册令牌经 stdin → `ACTIONS_RUNNER_INPUT_TOKEN`，并先检查 runner 版本会读这个环境变量，避免令牌进命令行。
  - 残留风险都在 ADR/runbook 里写明：同一 runner 的 job 能读自己的注册凭证；新增本机服务端口要重新跑安装脚本才会进防火墙名单；`prepare-vps.sh` 给 `/usr/bin/bwrap` 的 AppArmor profile 是 `flags=(unconfined)`。
- **资源耗尽**：
  - Chromium 每个 job 重新下载（runbook 说任务结束删除检出），这是预期行为；coverage 现在也加入，耗时/磁盘增加但有限。
  - `scanMachineSecrets` on data URL、`maskKeyTails` 的 END 标记循环是唯一值得再看的 CPU 放大点（见上面“推测”）。
- **不可撤销操作**：
  - `install-runner.sh` 有备份和回滚；`prepare-vps.sh` 写 `/etc/cloud/...`、`/etc/apt/...`、`/etc/needrestart/...` 不备份、内容不同也直接覆盖（apparmor 文件是例外，会拒绝），但脚本可重复运行，ADR 写明是一次性准备脚本。
- **文档与代码一致**：
  - ADR 0176 ↔ `prepare-vps.sh`/`gh-runner.service.in`/`gh-runners.slice`/runbook 基本一致。
  - ADR 0177 ↔ `ci/rules/gitleaks.toml`/两个 gitleaks 测试一致。
  - AGENTS.md 及 `.agents/instructions/*` 已改成 ADR 0176/CI VPS。
  - 唯一发现的不一致就是上面的 `items.json` ADR 0177 路径冲突。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   - 本 PR 相对目标基线 `f0478c4d` 的净改动是 CI/runner/文档，**不改系统提示、工具定义、历史消息或遮盖结果**；`git diff f0478c4d..3da9e6ec` 不含任何 `packages/` 产品代码。Chromium 步骤只影响 CI。
   - 本轮增量里唯一和模型相关的是测试文字更新：`test/integration/production-http-composition-process.test.ts:1974,1998-1999,2011` 把期望的停止提示从英文改成中文，以匹配 `packages/prompt-catalog/src/runtime.ts:88` 已经存在的中文原文。这是测试对齐既有提示词，不是改提示词；该测试仍然断言停止说明只出现在最后一条消息、`requestHead(...).prefix` 里没有它，所以“只追加、会变的值在最后一条消息”仍然成立。
   - 如果按 `40d53396..HEAD` 看增量，合并带进来的 PR 274 会改变历史 untrusted 内容的遮盖算法（例如放大截断私钥的遮盖）。但 PR 274 已在 base `f0478c4d` 中，本 PR 合入 main 不会在目标分支上新增这次行为变化。需要单独确认的是：PR 274 上线后，受影响对话的历史遮盖字节会一次性变化（等价于规则版本变化导致的缓存未命中），这是它自己的既定取舍，不属于本 PR 的净改动。

2. **同一段文字会不会在不同请求里变成不同字节？**
   - Chromium 改动不涉及模型内容，不会。
   - 本轮合并可见的 PR 274 新规则本身是上下文无关的：`redactPrivateKeyFragments` 只依赖输入文本；`BASE64_DATA_URL` 分支只依赖该字符串自身；没有时间、随机数或无序集合进入提示词内容。既有的“点名值”机制仍然让同一次请求里靠后的消息依赖靠前的消息，但那是规则文件写明的例外，且不是本轮新增。
   - 新增的 `withheld` sighting 用 `Map` 迭代，但只写入拦截记录，不进入发给模型的字节。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   - Chromium 步骤：**没有专门的静态检查**；`check-policy.mjs` 只检查 coverage 的 artifact 下载和 `run.mjs` 命令。删掉这一步时，只有 coverage job 真跑 PG-12 会失败（本轮事实如此），没有更快的反向用例。这是本轮的主要测试缺口。
   - PR 274（合并进来的部分）：有 `production-foreground-result.unit.test.ts`、`private-key-fragments.unit.test.ts`、`model-egress.unit.test.ts`、`sensitive-interception-recorder.unit.test.ts`、`sandboxed-coding-operations.unit.test.ts` 等，并有 `scripts/check-egress-redaction.mjs` 门槛；反向用例从代码上看存在（例如“clean full output 不动”“只提私钥名字不遮”“输出二进制含密钥要丢弃”）。我没有运行测试，**“真的会失败”未核实**。
   - gitleaks（PR 275）：有真实 Gitleaks 的正反用例，`test/tooling/gitleaks-config.test.mjs:176-197` 明确要求“把白名单放宽成字符类必须报错”，`gitleaks-allowlist.test.mjs:74-109` 有改一个字符就不放行的反向断言。这一项的检查比较扎实。
   - 文档 11 个错误：无法运行，**未核实**。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `ci-vps`：`ci/policy.json` 全部 Linux 成员、`ci/policy.schema.json:64` 的 enum、`.github/actionlint.yaml:3`、`ci.yml`/`main.yml` 的 `runs-on`、`scripts/ci/contracts.mjs:7`、`scripts/operations/ci-runner/runners.sh`、`test/tooling/ci-runner-scripts.test.mjs` 全部一致。
   - `PLAYWRIGHT_BROWSERS_PATH`：coverage `ci.yml:397` 与 test `ci.yml:212` 完全相同；安装步骤写入 `.ci-output/browsers`，Playwright 运行时读取同一环境变量；consumer 是 PG-12 等集成测试，`chromium.launch()` 默认 headless，`--only-shell chromium` 够用。
   - `outcome: "withheld"`：生产在 `model-egress.ts:229`，经 `sensitive-interception-recorder.ts:77` → `packages/application/src/ports/sensitive-interceptions.ts:35` 的 `SENSITIVE_INTERCEPTION_OUTCOMES` → `packages/gateway-contracts/src/contracts-v2.ts:703` 的枚举 → SQLite `sqlite-sensitive-interception-operations.ts:224` 计数 → 控制中心过滤/i18n。两端都接受。
   - `redacted: true`：生产在 `pi-output-export.ts:62`，生产代码里没有消费方，只有 `production-foreground-result.unit.test.ts` 读。因为 `fullOutput` 是嵌入 JSON 的自由字段、没有 schema 拒绝未知键，不会破坏消费方；但如果是打算给 UI/日志用，目前是死字段，建议确认用途或删掉。
   - `PI_OUTPUT_SECRET_DROPPED`：生产唯一在 `pi-output-export.ts:44`，消费唯一在 `pi-host-publication.ts:126`，匹配；没有别处还在等 `PI_OUTPUT_SECRET_REJECTED` 的旧分支。
   - gitleaks 白名单项：幂等键 `sensitive-interceptions-clear-01` 与摘要 `0803...` 都在对应文件里读到了实际值；PR 273 复核文件因稀疏检出未核实；`toolchain-lock` 的 sha256 未核实，但 `verifyRuleFiles` 会在 CI 运行时校验。
   - **唯一确认的不匹配**：`.agents/tasks/hermes-runner/items.json:370` 的 `docs/adr/0177-quality-on-ci-vps.md` 与已存在的 `docs/adr/0177-gitleaks-exact-value-allowlist.md` 冲突（上面第一条）。
