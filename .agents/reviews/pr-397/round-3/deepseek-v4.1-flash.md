## 结论

改动本身的 CI 迁移方向基本成立，新增上传规则的 7 个现有 `ci.yml` 上传也不会被误拦。但「上传只许诊断目录」这条硬规则只覆盖 `ci.yml`，**`main.yml` 的 main confirmation 仍会把构建报告里的构建归档上传到 GitHub**，这与 ADR 0238「GitHub 上只留几 KB」的目标冲突，是本轮最值得先处理的问题。

---

## 发现（按严重度从高到低）

### 高：`main.yml` 仍会把大构建归档传回 GitHub，新规则没有覆盖

- 文件:行
  - `.github/workflows/main.yml:95-102`
  - `scripts/ci/main-confirm.mjs:71-78`
  - `scripts/ci/publish.mjs:79-109`
  - `scripts/ci/run.mjs:449-480`
  - `scripts/ci/check-policy.mjs:1329-1334`

- 问题
  `main.yml` 的 `confirm` 作业在 light 模式下会把整个 `.ci-output/main-public/` 上传为 `main-confirmation-*`。这个目录由 `main-confirm.mjs` 调用 `publish` 生成；`publish` 会把 `report.kind === "artifact"` 的二进制文件原样复制进 `reports/`；`run.mjs` 的 `build` 检查又会把构建归档作为 `artifact` 报告写进结果。因此 `main-confirmation-*` 里包含构建归档。ADR 0238 自己写的是 build 报告约 55 MB，原因正是把构建归档复制进报告（`docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:33`）。结果是在 main 的 light 确认路径上，GitHub 产物额度仍会按每轮几十 MB 增长。

  另外，新上传硬规则只对 `check-policy` 默认读取的 `ci.yml` 执行（`check-policy.mjs:1329-1334`），`main.yml` 没有经过 `validateWorkflow`，所以不会拦住这个上传。

- 证据
  ```yaml
  # .github/workflows/main.yml:95-102
        - name: 保存 main 确认报告
          if: always()
          uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
          with:
            name: main-confirmation-${{ github.run_id }}-${{ github.run_attempt }}
            path: .ci-output/main-public/
            if-no-files-found: error
            retention-days: 1
  ```
  ```js
  // scripts/ci/main-confirm.mjs:71-78
        await publish([
          "--input", directory,
          "--output", path.join(root, ".ci-output/main-public", checkId),
          "--tools", toolsDirectory,
        ]);
  ```
  ```js
  // scripts/ci/publish.mjs:79-109
        for (const report of result.reports) {
          ...
          const target = path.join(diagnostic ? diagnostics : reports, report.path);
          const binary = diagnostic || report.kind === "artifact";
          if (binary) copyFileSync(source, target);
          ...
          if (!diagnostic) retained.push(reportEntry(target, report.kind, reports));
  ```

- 建议
  1. `main-confirm` 不要把 `artifact` 报告发布进 `.ci-output/main-public/`，只发布脱敏摘要/结果；构建归档如果要留证据，放到共享目录或只保留摘要。
  2. 把上传规则扩展到 `main.yml`（允许 `main-evidence/`、`gate/` 和明确的小报告目录，拒绝带构建归档的 `main-public`），并增加反向用例：把 `.ci-output/main-public/build` 这种包含大归档的路径放进去必须失败。
  3. `quality.yml` 重新启用前也要套同一规则；目前它仍上传 `.ci-output/public/reports/`（`.github/workflows/quality.yml:48-55`），ADR 只写了「重新启用时要改」。

---

### 中：新上传硬规则只覆盖 `ci.yml`，ADR 的「任何作业」说法过宽

- 文件:行
  - `scripts/ci/check-policy.mjs:499-506`
  - `scripts/ci/check-policy.mjs:1329-1334`
  - `docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:64`
  - `.github/workflows/main.yml:39-45,86-90`
  - `.github/workflows/quality.yml:48-55`

