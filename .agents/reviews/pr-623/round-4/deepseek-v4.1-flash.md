## 本轮范围

- 实读：`dbe6f91` 本身（`git show` 只有 `test/tooling/aggregate.test.mjs`、`test/tooling/runner.test.mjs` 两个文件），以及它断言的 `ci/policy.json`、`scripts/ci/contracts.mjs`、`scripts/ci/aggregate.mjs`、`scripts/ci/run.mjs`、`.github/workflows/ci.yml`、`docs/adr/0287`、`test/tooling/quality-local.test.mjs`、`scripts/ci/local.mjs`、`scripts/ci/check-policy.mjs`。
- 未重读：`4ceadc8..dbe6f91` 里从 `origin/main` 合并进来的 PR 620/624/626 内容（`bee1fb34c`、`a5a7f14f5` 等），视为各自 PR 已复核；本轮的上一轮判断记录未提供，无法逐条核对“上一轮意见是否改好了”。
- 作者说法核对：属实。`aggregate.test.mjs` 的 ARM 名单已改为 `["policy","tooling","security"]`（第 525 行），`static` 进了 arm64 应拒绝的循环（第 535-537 行）；`runner.test.mjs` 的 ARM 可跑名单改为 `["policy","tooling","security"]`（第 386 行），`static` 进了仅 x64 名单（第 392 行）。`ci/policy.json` 里 `static` 的成员没有 `alternateArch`（第 28-34 行），`policy`/`tooling`/`security` 都有 `"alternateArch": "arm64"`，与 `scripts/ci/contracts.mjs:26` 的 `armChecks = ["policy","tooling","security"]` 一致；`.github/workflows/ci.yml` 的 `runs-on` 也是 policy/tooling/security 用 `ubuntu-24.04-arm`、static 用 `ubuntu-24.04`。

## 侧重检查

- 错误路径/不合规范输入：本增量只改测试常量，不接收外部输入，无新的错误路径。
- 安全/资源耗尽/不可撤销操作：不涉及；没有运行时会执行的操作。
- 规则、说明与代码一致：ADR 0287 第 45 行明确写“policy、tooling、security 跑在 ubuntu-24.04-arm；static 改回 x64，因为 `npm run check` 里的 `check:delivery-dependencies` 在 ARM 上以 `P5_ENVIRONMENT_INVALID` 失败”，与本次代码/测试一致。旧的 ADR 0266 和 `.agents/evidence/*`（2026-11-15 的快照）仍写 static 在 ARM，但它们是历史记录/已被 ADR 0287 修订，未当作问题。
- 迁移列表核对：`scripts/ci/check-policy.mjs:68` 的 `coverageArmChecks = ["policy","static","security"]` 不是现行策略校验名单，只用于旧 coverage 形态的升级；升级链最后一步 `upgradeSelfHostedRunners`（第 390-397 行）会把 `legacyArmChecks` 里、不在 `armChecks` 的 static 搬回 linux 并删掉 `alternateArch`，读代码确认旧策略升级后不会把 static 留在 ARM。
- 发现一处增量之外的同类不一致，见意见 1。

## 意见

### 1 【低】增量只改了 aggregate/runner，`quality-local` 仍把 static 当作可在 linux-arm64 上跑，与 ADR 0287 和“static 只接受 x64”相矛盾

