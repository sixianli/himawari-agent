## 侧重检查

- **错误路径**：读了 `put/get/collect/remove` 的全部失败分支、`required.mjs` 的缺失报告判定、安装/卸载脚本的回滚路径。发现 `collect` 把每个 `get` 的异常都吞掉并以 0 退出，靠 `required.mjs` 从残留文件再判定；`get` 只在摘要不一致时删副本，`cpSync`/遍历抛错时不删。见下方第 5 条。
- **不合规范/不可信输入**：核对了 `HIMAWARI_CI_SHARE`、`GITHUB_RUN_ID/ATTEMPT`、`--name`、`--digest`、`--output-key`、`CI_NEEDS` 的校验。名称/运行号/摘要都有正则限制，路径拼接不可穿越；`CI_NEEDS` 只接受 64 位十六进制摘要。这部分实现是收敛的。
- **安全**：共享目录对整个 `gh-ci-share` 组可写（`gh-runner.service.in:36` 把整个 `/srv/gh-runner-share` 放进 `ReadWritePaths`，目录 `2770`），因此一个任务能读写、删除**所有运行**的文件，而不只是 ADR 里写的“另一个 runner 正在用的本次文件”（`docs/adr/0238...:90`）。摘要能发现内容被改，但挡不住有意改摘要的任务——ADR 已接受这一信任模型，但描述范围偏窄。
- **资源耗尽**：每轮约 300 MB，正常由 `required` 删除；取消/崩溃靠 6 小时清理。`remove` 用 `always()`，但 GitHub 取消 job 时是否一定执行 `always()` 未核实；文档已用清理定时器兜底。
- **不可撤销操作**：`required` 无论成败删除本次运行目录（`ci.yml:396-398`）；`uninstall all` 删除整个共享目录和组（`uninstall-runner.sh:38-39`）；`clean-old.sh` 以 root 删除 6 小时前的运行目录（`clean-old.sh:24-26`）。这些与文档基本一致，但失败重跑的影响见第 2 条。
- **文档/代码一致**：ADR 0238、Runbook、设计文档与代码大体一致；发现 I-93 的证据描述仍指向已被删除的 `full-permissions` 反向用例（第 7 条），以及 `quality.yml` 仍依赖 `report-` 产物（ADR 已注明它停用）。

## 问题

### 1. 高（关键假设未核实）：`browser` 三份报告摘要依赖矩阵作业输出合并
- **文件:行**：`.github/workflows/ci.yml:182-185`、`scripts/ci/run-share.mjs:107-115`、`scripts/ci/check-policy.mjs:524-533`
- **问题**：每个矩阵成员只写自己的 output 键，但 GitHub 对矩阵 `outputs` 的运行时合并语义在本仓库里没有任何验证。若 GitHub 用“最后完成的腿覆盖整个 outputs 映射”或把未设置键当空串合并，`chromium/firefox/webkit` 中只有一个或零个摘要会到达 `required`，非草稿 PR 会永久缺报告而失败。
- **证据**：`ci.yml` 声明三个键：
  ```yaml
  outputs:
    chromium: ${{ steps.share.outputs.chromium }}
    firefox: ${{ steps.share.outputs.firefox }}
    webkit: ${{ steps.share.outputs.webkit }}
  ```
  `run-share.mjs:141-145` 每条腿只写一个键：
  ```js
  appendFileSync(env.GITHUB_OUTPUT, `${args["--output-key"]}=${digest}\n`);
  ```
  唯一自动检查只比较 YAML 键，不验证矩阵合并（`check-policy.mjs:527-533`）。作者说法 1 中“其他键为空不会覆盖”没有任何仓库内证据。**这部分是推测/未核实。**
- **建议**：先在真实 PR 上确认三条 browser 腿的摘要都能被 `required` 读到；不要依赖该假设。更稳的做法：`required` 按 policy 枚举全部成员，从共享目录取回后校验 `result.json` 的 `runId/attempt/testedSha` 和证据摘要；`browser` 报告不再需要逐成员 output（`build` 只有一条活动腿，仍可保留摘要给 browser/coverage 用）。

