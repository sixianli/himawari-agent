## 逐条问题（按严重度）

### 1. 中：必过闸门现在也接受 arm64 报告

- 文件:行：`scripts/ci/aggregate.mjs:102`、`scripts/ci/run.mjs:70-71,136`、`test/tooling/aggregate.test.mjs:401`
- 问题：`ci/required` 用的 `aggregate` 不再要求这三项检查的报告必须是 x64，而是接受 `arch` 或 `alternateArch`。试跑工作流本身不走 `aggregate`、也不交报告，因此这项放宽对试跑没有作用，却让必过闸门的平台校验变松。
- 证据：
  - `scripts/ci/aggregate.mjs:102-103`：
    ```js
    if (![member.arch, member.alternateArch].includes(result.toolchain.arch))
      fail(checkId, matrixKey, source, "Actual toolchain differs from matrix: arch");
    ```
  - `scripts/ci/run.mjs:70-71,136`：
    ```js
    export const memberRunsOnHost = (member, platform = process.platform, arch = process.arch) =>
      member.os === platform && [member.arch, member.alternateArch].includes(arch);
    ...
    if (hosted && !memberRunsOnHost(member)) throw new Error("CI_RUNNER_PLATFORM_MISMATCH");
    ```
  - `test/tooling/aggregate.test.mjs:401-407` 明确断言：`policy`、`static`、`security` 的 `toolchain.arch` 为 `arm64` 时 `aggregate(input).status` 必须是 `passed`。
- 影响：正常路由仍是 `ci.yml` → `ci-vps`（x64），试跑工作流也不写共享目录，所以这不是一条现有可触发的路径；但如果 `ci-vps` 标签被误加到 ARM 机器上（或将来有人改了 `runs-on`），这三项检查会在 ARM 上跑完并通过 `runCheck`，再由 `aggregate` 接受。改动前这里会报 `CI_RUNNER_PLATFORM_MISMATCH`。这与“试跑结论不进 `ci/required`”和 ADR 0253“ARM 不进 GitHub 必过检查”的文字承诺存在张力。
- 建议：本轮只让试跑走 ARM，`aggregate` 保持严格按 `member.arch` 校验；给 `runCheck` 加显式试跑标志（例如 `--allow-alternate-arch`），只有试跑工作流传该标志。等真正切换的 PR 再放宽 `aggregate`，并把反向用例改成“ci.yml 的 x64 检查收到 arm64 报告必须失败”。

### 2. 中：运行手册对“ARM 报告是否进汇总”自相矛盾

- 文件:行：`docs/runbooks/ci-vps-runner-runbook.md:180`、`:195`
- 问题：第 180 行说试跑“不往共享目录交报告”，第 195 行却写“ARM 上的检查把报告写在那台机器自己的 `/srv/gh-runner-share/...`”，并描述 `ci/required` 通过 `--remote-jobs` 取回报告。
- 证据：
  - `:180`：“……结论不进 `ci/required`，也不往共享目录交报告……”
  - `:195`：“**报告怎样回到汇总作业**：ARM 上的检查把报告写在那台机器自己的 `/srv/gh-runner-share/<运行号>-<重试号>/`。汇总作业在 CI VPS 上发现本机共享目录里没有某份报告、而命令行的 `--remote-jobs` 名单里有这个作业时……”
  - `.github/workflows/ci.yml:362` 实际的汇总步骤没有 `--remote-jobs`：
    ```yaml
    run: .ci-output/tools/bin/node scripts/ci/run-share.mjs collect --to .ci-output/reports
    ```
  - `.github/workflows/ci-arm-trial.yml` 三个作业都没有 `run-share.mjs put`。
- 影响：操作者可能误以为试跑已经向汇总交报告，或反过来以为远程取报告已接线。当前代码没有使用这条远程通道。
- 建议：把第 195 行明确标成“将来切到 ARM 时才会用到”，或在本轮删掉/改写；如果这是为切换准备的，至少写出当前没有工作流传 `--remote-jobs`。