- 问题
  新规则本身没有误拦 `ci.yml` 的 7 个上传：6 个诊断目录 + 1 个 `.ci-output/gate/`，路径和 `retention-days: 1` 都匹配（`.github/workflows/ci.yml:68-73,115-120,167-172,245-250,298-303,345-350,390-395`）。但它只对 `ci.yml` 生效。

  ADR 0238:64 写的是「任何作业带写权限、用 `actions/download-artifact`、上传诊断目录……以外的东西……都失败」。代码事实是：
  - `main.yml` 仍使用 `actions/download-artifact`（`main.yml:39-45,86-90`），且 `validateMainWorkflow` 还要求它存在；
  - `quality.yml` 仍上传 `.ci-output/public/reports/`；
  - 新规则并不检查 `actions/cache`、第三方 action、`run:` 里的 `gh`/`curl` 等上传方式（`actions/cache` 只是被另一个测试 `test/tooling/ci-optimization.test.mjs:88-101` 拦住）。

- 证据
  ```js
  // scripts/ci/check-policy.mjs:499-506
  const uploadPath =
    check.id === "required" ? ".ci-output/gate/" : ".ci-output/public/diagnostics/";
  assert(
    job.steps
      .filter((step) => /^actions\/upload-artifact@/u.test(step.uses ?? ""))
      .every((step) => step.with?.path === uploadPath && step.with?.["retention-days"] === 1),
    `Jobs may upload only ${uploadPath} to GitHub for one day: ${check.id}`,
  );
  ```
  ```js
  // scripts/ci/check-policy.mjs:1329-1334
  const workflow = path.resolve(root, args["--workflow"] ?? ".github/workflows/ci.yml");
  validateWorkflow(proposed, readFileSync(workflow, "utf8"), lock);
  ...
  validateWorkflow(source.policy, readFileSync(workflow, "utf8"), lock);
  ```

- 建议
  把 ADR 的表述改成「`ci.yml` 的作业」，或者把规则做成所有工作流通用的白名单；至少在 ADR 里明确 `main.yml/quality.yml` 当前仍是例外，避免后来的人把这句话当成已经覆盖全部工作流。

---

### 低：`install_runner_share` 在「组和目录都已存在」时会接管目录属性，且这一分支没有测试

- 文件:行
  - `scripts/operations/ci-runner/install-runner.sh:89-99`
  - `scripts/operations/ci-runner/runners.sh:108-114,132-149`
  - `test/tooling/ci-runner-scripts.test.mjs:1263-1271`

- 问题
  代码只在「组不存在」时拒绝已存在的目录：
  ```bash
  if ! getent group "$RUNNER_SHARE_GROUP" > /dev/null; then
    if [ -e "$RUNNER_SHARE_ROOT" ] || [ -L "$RUNNER_SHARE_ROOT" ]; then
      echo "... refusing to take over a directory this script did not create" >&2
      return 71
    fi
    ...
  fi
  record_created_paths "$BACKUP" "$RUNNER_SHARE_ROOT"
  install -d -m 2770 -o root -g "$RUNNER_SHARE_GROUP" "$RUNNER_SHARE_ROOT"
  ```
  如果组和目录都已存在，脚本不会进入拒绝分支，而是继续执行 `install -d -m 2770 -o root -g gh-ci-share`，对已有目录设置属主/组/权限。`record_created_paths` 只记录「执行前不存在」的路径，所以已有目录不会进入备份清单，失败回滚也不会恢复它原来的 mode/owner。

  因此，如果第 2 轮 ds-3 的判断是「组和目录都存在只可能是上次安装留下的，所以照常安装没问题」，这个理由在**正常重装**场景下成立；但它不是代码验证出来的事实：脚本没有检查目录属主、组、内容或安装标记，也不能区分人为预建的同名目录。现有测试 `refuses to take over a share directory whose group it would have to create` 只覆盖「组不存在 + 目录存在」，没有覆盖「组存在 + 目录存在」。

- 证据
  上面的 `install_runner_share` 代码；测试只构造了 `mkdir -p /srv/gh-runner-share` 且 fake `getent` 始终失败（`ci-runner-scripts.test.mjs:1177,1263-1271`），所以走的是「组不存在」分支。

- 建议
  如果「组存在即表示目录属于本项目」是明确前提，写进 ADR/Runbook 并补一条「组和目录都存在」的正向测试；否则在接管前检查目录属主/组/mode 或加安装标记，不满足就拒绝，或至少把原属性纳入备份/回滚。

---

### 低：「只重跑失败作业」时文档写的错误码和 `run-share` 实际检查顺序不完全一致

