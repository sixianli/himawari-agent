**本轮范围**：只看 `67e63152..c7df7f25` 的增量，并顺着证据追到 `scripts/ci/prepare-hosted.sh`、`test/tooling/hosted-ci-setup.test.mjs`、`.github/workflows/ci.yml`、`main.yml`、`quality.yml`、`apple.yml`、`docs/adr/0287-ci-runs-on-github-hosted-runners.md`、CI 设计说明相关段落、`ci/policy.json` 的 tooling 测试归属，以及 `docs/architecture-v0.1.md`。未重读整个旧 CI 实现。

**侧重检查**

- 错误路径：`prepare-hosted.sh` 零参数、多参数、node 不可执行均显式 `exit 64`；非 root 仍在真正安装前 `exit 65`。零/多参数检查在任何 apt/文件写入之前，未引入不可撤销动作。已读代码证实。
- 调用端：仓库内 `prepare-hosted` 只有 5 个调用点（`ci.yml:106/241/335/398`、`main.yml:69`），都只传一个参数，新增的 `[ "$#" = 1 ]` 不会误拒现有调用。已读代码证实。
- 安全/不可信输入：`node_bin` 由工作流固定为 `$PWD/.ci-output/tools/bin/node`，但脚本仍以 root 执行工作区内 `node_modules/playwright/cli.js`；这是既有设计，增量没有改变这条路径，未发现新增回归。已读代码证实。
- 资源耗尽/不可撤销操作：apt-get、写 `/etc/apparmor.d/bwrap`、`apparmor_parser -r` 都在临时托管虚拟机上执行；增量只调整参数校验，未新增此类操作。已读代码证实。
- 文档与代码一致性：设计说明的三处旧说法已与 ADR 0287、`ci.yml` 的 cache 步骤一致；但现行架构文档仍有一处旧说法，见意见 2。已读代码证实。
- 未核实：`quality.yml` 的 `scale`/`thread-scale` 是否依赖 bwrap；本次增量未涉及，也没有直接证据指向它，因此没有把它算作新增缺口。

**结论**：上一轮三条意见都已按增量改好；增量本身未发现高/中严重度问题。新增两条低严重度意见：一条是新增测试没有真正验证“先跑”，一条是增量外的现行架构文档仍与 ADR 0287 矛盾。

### 1. 低：新增的工作流测试只验证准备脚本“存在”，没有验证它“先跑”，与测试名和作者说法不符

文件：`test/tooling/hosted-ci-setup.test.mjs:26-36`

问题：测试名写“都先跑准备脚本”，但断言只是对 `steps` 做 `.some(...)`，只要求任意位置存在一个以 `sudo bash scripts/ci/prepare-hosted.sh ` 开头的 `run`，不比较步骤顺序。若以后把准备步骤移到浏览器安装或 `scripts/ci/run.mjs` 之后，测试仍会通过，但作业会在未准备的环境中运行沙箱/浏览器测试。

证据：

```js
26: ])("%s 里要沙箱或浏览器的作业都先跑准备脚本", (file, jobs) => {
...
31:       expect(
32:         workflow.jobs[id].steps.some((step) =>
33:           String(step.run ?? "").startsWith("sudo bash scripts/ci/prepare-hosted.sh "),
34:         ),
35:         `${file}/${id}`,
36:       ).toBe(true);
```

当前 `ci.yml:106` 的准备步骤确实在 Chromium 安装之前，所以现有工作流没有错；问题是测试没有把“先”这个条件锁住。

建议：先找准备步骤的下标，再找第一个 `playwright ... install` / `scripts/ci/run.mjs` / 浏览器或沙箱步骤的下标，断言准备步骤在前；反向验证时把准备步骤移到 `run.mjs` 之后，新增断言应失败。

### 2. 低：现行架构文档仍写“CI 也不再用 GitHub 缓存”，与 ADR 0287 和 `ci.yml` 的缓存步骤矛盾

文件：`docs/architecture-v0.1.md:661`