### 3. 中低：测试引用了一个已从分支移除的 ADR（ADR-0260）

- 文件:行：`test/tooling/policy.test.mjs:1213,1241,1259,1268,1275`、`test/tooling/runner.test.mjs:360`、`test/tooling/aggregate.test.mjs:401`、`test/tooling/ci-runner-scripts.test.mjs:1991` 等
- 问题：多处测试标题带 `[ADR-0260]`，但仓库里没有 `docs/adr/0260-*`。历史显示 ADR 0260 是在本分支之前被明确移出的。
- 证据：
  - `glob docs/adr/0260*` 无结果。
  - `git log` 可见提交 `d4e2ab0d5 docs(adr): ADR 0260 先移出本分支，等核对费用获批后单独开 PR`，它删除 `docs/adr/0260-oracle-arm-machine-runs-three-ci-checks.md`。
  - `docs/adr/0253-support-linux-arm64-for-test-and-qualification.md:61`：“ARM 不进 GitHub 必过检查，也不切线上”；`:65` 明确说这一阶段不改 `ci/policy.json`、`check-policy.mjs`、`aggregate.mjs` 和工作流文件。
- 影响：审计链断裂；自动的 `check:adr-numbers` 只查 `docs/` 里带 `docs/adr/` 前缀的链接，不会发现测试标题里的裸 `[ADR-0260]`，所以门禁不会报错。代码变更本身又改了 ADR 0253 说“不改”的那些文件。
- 建议：要么恢复/补上 ADR 0260 并在 PR 里建立关联，要么把测试标题改成实际依据（计划或运行手册）；同时更新 ADR 0253 或新增决定说明本阶段对 policy/gate 的改动。

### 4. 低：ARM 安装脚本的成功提示已经过时

- 文件:行：`scripts/operations/ci-runner/install-arm-runners.sh:98`
- 问题：安装成功后仍打印“no workflow uses ci-arm yet, so nothing runs there until the workflow change is merged”，但本 PR 已经加了使用 `ci-arm` 的试跑工作流。
- 证据：
  ```sh
  echo "ARM_INSTALL_OK ...; no workflow uses $RUNNER_ARM_LABEL yet, so nothing runs there until the workflow change is merged"
  ```
- 影响：合并后按手册安装/重装 ARM runner 时，操作者会被误导。现有测试只断言前缀：
  - `test/tooling/ci-runner-scripts.test.mjs:2766-2768` 只检查 `ARM_INSTALL_OK runners=ci-arm-1 ...` 前缀，所以不会失败。
- 建议：改成“现在由 `.github/workflows/ci-arm-trial.yml` 使用 ci-arm”，并让测试断言新的完整提示。

### 5. 低：试跑工作流没有进入 `check-policy` 的结构校验；安全/资源边界只靠测试

- 文件:行：`scripts/ci/check-policy.mjs:1417`、`.github/workflows/ci-arm-trial.yml:12-14,22,55,90`、`scripts/operations/ci-runner/arm-fallback.sh:68-76`
- 问题：`check-policy` 默认只校验 `.github/workflows/ci.yml`，试跑工作流的权限、Action SHA、`if` 条件、`runs-on` 等不在 `validateWorkflow` 覆盖范围内；只有 `policy.test.mjs` 的少量断言和 actionlint。actionlint 不强制 Action 使用完整 SHA。
- 证据：
  - `scripts/ci/check-policy.mjs:1417`：
    ```js
    const workflow = path.resolve(root, args["--workflow"] ?? ".github/workflows/ci.yml");
    ```
  - 新测试 `test/tooling/policy.test.mjs:1275-1292` 只比较作业集合、`runs-on`、`on`、`permissions`、检查命令和“没有 run-share”，没有校验 Action 固定 SHA、checkout 的 `persist-credentials: false`、各作业的草稿条件。
