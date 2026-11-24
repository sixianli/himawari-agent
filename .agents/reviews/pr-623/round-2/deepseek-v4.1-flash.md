## 本轮核对范围

核对增量 `02e1758..67e6315` 的全部 18 个路径（`.agents/reviews` 下的记录只当线索，不当证据），并顺着证据回看了 `ed3f8d0..67e6315` 的 CI 迁移、基准 `ed3f8d0:ci/policy.json`、`scripts/ci/{check-policy,contracts,run,aggregate,run-share}.mjs`、`.github/workflows/{ci,main,apple}.yml`、`scripts/ci/prepare-hosted.sh`、`ci/policy.schema.json`、`package.json`、`scripts/platform-assumptions.json` 及相关 ADR/设计文档。只做静态核对，未能运行测试、未能联网。

## 上一轮意见核对

- 意见 1（测试）：新增 `test/tooling/hosted-ci-setup.test.mjs`，且 `ci/policy.json:238` 的 tooling 项目包含 `test/tooling/**/*.test.mjs`，会被执行，基本补上了；但残留见下面第 2、3 条。
- 意见 3（文档）：只改好了一部分，设计文档仍有旧叙述，见第 1 条。
- 意见 4（`macos-26`）：已改好。`ci/policy.schema.json:64` 枚举含 `macos-26`，`contracts.mjs:19` 的 `macRunnerLabel` 被 `validatePolicy`（`check-policy.mjs:529`）和 `validateHostedRunners`（`check-policy.mjs:910`）使用。
- 意见 5（混写基准不升级）：已改好。`check-policy.mjs:378-381` 改成全体成员都是旧标签才升级，`policy.test.mjs:2246-2256` 用 `toBe` 身份断言能区分旧行为。

## 意见

### 1. 中：设计文档仍描述已删除的 CI 服务器共享目录和“汇总作业结束时删除”，与 ADR 0287 和代码矛盾