问题：PR 623 的 ADR 0287 已决定本次运行内部用 `actions/cache` 在作业之间传报告和构建，`ci.yml` 也实际有 `actions/cache/save`/`restore`；但现行架构文档仍说“CI 也不再用 GitHub 缓存”。设计说明已经改过，这份 `status: active` 的架构文档没有同步，读者会得到相反结论。该处不在本轮增量改动行内，是按新增行为顺着旧文档查到的；前两轮只改了设计说明。

证据：

```text
docs/architecture-v0.1.md:661:
...2026-11-06 起都只在 GitHub 上保留 1 天，CI 也不再用 GitHub 缓存（ADR 0174）...
```

对照代码和 ADR：

```text
.github/workflows/ci.yml:70:
uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830

docs/adr/0287-ci-runs-on-github-hosted-runners.md:47:
3. 作业之间传文件：...每个检查作业把自己那份报告用 `actions/cache/save` 存进本次运行的缓存...
```

建议：把该句改成“依赖和工具仍不用缓存；本次运行的报告和构建经 `actions/cache` 传递（ADR 0287）”，或明确标注为 2026-11-06 至 2026-11-25 的历史状态。

**读代码证实的**

- 上一轮意见 1 已改好：设计说明第 96、320、357 行已改成 `actions/cache`、GitHub 自动删除和“本次运行的缓存”；第 129 行的“此前放在 CI VPS 的共享目录”是明确的历史描述，不构成现行矛盾。
- 上一轮意见 2 已改好：测试第 19 行断言 `status` 恰为 `64`，第 21 行断言 stderr 含 usage，错误码契约已锁住。
- 上一轮意见 3 的核心已改好：测试第 23-37 行会检查 `ci.yml` 的 `static/browser/tests/tooling` 和 `main.yml` 的 `confirm` 是否调用准备脚本；但“先跑”的顺序未被锁住，见意见 1。
- 增量新增的退出码 `64` 由 `scripts/ci/prepare-hosted.sh:4`（参数个数错误）和 `:6`（node 不可执行）产生；使用端是测试 `hosted-ci-setup.test.mjs:19/40` 和工作流步骤（任何非零都会让作业失败），两端没有冲突。
- 新增 usage 字符串由 `prepare-hosted.sh:4` 产生，测试 `hosted-ci-setup.test.mjs:21` 精确匹配。
- 新增测试的作业清单与 `ci.yml` 的 `static/browser/tests/tooling`、`main.yml` 的 `confirm` 一致；该清单只被测试自身使用。
- `test/tooling/hosted-ci-setup.test.mjs` 属于 tooling 项目（`ci/policy.json:237-238` 的 `test/tooling/**/*.test.mjs`），会随 tooling 作业运行。

**推测（未实跑/未核实）**

- “把准备步骤移到后面，测试仍会通过”是由断言结构直接推出的，未实际执行 vitest 验证。
- “把 `${1:?}` 改回去，测试会失败”也是由断言结构推出，未实际运行。
- GitHub 真实缓存淘汰行为只对照了 ADR 0287 和设计说明，未上网或实跑核实。

**必答问题**

1. 不涉及。本次增量只改 CI 文档、`prepare-hosted.sh` 和 tooling 测试，未触及系统提示、工具定义、历史消息、遮盖逻辑或请求序列化，因此不会改变模型已经见过的请求开头；没有重新核实整个请求构造路径（与本次增量无关）。
2. 不涉及。改动中没有序列化、遮盖、时间字段或无序集合；退出码、usage 文本和测试里的作业清单都不会进入模型请求。
3. 有自动检查，但不完整。`prepare-hosted.sh` 的参数缺失/不可执行退出码由 `hosted-ci-setup.test.mjs:17-22/38-42` 锁定，工作流调用由同一文件第 23-37 行检查；这两类反向改动会失败。新增测试没有锁定“准备步骤必须在浏览器/沙箱步骤之前”，见意见 1。文档改动没有对应的语义自动检查。
4. 增量产生的值两端能接受：`exit 64` 的产生端是 `prepare-hosted.sh:4/6`，使用端只有测试和工作流失败判定；usage 字符串产生端 `:4`、使用端测试 `:21` 一致；测试作业清单与工作流实际 job 键一致。未发现增量值在生产/CI 另一端存在校验冲突。文档层面有一个旧用法不一致，见意见 2。