- 文件：`test/tooling/quality-local.test.mjs:586-595`、`scripts/ci/local.mjs:29`、`scripts/ci/local.mjs:75`、`scripts/ci/run.mjs:268-269`
- 问题：本次把 ARM 上的三项检查定为 policy、tooling、security，但本地 runner 的测试仍断言另外三项 `["policy", "static", "security"]` 能在 `linux-arm64` 上跑（还漏了 tooling）。实机上 `local.mjs --check static` 会执行 `npm run check`，其中 `check:delivery-dependencies` 只认 linux-x64，必然失败；该测试用 mock 的 `runCheck` 把它当成通过，因此 CI 不会暴露这个矛盾。
- 证据：
  - `quality-local.test.mjs:586-588`：`it("on linux-arm64 runs the three checks that need no build artifact ...")` 内 `for (const check of ["policy", "static", "security"])`
  - `scripts/ci/local.mjs:29`：`if (check && !["policy", "static", "build", "tests", "tooling", "security"].includes(check))`；`:75`：`if (!check || check === "static") await execute("static");`（没有任何架构拦截）
  - `scripts/ci/run.mjs:269`：`await command("check", tools.node, [tools.npmCli, "run", "check"]);`；`package.json:27` 的 `check:steps` 含 `npm run check:delivery-dependencies`
  - `scripts/delivery-mode/packet-template/install/collect-installer-dependencies.mjs:15`：`fail(... process.platform === "linux" && process.arch === "x64", "P5_ENVIRONMENT_INVALID");`
  - 测试能通过的原因是 `quality-local.test.mjs:141-153` 把 `runCheck` mock 成永远 `passed`
- 建议：把这一处的名单同步成 `["policy", "tooling", "security"]`，并让 `local.mjs` 在 ARM 上明确拒绝 `static`（或给出“static 需 x64”的说明），补一条反向用例。注意：这个不一致在 `dbe6f91` 之前就存在（`quality-local.test.mjs`/`local.mjs` 自 `2998c7afa` 后未改），不是本增量引入；但本次增量的主题正是“static 只接受 x64”，所以一并指出。
- 区分：以上“代码/测试怎么写、mock 会返回通过”是读代码证实；“ARM 上实跑 static 会失败”依据 ADR 0287 与第 15 行的硬校验推断，本轮未实际运行（工具限制）。

增量本身（`dbe6f91` 的两处改动）未发现新错。

## 必答问题

1. **不涉及。** `dbe6f91` 只改了两个测试文件，没有触碰系统提示、工具定义、历史消息、遮盖结果；发给模型内容“只在末尾追加”的规则没有被本增量改变。本轮没有验证模型路径（未核实，因不属于本增量；`4ceadc8..dbe6f91` 中的 prompt/runtime-pi 改动来自已合并的 PR 620/624/626，未重审）。
2. **不涉及。** 改的是纯测试常量，不进入请求，也不会让同一段文字在不同请求里变成不同字节。
3. **有自动检查，反向用例逻辑成立。** `aggregate.test.mjs:524-544` 正向断言 policy/tooling/security 的 arm64 报告通过，反向断言 build/static 的 arm64 报告被拒；`runner.test.mjs:383-395` 正向断言 policy/tooling/security 可在 linux-arm64 跑，反向断言 static/build/tests/required 仅 x64。读代码确认：若把 static 塞回 `alternateArch`，两处反向断言都会失败；若把 tooling 踢出 `armChecks`，两处正向断言都会失败。未实际运行（工具限制），作者提交信息称 aggregate、runner 92 项通过。小缺口：aggregate 的反向循环没覆盖 tests/required/browser，但这段是通用 arch 校验，且 runner 测试覆盖了 tests/required；该缺口在增量前就有。
4. **能接受。** 增量修改的值只是两个测试里的检查 id 数组，直接使用端就是这两个测试自身；它们对照的 `ci/policy.json`（static 无 `alternateArch`）和 `scripts/ci/contracts.mjs:26` 的 `armChecks = ["policy","tooling","security"]` 都接受这组值，`validatePolicy`（`check-policy.mjs:524-528`，`alternateArch === (arm ? "arm64" : undefined)`）和 `aggregate.mjs:117`（`[member.arch, member.alternateArch].includes(result.toolchain.arch)`）都接受，`.github/workflows/ci.yml` 的 `runs-on` 也一致。唯一的同类旧值在 `quality-local`/`local.mjs`（见意见 1），但它不是本次修改的值；`check-policy.mjs:68` 的 `coverageArmChecks` 是历史迁移用列表，读升级链确认最终会被 `upgradeSelfHostedRunners` 修正回 x64。按 I-73 的问题形式说：改后的三个 id 正好等于后端校验用的 `armChecks`，能过校验。
