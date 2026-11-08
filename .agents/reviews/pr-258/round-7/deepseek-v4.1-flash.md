## 核对结论

三个工作流文件与 origin/main（`ce1bcbee`）**逐字相同**：`git diff ce1bcbee..a22e487e -- .github/workflows/` 无输出；`git diff --stat 1049b4c5..a22e487e` 也只有 `ci.yml`、`main.yml`、`quality.yml` 三个文件。合并本身没有文本冲突，也没有丢掉本 PR 对工作流的改动（`b9d90717..1049b4c5` 对工作流无改动）。

但合并把 main 的“删除 actions/cache、保留期改为 1 天”带进来后，分支上的消费方没有同步，CI 会出错，且不止作者提到的 `check:ci-policy`。

## 读代码证实的问题（按严重度）

### [高] 删除缓存后，tooling 测试仍要求每个 job 都有 actions/cache

- 文件：`test/tooling/ci-optimization.test.mjs:68-81`
- 问题：合并后 `ci.yml` 已完全没有 cache 步骤，但这个测试仍断言全部 job 都有 `actions/cache@`。该文件属于 `tooling` 项目，`ci/policy.json` 的 `coverage` 检查会运行 `unit/contracts/tooling/integration`，所以 CI 的 coverage 作业会失败。合并前分支上的 `ci.yml` 有缓存，这个测试是过的；合并后翻红。
- 证据：

  ```js
  it("完整 CI 使用缓存与最小汇总依赖，并保留全部检查", () => {
    ...
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps.some((s) => s.uses?.startsWith("actions/cache@"))).toBe(true);
    }
  ```

  当前 `ci.yml:45-49` 只有 `setup-node` 后直接 `安装并核验固定工具`，没有任何 cache 步骤。
- 建议：与 main 的工作流迁移同批更新该测试（改为断言无缓存/冷安装），或在测试更新前保留缓存步骤。不能只处理 `check:ci-policy`。

### [高] 保留期 1 天与 quality policy 的 30/7 不一致，且修复点不止 workflow

- 文件：`.github/workflows/quality.yml:55,63`、`ci/quality-policy.json:15`、`scripts/ci/quality-policy.mjs:44`、`ci/policy.schema.json:188-193`、`test/tooling/quality-policy.test.mjs:23`
- 问题：作者已声明 `check:ci-policy` 在 main 上就失败，但影响范围被低估了：
  1. `test/tooling/quality-policy.test.mjs:23` 的 `expect(validate(document)).toBe(true)` 也会失败；
  2. 只把 `ci/quality-policy.json` 改成 1/1 仍然不行，因为 `quality-policy.mjs` 把值写死为 30/7，`policy.schema.json` 也把 30/7 写死为 `const`。
- 证据：

  ```js
  // scripts/ci/quality-policy.mjs:44
  retentionDays: constant({ reports: 30, diagnostics: 7 }),
  ```

  ```json
  // ci/quality-policy.json:15
  "retentionDays": { "reports": 30, "diagnostics": 7 },
  ```

  ```json
  // ci/policy.schema.json
  "reports": { "const": 30 },
  "diagnostics": { "const": 7 }
  ```

  而 `quality.yml:55,63` 已经是 `retention-days: 1`。
- 建议：把另一线程的修复范围明确成四处一起改：workflow、`ci/quality-policy.json`、`scripts/ci/quality-policy.mjs` 的常量、`ci/policy.schema.json`（以及相关测试）；否则 `check:ci-policy` 无法真正转绿。

### [中] 报告 artifact 只保留 1 天，但交接证据仍按 30 天接收并声明 30 天有效期

- 文件：`.github/workflows/ci.yml:65-68`、`.github/workflows/quality.yml:296-307`、`scripts/ci/export-evidence.mjs:106-112,161`
- 问题：`ci.yml` 的 `report-*` artifact 现在只保留 1 天；`quality.yml` 的 handoff 按 `run-id` 下载这些 artifact 时没有 `continue-on-error`；而 `export-evidence` 仍接受 30 天内的运行，并写出 `expiresAt = created + 30 天`。如果 handoff 在 1 天后运行，下载 artifact 会直接失败，且证据声称的有效期与实际保留期不符。`ci.yml` 的保留期改动没有任何现有 policy 检查覆盖（quality policy 只校验 `quality.yml`）。
- 证据：

  ```yaml
  # ci.yml
  name: report-...-policy-...
  path: .ci-output/public/reports/
  if-no-files-found: error
  retention-days: 1
  ```

  ```js
  // export-evidence.mjs
  now - created >= policy.retentionDays.reports * 86_400_000
  ...
  expiresAt: new Date(created + policy.retentionDays.reports * 86_400_000).toISOString(),
  ```

  ```yaml
  # quality.yml handoff
  uses: actions/download-artifact@...
  with:
    run-id: ${{ inputs.ci_run_id }}
    pattern: report-${{ inputs.ci_run_id }}-${{ steps.metadata.outputs.attempt }}-*
  ```