- 文件:行
  - `scripts/ci/run-share.mjs:92-97`
  - `scripts/ci/run-share.mjs:114-135`
  - `docs/adr/0238-ci-job-files-stay-on-the-ci-vps.md:92`
  - `docs/runbooks/ci-vps-runner-runbook.md:260`

- 问题
  文档说「只重跑失败的作业」时取构建的作业以 `CI_SHARE_MISSING` 失败，汇总作业会列出缺失。按代码：
  ```js
  if (!DIGEST.test(digest ?? "")) fail("DIGEST_INVALID");
  ...
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`MISSING:${name}`);
  ```
  `digest` 校验在 `MISSING` 之前。如果新尝试号下 `needs.build.outputs.linux-x64` 为空/无效，先得到的是 `CI_SHARE_DIGEST_INVALID`，不是 `CI_SHARE_MISSING`。另外 `publishedMembers` 会把摘要不合法的 output 直接过滤掉（`run-share.mjs:114-121`），所以这种情况 `collect` 也不会输出 `CI_SHARE_COLLECT_MISSING`；只有摘要合法但文件不存在时才会走 `MISSING`。

  我没有实际重跑 GitHub 来确认「Re-run failed jobs」是否保留上一尝试的 job outputs，因此这里只确认「按当前代码顺序，空/无效摘要不会报 MISSING」。

- 证据
  `run-share.mjs:94` 先 `DIGEST_INVALID`，`run-share.mjs:97` 才 `MISSING`；`publishedMembers` 第 120 行用 `if (DIGEST.test(digest))` 过滤。

- 建议
  把 Runbook/ADR 改成「空摘要先报 `CI_SHARE_DIGEST_INVALID`；摘要合法但文件缺失才是 `CI_SHARE_MISSING`」，并给「摘要为空/格式错误」的 collect 行为补一个自动用例。

---

## 推测与未核实

- **推测：`treeDigest` 的排序可能受 locale 影响。** `collectArtifactFiles` 用 `a.name.localeCompare(b.name)` 排序（`artifact-files.mjs:40-42`），`treeDigest` 按这个顺序序列化（`run-share.mjs:59-64`）。如果 put 和 get 的 locale/ICU 不一致，同一棵树的摘要可能不同，导致误报 `DIGEST_MISMATCH`。两个 runner 在同一台机器、同一份锁定 Node 下通常一致，未实际制造不同 locale 验证。
- **推测：`put` 在摘要校验前调用 `shareGroupWritable`。** `run-share.mjs:80-86` 先 `cpSync`、`shareGroupWritable`，之后才 `treeDigest(staging)`；`shareGroupWritable` 对非目录条目直接 `chmodSync(filename, 0o660)`（`run-share.mjs:49-57`）。如果源目录在校验后被换成符号链接，`chmod` 可能作用到链接目标。初次 `treeDigest(from)` 已拒绝符号链接（`artifact-files.mjs:46`），所以这需要同一作业进程在极短窗口内经手改动源目录，实际可达性未确认。
- **未核实：Runbook 的 `contract_sha256` 是否与内容匹配。** 本轮只看到它从 `e5704cc7...` 改成 `f49586e3...`，环境禁止运行文档校验/哈希工具，无法复算。
- **未核实：作者说工作区里有 `.agents/reviews/pr-397/round-2/judgments.md`。** 当前是稀疏检出，工作区实际没有该文件；`git show` 也被环境拒绝，所以没有直接读到 ds-3 原文，只能按代码核对行为。
- **未核实：GitHub 在「Re-run failed jobs」时是否保留上一尝试的 job outputs。** 这会影响上面 docs 错误码问题具体落在 `DIGEST_INVALID` 还是 `MISSING`。

---

## 侧重检查

我按错误路径、不可信输入、资源/安全、不可撤销操作、规则与文档一致性查了这些：

- **错误路径**
  - `run-share` 对 root、run id、attempt、name、digest 都有正则校验；`shareRoot` 拒绝相对路径和符号链接根目录（`run-share.mjs:26-38,67-70,92-97`）。
  - `collect` 对每个成员单独 `try/catch`，一个缺失不会中断其他成员（`run-share.mjs:124-135`）。
  - `remove` 只删除 `root/<数字运行号>-<数字尝试号>`，路径遍历被 `runName` 的数字正则挡住。
  - `install_runner_share` 的退出码 71 与 Runbook:262 一致；测试也断言了 71（`ci-runner-scripts.test.mjs:1263-1271`）。