### 2. 中（代码证实删除；“重跑失败作业”语义未核实）：失败尝试也立即删除共享目录，与 ADR 的重跑说法冲突
- **文件:行**：`.github/workflows/ci.yml:396-398`、`scripts/ci/run-share.mjs:34-38`、`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92`
- **问题**：`run` 目录按 `运行号-尝试号` 隔离，`required` 用 `always()` 删除本次尝试目录。ADR 说“GitHub 的‘重跑失败作业’会用新的尝试号，上游作业重新存一份，不受影响”。但 GitHub 常见行为是“只重跑失败作业及其依赖，已成功作业不重跑”；若如此，新 attempt 目录没有上游报告，`required` 必然继续失败。
- **证据**：`ci.yml`：
  ```yaml
  - name: 删除 CI 服务器上本次运行的目录
    if: always()
    run: .ci-output/tools/bin/node scripts/ci/run-share.mjs remove
  ```
  `runName` 使用 attempt：
  ```js
  return `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  ```
  ADR 原文：“GitHub 的‘重跑失败作业’会用新的尝试号，上游作业重新存一份，不受影响。”**GitHub 实际重跑语义未核实。**
- **建议**：在真实失败运行上验证“Re-run failed jobs”；若上游不重跑，把文档改成明确要求“Re-run all jobs”，或重新设计 attempt 隔离/失败目录保留策略。

### 3. 中（读代码证实）：新增“禁止 `actions/download-artifact`”规则的反向用例实际测不到该规则
- **文件:行**：`test/tooling/policy.test.mjs:553-558`、`scripts/ci/check-policy.mjs:479-482,495-498`
- **问题**：反向夹具加入的是 `actions/download-artifact@v4`。`validateWorkflow` 在遍历 step 时会先要求 `uses` 是 40 位 SHA，因此它在到达新规则前就以 “Action must use a full commit SHA” 抛错。把这个新规则删掉，该用例仍然通过。
- **证据**：
  ```js
  value.jobs.browser.steps.push({ uses: "actions/download-artifact@v4" });
  ```
  而更早的通用检查是：
  ```js
  const match = /^([^@]+)@([a-f0-9]{40})$/u.exec(step.uses);
  assert(match, `Action must use a full commit SHA: ${step.uses}`);
  ```
  新规则在循环之后才执行（`495-498`）。**读代码证实。**
- **建议**：用 `lock.actions` 里 `actions/download-artifact` 的真实 SHA 构造 step，并断言错误信息是 `Jobs must take reports and builds from the runner share...`；这样删除新规则时用例才会失败。

### 4. 中（读代码证实代码路径；并发触发概率取决于时序）：运行目录的 setgid/权限不是原子建立的
- **文件:行**：`scripts/ci/run-share.mjs:40-47`
- **问题**：`mkdirSync(directory, { recursive: true })` 先以默认模式 `0770` 建目录，随后才 `chmod` 成 `2770`。如果另一账号的作业在这两步之间 `lstat` 到该目录，会因 `info.uid !== process.getuid()` 直接 `CI_SHARE_DIRECTORY_MODE` 失败；如果创建者在这两步之间崩溃，目录会永久停在 `0770`，另一账号无法修复。作者说法 2“并发时不会因为对方建的目录权限不对而失败”不成立。
- **证据**：
  ```js
  mkdirSync(directory, { recursive: true });
  const info = lstatSync(directory);
  ...
  if ((info.mode & 0o7777) === SHARED_MODE) return;
  if (info.uid !== process.getuid()) fail("DIRECTORY_MODE");
  chmodSync(directory, SHARED_MODE);
  ```
  当前 DAG 里第一个 put 是单独运行的 `policy`，大大降低了碰撞概率，但没有从代码上消除。
- **建议**：用 `mkdirSync(directory, { recursive: true, mode: 0o2770 })` 原子建立（umask 不会去掉 setgid 位），并对已存在但模式错误的目录给出可恢复的清理路径；补一个不同 uid/并发创建的测试。

### 5. 低-中（读代码证实）：`collect` 的失败只进 `missing` 文本，`get` 部分失败时可能留下可被 `required` 接受的报告
- **文件:行**：`scripts/ci/run-share.mjs:100-104,117-129,153-157`、`scripts/ci/required.mjs:25`
- **问题**：`get` 只有“摘要不一致”时删除 `to`；`cpSync` 抛错或 `treeDigest(to)` 因特殊文件/权限抛错时不会删除。`collect` 捕获所有错误后继续，`dispatch` 返回字符串，进程退出码仍为 0。`required` 直接读取 `.ci-output/reports`，因此如果失败发生在复制之后且报告主体仍完整（例如多出一个 FIFO/不可读文件，或磁盘在复制额外文件时出错），`required` 仍可能判通过。这与“缺报告必失败”的保证有窄缺口。
- **证据**：
  ```js
  cpSync(source, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
  if ((await treeDigest(to)) !== digest) {
    rmSync(to, { recursive: true, force: true });
    fail(`DIGEST_MISMATCH:${name}`);
  }
  ```
  `collect`：
  ```js
  try { await get(...); } catch (error) { missing.push(error.message); }
  ```
  `required.mjs` 直接取目录：`reports: existsSync(reports) ? readReportEnvelopes(reports) : []`。
- **建议**：`get` 用 `try/catch/finally` 保证任何失败都删除 `to`；`collect` 在 `missing` 非空时让步骤失败（或把 `missing` 输出给 `required` 并参与判定），不要仅依赖残留文件的二次判定。

### 6. 低（读代码证实的边界）：安装回滚不恢复“已存在的共享目录”的原权限/属组，可能留下指向已删除组的目录
- **文件:行**：`scripts/operations/ci-runner/install-runner.sh:89-96`、`scripts/operations/ci-runner/runners.sh:108-114,160-170`
- **问题**：`record_created_paths` 只记录原本不存在的路径；`install -d -m 2770 -o root -g gh-ci-share` 会修改已存在目录的权限/属组。若 `/srv/gh-runner-share` 预先存在而 `gh-ci-share` 组是本次新建，后续失败回滚会删除组，但目录仍保留（且 GID 已失效）。这正是 I-73 式“产生方和使用方两端不一致”的边界。
- **证据**：
  ```sh
  record_created_paths "$BACKUP" "$RUNNER_SHARE_ROOT"
  install -d -m 2770 -o root -g "$RUNNER_SHARE_GROUP" "$RUNNER_SHARE_ROOT"
  ```
  `record_created_paths`：
  ```sh
  [ -e "$path" ] || [ -L "$path" ] || printf '%s\n' "$path" >> "$backup/created-paths"
  ```
  回滚最后删除 `created-groups`。
- **建议**：把共享目录加入 `backup_install_paths` 的 manifest（或单独记录原 owner/mode），回滚时恢复；或者对预先存在的目录明确拒绝安装。补上失败时 `groupdel gh-ci-share` 的断言。

### 7. 低（读代码证实）：I-93 的门槛说明仍引用已删除的 `full-permissions` 反向用例
- **文件:行**：`docs/incidents-and-gates.md:127`、`scripts/ci/main-workflow.mjs:60`、`test/tooling/ci-optimization.test.mjs:197-204`
- **问题**：I-93 行仍写“把 `main.yml` 退回修复前……报 `full-permissions`”，并称 `main-workflow.mjs` 要求 `full` 带 `actions: write`。本 PR 后 `main-workflow.mjs:60` 已改为 `assert(!full.secrets && !full.with && !full.permissions, "full-inputs")`，对应测试也改成了给 `ci.yml.required` 加回写权限。该行的证据描述与当前代码/测试不一致（虽有后续追加说明，但前半句仍会误导）。
- **证据**：`main-workflow.mjs:60`：
  ```js
  assert(!full.secrets && !full.with && !full.permissions, "full-inputs");
  ```
  I-93 行仍保留“`main-workflow.mjs` 要求 `full` 带 `actions: write`（`full-permissions`）”。
- **建议**：把 I-93 的旧证据标为历史，或改写为当前真实反向用例（给 `ci.yml.required` 加 `actions: write`，断言 `full-grants-actions-write`）；不要再引用 `full-permissions`。

### 8. 低（读代码证实）：共享目录的可写范围比 ADR 描述更大
- **文件:行**：`scripts/operations/ci-runner/gh-runner.service.in:36`、`scripts/ci/run-share.mjs:26-32`、`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:90`
- **问题**：服务把整个 `/srv/gh-runner-share` 加进 `ReadWritePaths`，目录 `2770` 组可写；`run-share.mjs` 只限制自己的 `run` 名，无法阻止任务代码直接读写/删除其他运行的目录。ADR 的后果只写“一个任务能改另一个 runner 正在用的本次文件”，低估了范围（可影响所有并发运行）。
- **证据**：
  ```ini
  ReadWritePaths=@ROOT@/runner @ROOT@/home @ROOT@/logs @SHARE@
  ```
  ADR：“一个任务能改另一个 runner 正在用的本次文件。”
- **建议**：更新 ADR/Runbook 准确描述“同组任务可访问所有运行目录”；若要保持隔离，需按运行或按作业再分层权限（ACL/独立子目录属主），否则明确接受该风险。

## 对作者五条说法的核对

1. **部分正确**：`put/get` 的摘要核对确实能发现内容被改或缺失（`run-share.mjs:72-105`）。但“矩阵每成员只设置自己的 output 键、其他键为空不覆盖”没有任何仓库内验证；矩阵输出合并语义未核实，见第 1 条。
2. **配置上成立，并发语义不成立**：`SupplementaryGroups`、`2770`、`660` 的配置是齐的（`gh-runner.service.in:12,36`；`run-share.mjs:19-20,40-57`）；但运行目录创建不是原子设置 `2770`，不同账号同时创建时可能失败，见第 4 条。且现有测试都在同一 uid 下（`test/tooling/run-share.test.mjs:46-59`），没有跨账号验证。
3. **正确，但有窄缺口**：缺报告时 `required.mjs` 的 `expectedMembers`/`needs` 规则会判失败（`aggregate.mjs:172-176`），不会因 `collect` 部分缺失直接通过；但 `collect` 吞掉错误且可能留下副本，见第 5 条。
4. **对“本次新建”的组和目录成立**：回滚先删 `created-paths` 再删 `created-groups`（`runners.sh:160-170`），新建组/目录会被删除；对“原本已存在的共享目录”不成立，见第 6 条。另外失败回滚和 `uninstall all` 删除组的正向断言在测试里缺失（`ci-runner-scripts.test.mjs:1282-1284,1391`）。
5. **成立**：`ci.yml` 顶层只有 `contents: read`、`pull-requests: read`（`ci.yml:21-23`），所有 job 不再有 `permissions`；`main.yml` 顶层授予 `contents/actions/pull-requests: read`（`main.yml:5-8`），`validateCallerGrantsCalledPermissions` 能证明调用方覆盖 `ci.yml` 的申请（`main-workflow.mjs:14-36`）。但 I-93 的旧证据描述已过期，见第 7 条。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本 PR 只改 `.github/workflows/ci.yml`、`main.yml`、`scripts/ci`、`scripts/operations/ci-runner`、文档和测试；没有改动任何系统提示、工具定义、历史消息、出口遮盖或会话压缩代码（`git diff --stat` 可证）。发给模型的内容仍然只在末尾追加，每轮变化的时间/记忆/环境仍只在最后一条用户消息里；本 PR 不新增模型可见字段。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**对模型请求不会。** 本 PR 没有模型请求相关改动。CI 侧新摘要也是对排序后的相对路径、文件 SHA-256 和字节数做确定性计算（`run-share.mjs:59-65`；`artifact-files.mjs:40-42,71`），不含时间、运行号或无序集合；`runName` 含 attempt，但只用于 CI 目录，不进入模型内容。理论上的 `localeCompare` 依赖进程 locale，但 put/get 在同一 CI VPS 的同一锁定 Node 上，且与模型请求无关。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
有，但**不完整**。`test/tooling/run-share.test.mjs` 覆盖 put/get/collect/remove、摘要不符、缺失、同名、空目录、符号链接、根目录/运行号校验和 umask；`gate-lifecycle.test.mjs` 覆盖 CLI 与篡改；`policy.test.mjs` 覆盖输出键、put/get/collect/remove 配置的多种反向；`ci-runner-scripts.test.mjs` 覆盖清理、定时器、服务单元、安装/卸载。
但：
- “禁止 `actions/download-artifact`”的反向用例实际先被 SHA 检查拦下，删掉新规则也不会失败（第 3 条）。
- 矩阵输出的运行时合并没有测试（第 1 条）。
- 跨 uid、并发创建共享目录没有测试（第 4 条）。
- 安装回滚删除新建组、`uninstall all` 删除组没有正向断言（`ci-runner-scripts.test.mjs:1282-1284,1391`）。
- 未执行测试，以上均为读测试源码和实现后的判断。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？
逐项核对：
- `linux-x64` 摘要：`run-share.mjs put --output-key "$CI_MATRIX"`（`ci.yml:164`）→ `build.outputs.linux-x64`（`ci.yml:173-174`）→ `browser/coverage` 的 `CI_BUILD_DIGEST`（`ci.yml:227,282`）→ `run-share get` 的 `DIGEST` 校验（`run-share.mjs:94`）。两端格式一致。
- `chromium/firefox/webkit` 摘要：`browser` put（`ci.yml:242`）→ 三个 job outputs（`ci.yml:182-185`）→ `required` 的 `CI_NEEDS`/`publishedMembers`（`ci.yml:383`；`run-share.mjs:107-115`）。名称一致；但依赖矩阵合并，见第 1 条。
- `default` 摘要：policy/static/coverage/security 的 put 与 outputs（`ci.yml:35-36,80-81,259-260,310-311`）→ required collect。一致。
- `CI_NEEDS`：`toJSON(needs)` → `JSON.parse`（`run-share.mjs:155`），只接受 64 位十六进制摘要；成员名经 `checkedName` 校验。可接受。
- `CI_BUILD_DIGEST` → `DIGEST` 正则（`run-share.mjs:94`）。可接受。
- `HIMAWARI_CI_SHARE`：由 `gh-runner.service.in:21` 注入 → `shareRoot` 要求绝对路径且非符号链接（`run-share.mjs:26-32`）。可接受；但只在 CI VPS 上有效，托管 runner 会以 `CI_SHARE_ROOT_REQUIRED` 失败（ADR 已说明）。
- `gh-ci-share`、`/srv/gh-runner-share`、`360`：`runners.sh:5-7` → 服务模板/安装/清理/卸载，命名一致；回滚的预存在目录边界见第 6 条。
- 删除的 `artifact-output.mjs`、`delete-run-reports.mjs`：代码中已无引用；仅历史资格证据 JSON 里还列着文件名，但不参与当前校验。`quality.yml:300` 仍按 `report-` 下载，按 ADR 0238 它处于停用状态，重新启用前必须改。
- `ci.yml` 的 job 数量和 DAG 未变；`main.yml` 的 `full` 不再单独授权，权限覆盖检查通过（`main-workflow.mjs:14-36`）。