- 安全/资源影响（条件性）：
  - 试跑在 `pull_request` 事件下把 PR 代码放到自托管的 Oracle ARM 机器上执行，权限只有 `contents: read`、`pull-requests: read`；但 `security`/`publish` 步骤会拿到 `github.token`。如果仓库公开或 fork PR 未加审批，这是把不可信代码放到 Andy 的测试机上执行；仓库可见性和 fork 审批设置不在代码里，**未核实**。
  - 试跑没有跨 PR 的全局并发上限：`concurrency` 只按 PR 号取消，多个 PR 可以同时占满两个 ARM runner，每个作业最长 60 分钟。
  - `arm-fallback.sh on` 会把 `ci-arm` 加到 CI VPS 的检查 runner 上（`arm-fallback.sh:68-76`）。因此“ARM 试跑不占 CI 服务器”只在 ARM 正常在线时成立；应急期间试跑任务会落到 CI VPS。
- 建议：给试跑工作流加一个与 `validateWorkflow` 类似但更小的专用校验（至少权限、Action SHA、`runs-on`、草稿条件、无 run-share）；在文档里明确应急期间试跑会占用 CI VPS；如仓库可能公开，限制为同仓库 PR 或要求 fork 审批。

## 侧重检查

- **错误路径**：试跑工作流失败不会进入 `ci.yml` 的 `needs`，`ci/required` 只等 `ci.yml` 的六个作业；试跑不写共享目录，因此不会把失败或报告传给汇总。`publish` 失败时 `ci-summary` 会跳过，和 `ci.yml` 现有模式一致。结论：试跑失败不影响必过结果。
- **不合规范/不可信输入**：`ci-arm-trial.yml` 在自托管 `ci-arm` 上执行 PR 代码，`permissions` 为只读，没有 `upload-artifact`/`download-artifact`/cache，Action 使用了完整 SHA；但试跑工作流本身不经过 `validateWorkflow`，且 `security` 步骤持有只读 `github.token`。运行时是否允许 fork PR 取决于 GitHub 仓库设置，**未核实**。
- **安全**：当前试跑权限为 `contents: read`、`pull-requests: read`，没有写权限；`arm-fallback.sh` 只改标签，不涉及密钥。主要风险是把不可信代码放到个人测试机执行，以及上面第 1 条的闸门放宽。
- **资源耗尽**：两个 ARM runner、三个作业、每作业 60 分钟；同一 PR 会取消旧运行，但不同 PR 没有全局上限。正常不会占 CI VPS，`arm-fallback` 打开时会占。
- **不可撤销操作**：试跑本身不写共享目录、不删外部资源、不运行 `run-share remove`；没有发现不可撤销操作。
- **规则、说明文档和代码一致性**：发现运行手册第 195 行与第 180 行矛盾、安装脚本第 98 行过时、测试引用了不存在的 ADR-0260。

## 推测/未核实

- 当前 GitHub 分支规则是否仍只要求 `ci/required`：仓库文档（计划第 32 行）说只要求 `ci/required`，但线上 Ruleset 设置不在代码里，**未核实**。
- 仓库是否公开、fork PR 是否需要批准：**未核实**。
- `docs/runbooks/ci-vps-runner-runbook.md` 的新 `contract_sha256` 是否正确：需要运行文档封存工具，本轮工具权限不允许，**未核实**。
- Oracle ARM runner 的实际在线状态和标签：代码只有安装脚本，**未核实**。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动的文件只有 `.github/workflows/`、`ci/`、`scripts/ci/`、`scripts/operations/ci-runner/`、测试和运行手册，没有任何系统提示、工具定义、历史消息或出口遮盖的组装代码。`git diff --stat 040da…bfb` 不包含 `packages/`、`apps/`、提示词目录或模型适配器。对模型请求来说，仍然没有任何“在中间改写、重排、删除”的逻辑；该规则要求的“只在末尾追加、每轮变化的值放最后一条消息”没有被触及。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   对模型请求没有影响，因为这次没有模型请求代码变化。就 CI 内部而言：`alternateArch` 由固定顺序的 `structuredClone`/赋值产生，`armChecks` 是固定数组，`policySha256` 仍按基准策略的原始字节计算（`scripts/ci/check-policy.mjs:1279`），没有新增时间、随机数或无序集合。新增的是按机器架构变化的 `toolchain.arch`（ARM 报告为 `arm64`、x64 报告为 `x64`），这是每个主机各自的证据，不是同一段内容的非确定序列化，也不进入模型上下文。未发现新增的字节不确定来源。