- **不合规范/不可信输入**
  - `CI_NEEDS` 由 `JSON.parse` 直接解析（`run-share.mjs:162`），格式错误会让 collect 步骤失败；这是失败关闭，不是静默接受。
  - `publishedMembers` 会丢弃格式不合法的摘要，而不是把它们当合法成员；这导致上面「缺失不记录」的可观测性缺口。
  - 报告目录里的符号链接由 `collectArtifactFiles` 拒绝（`artifact-files.mjs:46`），`put`/`get` 都会经过它。
  - 上传规则只匹配 `actions/upload-artifact@`；无法拦截第三方 action、`actions/cache`、`run:` 里的上传命令，但当前作业权限已收回写权限，主要剩余风险是 `main.yml` 那个未被覆盖的上传。

- **安全与资源耗尽**
  - 两个 runner 可读写整个共享目录，ADR 已明确接受；摘要只能发现改动，挡不住有意改摘要的任务（ADR:90）。
  - `put`/`get` 没有大小上限，磁盘上限主要靠 job-started 的 16 GiB 下限和 `clean-old.sh` 的 6 小时清理；这与 ADR 的取舍一致。
  - `clean-old.sh` 以 root 运行，删除共享根目录下超过 6 小时的顶层条目（`clean-old.sh:24-25`）；`rm -rf` 对符号链接删除的是链接本身，不会跟随，未发现明显越界删除。

- **不可撤销操作**
  - `run-share remove` 删除本次运行目录，`Uninstall all` 删除共享目录和组，`clean-old.sh` 删除旧运行目录；Runbook 已警告 `uninstall-runner.sh all` 会删共享目录（Runbook:262）。
  - `install_runner_share` 对已有目录的 chown/chmod 不会回滚，见上面的低严重度发现。

- **规则文件/说明文档与代码一致**
  - `prompt-prefix.md` 未被改动，且本次改动不涉及请求组装代码。
  - ADR 0238:64 的「任何作业」与 `main.yml/quality.yml` 的现状不完全一致。
  - Runbook:260 对「只重跑失败作业」的错误码描述与 `run-share` 检查顺序不完全一致。
  - `docs/incidents-and-gates.md` 的 I-93 描述与 `validateCallerGrantsCalledPermissions`、`test/tooling/ci-optimization.test.mjs:130-204` 基本一致；`full` 不再单独授权由 `main-workflow.mjs:60` 的 `full-inputs` 拒绝，也与代码一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本次改动的文件是 CI 脚本、工作流、ADR/Runbook、测试和复核记录；没有任何 `packages/prompt-catalog`、`packages/runtime-pi`、`apps/agent-service` 的请求组装/系统提示/工具定义/遮盖代码被改。按 `.claude/rules/prompt-prefix.md:27-28,35`，固定内容仍在前面，历史仍只追加，每轮会变的值仍应在最后一条用户消息里；这次改动没有触碰这条链路。复核记录本身也不是生产模型的请求前缀。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** 没有改序列化、遮盖、时间字段或无序集合相关的请求代码。

新增的 CI 摘要存在一个理论上的字节稳定性问题：`treeDigest` 依赖 `collectArtifactFiles` 的文件名排序，而排序用 `localeCompare`，不是固定码点排序；如果两个 runner 的 locale/ICU 不同，同一棵树可能算出不同摘要。当前两个 runner 同机、同 Node，实际大概率一致，但未做跨 locale 验证。除此之外，`run-share` 的摘要序列化本身是 `[path, sha256, bytes]` 的固定数组，`publishedMembers` 的 locale 排序只影响缺失消息顺序，不影响摘要。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，但不完整：