文件：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:96`、`:320`（另见 `:357`）

问题：第 1 轮意见 3 没有改全。同一文件 `:129` 已改成“每台托管机器用自己的 `$RUNNER_TEMP/ci-share`……旧的结束时删目录一步随之去掉”，但 `:96` 和 `:320` 仍是旧状态，读者会得到两套互相冲突的操作方式。

证据（读代码证实）：

- `:96`：“GitHub workflow 只负责调度、权限、隔离，以及经 CI 服务器共享目录传递作业之间的文件。”
- `:320`：“`ci.yml` 的完整报告只在本次运行的共享目录里，汇总作业结束时删除……要看完整材料，需要在 CI 服务器上重跑”。
- 代码侧 `.github/workflows/ci.yml` 只有 `actions/cache/save`、`actions/cache/restore`（`:70`、`:123`、`:243` 等）和 `run-share.mjs collect`（`:569`），没有 `remove`；`scripts/ci/run-share.mjs` 虽仍导出 `remove`，但工作流已不再调用；ADR 0287 的后果一节也明确写“汇总作业不再在结束时删共享目录”。

建议：把 `:96`、`:320`、`:357` 改成现行模型（每台机器 `$RUNNER_TEMP/ci-share`、`actions/cache` 传递、不主动删、由 GitHub 七天未用淘汰），或明确标成“2026-11-25 之前的旧做法”。这类语义陈旧没有自动检查能发现（`check:docs-links` 只查链接），需要手工改。

### 2. 低：新增测试的第一例说“以 64 退出”，实际断言只要求非 0，错误码契约没有被锁定

文件：`test/tooling/hosted-ci-setup.test.mjs:17-21`、`scripts/ci/prepare-hosted.sh:4`

问题：测试标题写“不给 node 路径时以 64 退出”，但脚本对缺参数走的是 bash 的 `${1:?usage: ...}`，断言却是 `expect(result.status).not.toBe(0)`。只要脚本以任意非 0 结束（包括语法错误、文件不存在导致的 127、将来改成 65），这条用例都会通过；真正可以区分“预期错误路径”的信息没有锁住。

证据（读代码证实）：
- `prepare-hosted.sh:4`：`node_bin=${1:?usage: prepare-hosted.sh <node>}`
- `hosted-ci-setup.test.mjs:18-20`：`const result = run([]); expect(result.status).not.toBe(0); expect(result.stdout).toBe("");`

推测：按 bash 非交互 shell 的 `:?` 语义，缺参数实际退出码是 1 而不是 64（未运行验证）。

建议：二选一——脚本里把缺参数也改成显式 `echo ... >&2; exit 64`，让错误码一致；或测试改名为“以非 0 退出”并断言 `status === 1` 且 stderr 包含 usage。这样反向用例才真正锁住错误路径。

### 3. 低：`prepare-hosted.sh` 的测试只查脚本内容，没有检查工作流是否真的调用它

文件：`test/tooling/hosted-ci-setup.test.mjs:16-33`；调用点 `.github/workflows/ci.yml:106`、`:241`、`:335`、`:398`，`.github/workflows/main.yml:69`

问题：第 1 轮意见 1 想要的“自动检查”现在只覆盖脚本自身和 `apple.yml`，没有覆盖“准备步骤确实挂在需要沙箱/浏览器的作业上”。如果以后有人删掉某个作业里的 `sudo bash scripts/ci/prepare-hosted.sh ...`，这个测试仍全部通过；`check-policy.mjs` 里也没有 `prepare-hosted` 相关规则（我在 `scripts/ci/check-policy.mjs` 中未找到该字符串），只有运行时才发现 sandbox/browser 起不来。

证据（读代码证实）：
- 测试只做了 `readFileSync(script)` 的正则匹配和两条失败路径执行（`hosted-ci-setup.test.mjs:17-32`），没有读 `ci.yml`/`main.yml` 的步骤。
- `scripts/ci/check-policy.mjs` 中没有对准备脚本步骤的校验，`validateWorkflow` 只按固定命令/权限等规则检查。

建议：在 `hosted-ci-setup.test.mjs` 里读 `.github/workflows/ci.yml`、`main.yml`，断言需要 bwrap/浏览器的作业步骤里包含 `bash scripts/ci/prepare-hosted.sh`；或者把这条要求写进 `validateWorkflow`，再加一个删掉该步骤就必须抛错的反向用例。

## 侧重检查

- **错误路径**：`prepare-hosted.sh` 的缺参数（1）、node 不可执行（64）、非 root（65）三条路径都读了；测试覆盖了前两条，但没有锁定缺参数的退出码（第 2 条）。脚本的 `$node_bin` 全部加引号，未发现命令注入；AppArmor 文件写入路径固定。
- **不可信/不规范输入**：`validateHostedRunners` 用 `parseDocument(..., { uniqueKeys: true })` 解析全部工作流，只接受三种托管标签；`apple.yml` 的 `runs-on: macos-26` 在 `hostedRunnerLabels` 内。基准策略升级函数在成员格式异常时可能抛 `TypeError` 而不是干净校验错误（`check.mjs` 对 `check.members` 无前置校验），属于低风险异常路径，不构成安全漏洞；未作为意见单列。
- **安全**：`apple.yml` 工作流级 `permissions: { contents: read }`，checkout 固定 SHA 且 `persist-credentials: false`，PR 上的 `swift test`/`xcodebuild` 跑在免费托管机、无 secrets；`prepare-hosted.sh` 以 root 覆盖 `/etc/apparmor.d/bwrap` 并放宽 bwrap 的用户命名空间限制，是一次性托管机上的有意取舍，符合 ADR 0287 的说明。
- **资源耗尽**：`apple.yml` 没有 `paths` 过滤，任何 PR/push 都会占 macOS 机器；公开仓库不收费但会增加排队。属于取舍，未发现会出错的代码问题。
- **规则/文档一致性**：设计文档与 ADR 0287、`ci.yml` 的矛盾是第 1 条；ADR 0238/0241/0266/0275 作为历史 ADR 已带 `amended_by: 0287`，本轮没有要求逐个改写正文，未另报。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮增量只改 CI 工作流、策略/schema、CI 脚本、测试和文档，没有改系统提示、工具定义、历史消息、出口遮盖或请求序列化。按照 [prompt-prefix 规则](../../.agents/instructions/prompt-prefix.md#rules) 的“只追加、每轮会变的值只放最后一条消息”没有受到本改动影响；模型请求路径本轮未改动，也未能运行 `check:prompt-prefix` 实测（未核实）。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。没有改任何遮盖、时间字段、集合排序或模型输入序列化；改的是 CI 端口和文档里的 `macos-26`/`ubuntu-24.04` 等标签。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 有部分对应：
   - `macos-26`、`static` 回 x64、混写基准不升级：`policy.test.mjs` 有正反用例（例如 `:1636-1653` 的“static 放到 ARM 机器就被拒”、`:2246-2256` 的混写/未暂停基准不升级），静态看会随旧行为失败。
   - `prepare-hosted.sh`/`apple.yml`：新增 `hosted-ci-setup.test.mjs`，但缺参数退出码没有锁死（第 2 条），也没检查工作流是否真的调用准备脚本（第 3 条）；没有独立的“改坏脚本/删掉步骤就失败”的反向夹具。
   - 文档陈旧没有自动检查能发现（第 1 条）。所有测试未实际运行（未核实）。

4. **每个改动产生或修改的值的直接使用端都能接受吗？** 逐个核对了：
   - `macRunnerLabel = "macos-26"`（`contracts.mjs:19`）：`ci/policy.json:53`、`ci/policy.schema.json:64`、`check-policy.mjs:529`、`hostedRunnerLabels`/`validateHostedRunners`、`.github/workflows/apple.yml:24`、测试 `policy.test.mjs:2171` 全部接受。
   - `armChecks`（去掉 `static`）与新增 `legacyArmChecks`（`contracts.mjs:26-27`）：使用端只有 `check-policy.mjs` 的 `runnerLabelFor`（`:315-320`）、`validatePolicy`（`:524-529`）、`upgradeSelfHostedRunners`（`:390-397`）和测试；两端一致，`static` 现在必须是无 `alternateArch` 的 x64。
   - `static` 的 runner 改为 `ubuntu-24.04` 且删除 `alternateArch`：`validatePolicy` 期望 `runnerLabelFor("static")===linuxRunnerLabel`、`alternateArch===undefined`；`scripts/ci/run.mjs:73`、`scripts/ci/aggregate.mjs:117` 用 `[member.arch, member.alternateArch].includes(arch)`，`undefined` 不会误收 arm64；`.github/workflows/ci.yml:80` 与策略一致。
   - `platform-assumptions.json` 把 `policy.test.mjs` 的 `arch-x64` 计数从 5 改成 6：实测该文件有 6 处 `arch: "x64"`（`:100`、`:1206`、`:1230`、`:1422`、`:1475`、`:1611`），计数正确。
   - 作者关于 `static` 必须回 x64 的说法有代码依据：`scripts/delivery-mode/packet-template/.../collect-installer-dependencies.mjs:15` 等三处硬性要求 `process.platform === "linux" && process.arch === "x64"`，否则 `P5_ENVIRONMENT_INVALID`；`scripts/ci/run.mjs:268-269` 的 static 确实执行 `npm run check`，而 `package.json:27` 的 `check:steps` 包含 `check:delivery-deploy`、`check:delivery-dependencies`。