3. **有没有对应的自动检查，反向用例是否真会失败？**
   有：`aggregate.test.mjs`、`runner.test.mjs`、`policy.test.mjs`、`ci-runner-scripts.test.mjs`、`ci-optimization.test.mjs` 都加了用例。按代码静态推断，去掉对应改动时这些用例会失败：
   - `aggregate.test.mjs:401` 在恢复严格的 `arch` 校验后，arm64 期望 `passed` 的断言会失败；
   - `runner.test.mjs:360` 在移除 `memberRunsOnHost` 后会导入失败；
   - `policy.test.mjs:1213` 在移除 `upgradeArmRunnerPolicy` 后 `resolvePolicySource` 会因 `Incorrect platform` 失败；
   - `policy.test.mjs:1252-1265` 在恢复旧的 `validatePolicy` 后，“static 没有 arm64 试跑”等反向用例不会再抛错；
   - `ci-runner-scripts.test.mjs:1641`、`ci-optimization.test.mjs:96` 在删除试跑工作流后会读文件失败。

   但有两个缺口：第一，`aggregate.test.mjs` 的新用例断言的是“arm64 报告在必过汇总里通过”，它保护的是这次放宽，而不是原来的“ARM 不进必过”不变量；第二，测试/actionlint 不覆盖试跑工作流的 Action SHA、权限和草稿条件，`install-arm-runners.sh:98` 的过时提示也没有测试覆盖。另外，“连续 20 次、1.5 倍时长”的切换条件是流程约定，没有自动检查。以上为静态推断，本轮未运行测试。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   - `alternateArch`：产生处是 `ci/policy.json` 的三项检查和 `upgradeArmRunnerPolicy`（`check-policy.mjs:194-218`）；`ci/policy.schema.json:75` 允许 `arm64`；`validatePolicy`（`check-policy.mjs:366-371`）要求只有 `policy`/`static`/`security` 是 `arm64`、其他成员必须没有该字段；`run.mjs:71` 和 `aggregate.mjs:102` 读取它。两端在类型和取值上一致。唯一问题是 `aggregate` 把它用于必过证据，见第 1 条。
   - `armChecks`：在 `contracts.mjs:17` 定义为 `policy/static/security`，`check-policy.mjs`、`runner.test.mjs`、`ci-runner-scripts.test.mjs` 和试跑工作流测试都按同一组 ID 使用，一致。
   - `armRunnerLabel = "ci-arm"`：`actionlint.yaml`、`ci-arm-trial.yml` 三个作业、`runners.sh` 的 `RUNNER_ARM_LABEL` 和测试都一致使用 `ci-arm`。`ci/policy.schema.json` 的 `runner` 枚举没有 `ci-arm`，但本 PR 的 policy 仍写 `ci-vps`，试跑工作流的 `runs-on` 不经 schema，因此当前不冲突；将来真正切换时需要同时加枚举。
   - `ci-arm-trial.yml`：`run.mjs:254` 的 actionlint 列表、`ci-optimization.test.mjs:96`、`policy.test.mjs:1275` 和运行手册都引用了它。一致性问题只在 `install-arm-runners.sh:98` 的“还没有工作流使用 ci-arm”提示，以及运行手册第 195 行。
   - `policy.schema.json` 没有把 `alternateArch` 放进 `required`，但所有实际入口（`resolvePolicySource`、`validateWorkflow`、`aggregate`）都会再调用 `validatePolicy`，因此不会让缺少该字段的策略未经升级就进入使用方。