- **新增上传规则**
  - 反向用例：`test/tooling/policy.test.mjs:604-617`，覆盖非诊断目录、诊断目录但 7 天、required 的非 gate 目录、required 的诊断目录。每一项只改动一个新规则的判定条件，按代码路径会命中 `Jobs may upload only`。
  - 正向用例：`policy.test.mjs:618-629`，诊断目录 1 天和 gate 目录 1 天通过。
  - 真实 `ci.yml` 的 7 个上传没有被新规则误拦：现有 `policyMain` 测试会读取真实 `ci.yml`（`policy.test.mjs:82-90`），如果上传路径不匹配，会先在该规则失败。
  - 未覆盖：`main.yml` 的 `main-public` 大上传、`quality.yml` 的报告上传、无上传步骤的作业、其他上传机制。

- **run-share 的 collect 标准错误**
  - `test/tooling/run-share.test.mjs:194-207` 直接构造“摘要合法但文件缺失”的场景，断言 stderr 为 `CI_SHARE_COLLECT_MISSING CI_SHARE_MISSING:browser-chromium`。按 `run-share.mjs:163-164` 的代码路径，这条会失败在缺失输出。
  - 未覆盖：摘要为空/格式错误时 `publishedMembers` 静默过滤、不输出 `CI_SHARE_COLLECT_MISSING` 的情况。

- **安装脚本退出码 71**
  - `test/tooling/ci-runner-scripts.test.mjs:1263-1271` 覆盖「组不存在 + 目录存在」并断言 71。
  - 未覆盖：「组存在 + 目录存在」的接管分支。

我受工具限制没有运行测试，以上是按代码路径判断；反向用例的判定条件都直接指向新增 assert，按代码会抛错。

### 4. 改动产生/修改的每个值，生产端和使用端都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| 作业输出键 `linux-x64` | `ci.yml:174` 的 `${{ steps.share.outputs.linux-x64 }}`；`run-share.mjs:152` 用 `--output-key "$CI_MATRIX"` 写入 | `ci.yml:227,282` 的 `needs.build.outputs.linux-x64`；`check-policy.mjs:550` 校验 | 生产端 `linux-x64` 与消费端一致；`run-share` 的 output-key 正则接受连字符；摘要再由 `get` 的 `DIGEST` 校验 |
| `default`、`chromium/firefox/webkit` 输出 | `ci.yml:36,81,183-185,260,311`；`run-share` 的 `--output-key "$CI_MATRIX"` | `required` 的 `toJSON(needs)` 生成 `job-member`；`check-policy.mjs:532-541` 校验 job outputs 与 active members 一一对应 | 一致 |
| 共享目录名 `build-linux-x64`、`browser-chromium` 等 | `run-share put --name "${check.id}-$CI_MATRIX"`（`ci.yml:164,242` 等） | `get --name build-linux-x64`（`ci.yml:228,283`）；`collect` 用 `${job}-${member}`（`run-share.mjs:120`）；`NAME` 正则 `^[a-z][a-z0-9-]{0,63}$` | 一致；`check-policy.mjs:524-554` 还锁定了 put/get 的完整命令 |
| 运行目录 `<run_id>-<attempt>` | `runName`（`run-share.mjs:34-38`） | put/get/collect/remove 都调用同一个 `runName`；`clean-old.sh` 按顶层目录清理 | 一致；GITHUB_RUN_ID/ATTEMPT 只允许正整数 |
| 上传路径 `.ci-output/public/diagnostics/`、`.ci-output/gate/` | `ci.yml` 的 7 个上传步骤 | `check-policy.mjs:499-506` 精确比较 | `ci.yml` 两端一致；`main.yml/quality.yml` 不经过这个校验 |
| 退出码 71、`CI_SHARE_*` 错误码 | `install-runner.sh:93`；`run-share.mjs` 的 `fail()` | Runbook:260/262、测试 | 71 一致；重跑失败作业时 `DIGEST_INVALID` 与 `MISSING` 的文档说明有偏差 |
| `contract_sha256` | Runbook 头部改动 | 文档治理校验 | 未运行文档校验，未能复算，标记未核实 |
| I-93 的 `full` 权限 | `main-workflow.mjs:60` 的 `full-inputs`；`validateCallerGrantsCalledPermissions` | `test/tooling/ci-optimization.test.mjs:130-204`；`docs/incidents-and-gates.md` I-93 | 代码、测试、文档基本一致 |

整体上，`ci.yml` 内部新产生的标识、输出键、共享目录名和摘要格式两端能对上；主要缺口是规则没有覆盖 `main.yml/quality.yml`，以及 `main.yml` 仍会产生大文件上传。