- 建议：让 artifact 保留期覆盖证据有效期，或把证据/交接有效期同步降到 1 天，并在 handoff 中显式处理 artifact 已过期的情况。

## 推测 / 未核实

- 我没有实际运行 CI，只是按测试代码逻辑判断上述测试会失败。
- 删除缓存后冷安装是否会触发 job 超时，未核实；没有运行时长数据。
- handoff 是否会在 CI 运行 1 天后才被触发，取决于实际使用节奏，无法从代码判断；但一旦发生，上述下载失败路径是确定的。
- main 分支自身当前是否还有其他失败测试，未全面运行核对。

## 侧重检查

- **错误路径**：检查了 handoff 的 artifact 下载、`export-evidence` 的过期判断、`install-dependencies` 在无缓存时的行为。无缓存时 `installDependencies` 会判为 `cold` 并继续，不会因缺少缓存目录直接失败。
- **不合规范/不可信输入**：本次增量只改 workflow 的保留期和缓存步骤，没有新增 `${{ }}` 插入 shell、权限扩大或未固定 SHA 的 action；`contents: read` 等限制未变。
- **安全**：未发现合并引入秘密、写权限或未锁定 action。
- **资源耗尽**：删除缓存会显著增加重复下载/安装成本，但没有代码证据表明会超时；保留期缩短减少存储，但与 30 天交接证据有效期冲突（见上）。
- **不可撤销操作**：artifact 1 天后删除不可恢复；因此 handoff 证据的 30 天声明具有实际风险。
- **清单/配置两端一致性**：`actions/cache` 仍留在 `ci/toolchain-lock.json`，`install-tools.mjs:118-130` 仍要求它存在，这一端目前还能通过；但测试端要求它出现在 workflow 中，已不一致。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮合并增量不会。`git diff --stat 1049b4c5..a22e487e` 只有三个 `.github/workflows/*.yml`，没有任何系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容没有因这次合并发生变化。PR 主体（sensitive-log）本轮没有重新逐行复核，标记为沿用上一轮结论、未重新核实。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   本轮合并不涉及模型请求构造，不会。改动的值是 `retention-days` 和是否使用缓存，均只影响 CI artifact/安装路径，不进入模型输入，也不依赖前后文或无序集合。

3. **改动有没有对应的自动检查，反向用例是否真的会失败？**
   有检查，但这次没有同步更新，而且反向用例的覆盖不完整：
   - `test/tooling/ci-optimization.test.mjs` 直接断言缓存步骤存在，合并后正向用例失败；它没有“允许无缓存”的反向用例。
   - `test/tooling/quality-policy.test.mjs:19-23` 的正向用例会因保留期不一致失败；它的变异用例（如 `:262` 把 diagnostics 改成 30）仍会失败，但测的仍是旧的 30/7 假设。
   - `test/tooling/policy.test.mjs:54-78` 现在即使不删除 `dependencies` job，未修改的 `quality.yml` 也已经因保留期不匹配而失败，导致该反向用例“通过”但不再证明删除 job 能被发现，属于假阴性风险。
   - `ci.yml` 的保留期 1 天没有对应的 policy 校验，是最需要补检查的地方。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   - `retention-days: 1`：产生于 `quality.yml:55,63`、`ci.yml:65-68` 等；使用/校验方包括 `quality-policy.mjs:44`（只接受 30/7）、`ci/quality-policy.json:15`（30/7）、`ci/policy.schema.json`（30/7）、`test/tooling/quality-policy.test.mjs`（按 30/7 构造期望 job），全部不能接受。
   - `report-*` artifact 的 1 天保留期：使用方是 `quality.yml` handoff 的 artifact 下载和 `export-evidence.mjs` 的 30 天 TTL，两端不一致。
   - 删除 `actions/cache` 使用：workflow 不再需要它，但 `test/tooling/ci-optimization.test.mjs:80` 仍要求它；`ci/toolchain-lock.json` 与 `install-tools.mjs:118-130` 仍要求清单里包含它（当前还能通过，但不能顺手删掉锁项）。
   - job/check id：合并没有改 job 名，`quality-policy.mjs` 的 checks 列表仍匹配，这一项可接受。
