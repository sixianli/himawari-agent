你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 80c488320bb583e4448f08e447cf593ded7b90c2。
待核对的方案：
方案文件：docs/adr/0253-support-linux-arm64-for-test-and-qualification.md（在提交 80c488320bb583e4448f08e447cf593ded7b90c2 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-12"
---

# ADR 0253：让 Himawari 能在 linux-arm64 上跑检查、跑沙箱、出包和做资格验证（测试用途）

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 有一台 Oracle 东京区的 ARM 云服务器（aarch64，即 64 位 ARM 架构；Ubuntu 24.04.5，4 核 24GB）。2026-11-12 起把它当测试机用，线上不切换。同日在这台机器上实测（代码版本 main `12ce0d0a`）：

- Node 22.23.5、bubblewrap（命令名 `bwrap`，Linux 上的沙箱程序）0.11.2、`npm ci`、`onnxruntime-node` 和 `@napi-rs/canvas` 两个原生库、`rename-native.c` 的编译都通过。
- `build:node`、unit（4384 个用例）、contracts（517）、node-services（1100）、admin-cli（34）、pi-compat（233）全部通过。
- integration 有 198 个用例失败、3980 个通过。报错里 101 条是 `ENOENT: no such file or directory, realpath '/lib64'`。机器上没有 `/lib64` 和 `/usr/lib64`，`/lib` 是指向 `usr/lib` 的符号链接。
- `npm test` 一启动就报 `CI_LOCAL_PLATFORM_UNSUPPORTED`。

根本原因不是 ARM 不兼容，而是仓库把 x86-64 的目录布局和平台名当成了所有 Linux 都成立的事实：

- 生成沙箱只读目录清单的地方对 `/lib64` 无条件取真实路径：`scripts/delivery-mode/packet-template/signing/cloud-seal.mjs` 第 334 到 353 行的那一组里有 `"/lib64"`，用的是 `.map((p) => realpath(p))`；同一个文件第 354 到 364 行对 `/etc/mime.types` 等 4 条已经有“不存在就跳过”的写法。测试夹具和探测脚本也是同样的无条件写法，例如 `test/fixtures/product-path-harness.ts`、`test/fixtures/mac-sandbox-deployment.ts`、`test/integration/sandbox-preparation-control.test.ts`。
- 沙箱策略对交给它的每条路径做严格校验：`packages/runtime-sandbox/src/policy.ts` 的 `canonicalPath` 里有 `if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL")`。
- 本地检查的总控脚本只认两个平台：`scripts/ci/local.mjs` 只接受 `darwin` 加 `arm64` 或 `linux` 加 `x64`，否则抛 `CI_LOCAL_PLATFORM_UNSUPPORTED`；`scripts/ci/install-tools.mjs` 里是 `const platforms = ["darwin-arm64", "linux-x64"];`。
- 构建产物的平台名用三元表达式写死：`scripts/ci/build.mjs`、`scripts/ci/run.mjs`、`scripts/ci/local.mjs` 里是 `process.platform === "darwin" ? "macos-arm64" : "linux-x64"`。
- `scripts/ci/context.mjs` 里 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`，所以改主工具链锁文件会改变 x64 产物记录里的上下文。
- 出包链写死 x64：`scripts/delivery-mode/make-packet.py` 和 `scripts/delivery-mode/run-packet-checks.py` 按 `linux-x64-abi127-` 找包；`scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs` 和 `collect-installer-dependencies.mjs` 要求 `process.arch === "x64"`；`make-packet.py` 里 `PYTHON_MATERIAL` 固定为 `python-3.12.10.tar.gz` 和一个固定摘要；`scripts/delivery-mode/packet-template/acceptance/cloud/download-question-12.py` 下载的是 `fd-v10.5.0-x86_64-unknown-linux-musl`。

已经支持 ARM 的部分：`packages/runtime-sandbox/src/srt-runtime-identity.ts` 同时登记了 `x64` 和 `arm64` 的 seccomp 辅助程序摘要；`packages/execution-contracts/src/sandbox-qualification-v1.ts` 的资格回执接受 `architecture` 为 `arm64` 或 `x64`；`scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs` 用 `assert.equal(process.arch, receipt.architecture)` 和 `assert.equal(release(), receipt.osRelease)` 把回执绑定到当前机器，所以 x64 的回执不能在 ARM 上用，反过来也一样。

别人怎么做：`/lib64` 是 x86-64 专有的目录，Debian 技术委员会邮件里写明 amd64 会装 `/lib64`，“but not on arm64”（<https://www.mail-archive.com/debian-ctte@lists.debian.org/msg09818.html>）。bubblewrap 手册里 `--ro-bind-try` 的说明是“Equal to --ro-bind but ignores non-existent SRC”（<https://github.com/containers/bubblewrap/blob/main/bwrap.xml>），它会忽略任何不存在的来源。本仓库 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs` 已经有“先过滤掉不存在的目录，再取真实路径”的写法。

[↑ 返回阅读导航](#contents)

<a id="owner-decisions"></a>

## Andy 的原话

2026-11-12 14:40 JST，Andy 对“在 Oracle 这台机器上做 ARM 出包和跑测试，观察一周，线上不动”回“开”。同日 14:52 对阶段 0（只在那台机器上装工具、跑测试）回“同意”。同日 17:54 在决定卡“同意花最多 1 美元请 DeepSeek 和 GLM 讨论 ARM 阶段 1 方案吗”上选了“同意，上限 1 美元”。同日 18:56，Andy 在决定卡“同意按这份 ARM 方案分四个 PR 动工吗”上选了“同意，四个 PR 按顺序做”。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

把 linux-arm64 作为测试和资格验收用的平台支持起来，分四个 PR，x64 的托管 CI 和生产行为不变。ARM 不进 GitHub 必过检查，也不切线上。

1. **PR 0，只清点、不改行为。**全仓找出写死 `/lib64`、`linux-x64`、`process.arch === "x64"`、固定主机名和固定 Python 包名的地方，列成清单（`scripts/platform-assumptions.json`，按类别和文件记次数）；加一道检查 `npm run check:platform-assumptions`：某个文件里某一类的次数比清单多就失败，比清单少也失败（要求把清单改小）。它按次数比，不看写法：同一个文件里删一处、再加一处，次数不变，检查发现不了，这一点靠代码复核。先在 ARM 机上实测 `packages/platform-node/src/capabilities/isolation.ts` 的沙箱自检（它带 `--symlink usr/lib64 /lib64`）是否通过；2026-11-12 在 ARM 机上用 bwrap 0.11.2 带同样的 `--symlink usr/lib64 /lib64` 参数实测，退出码是 0。
2. **PR 1，修根本原因。**在生成只读目录清单的地方加一个函数：按输入顺序逐条处理；明确标为可选的条目（第一版只有 `/lib64`），用 `lstat` 确认路径本身不存在时才跳过；路径存在但取真实路径失败（例如悬空的符号链接）、权限错误、必选条目缺失，都报错；取真实路径之后按原顺序去重。函数放在新文件里。`cloud-seal.mjs`、测试夹具、探测脚本及其在上线包模板里的副本都改用它；`cloud-seal.mjs` 里的路径字面量仍留在 `readOnlyToolchainPaths: [` 到 `protectedPaths: [` 之间。沙箱策略的严格校验、`SANDBOX_READ_ROOTS`、`isolation.ts`（除非 PR 0 实测它在 ARM 上失败）都不改。
3. **PR 2，本地检查认 linux-arm64。**平台名分两个函数：构建产物用的（`macos-arm64`、`linux-x64`、`linux-arm64`）和工具链锁用的（`darwin-arm64`、`linux-x64`、`linux-arm64`）。`local.mjs` 放行 linux-arm64，用一份显式的本地配置为 build 提供 linux-arm64 成员，`GITHUB_ACTIONS` 为 `true` 时禁止。ARM 的工具链放在独立的锁文件里，有自己的校验和自己的摘要字段；`ci/toolchain-lock.json`、`ci/policy.json`、`scripts/ci/check-policy.mjs`、`scripts/ci/aggregate.mjs` 和工作流文件不改。ARM 机上显式安装 Playwright 的浏览器。
4. **PR 3，出包、安装和资格认 linux-arm64。**`make-packet.py` 增加显式的目标平台参数，默认仍是 linux-x64；包名、Python 包、`node_modules` 包、`fd` 下载物都按目标平台取，并在安装脚本里和产物记录交叉校验。构建机身份（平台、架构、主机名、用户编号）改成提交进仓库的配置，x64 的默认值不变，ARM 用一份固定的测试配置，不从当前机器现场探测。ARM 包标为非生产候选：这个标记是产物的一部分，安装脚本和上线预检遇到生产用途时拒绝它。ARM 机上用独立的签名密钥，不放生产密钥和真实数据。

验收：ARM 上 `npm test` 通过且 `/lib64` 一类失败清零；真实沙箱探测、`check:srt-boundary`、资格回执校验通过；用测试账号真发一条消息并收到回复；模型看到的可用命令清单和沙箱里真实能执行的命令逐条对得上。x64 上：只读目录清单、沙箱策略的摘要、沙箱自检参数由自动用例和改动前的值比对一致；`check:prompt-prefix`、`check:delivery-packet`、`check:delivery-deploy` 通过。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 在生成清单的地方跳过确实不存在的可选目录，边界校验保持严格 | 采用 | 修的是根本原因；路径写错或坏掉时仍然报错 |
| 放宽 `policy.ts`，让它接受不存在的路径 | 不采用 | 权限边界的核心校验会变成“写错也放行” |
| 改用 bwrap 的 `--ro-bind-try` | 不采用 | 它忽略任何不存在的来源，本该报错的也被吞掉 |
| 在 ARM 机上手工建 `/lib64` 链接 | 不采用 | 只是给一台机器打补丁，机器被回收就没了，根本原因还在 |
| 把 linux-arm64 加进 `ci/policy.json` 的必过检查 | 不采用 | 测试机可能被 Oracle 回收，不能让必过检查依赖它 |
| 把 ARM 条目直接加进 `ci/toolchain-lock.json` | 不采用 | 这个文件的摘要写进 x64 产物记录，改它会改变 x64 的记录 |
| 构建机身份从当前机器现场探测 | 不采用 | 等于让机器自己说自己是谁，身份校验失去意义 |
| 无条件改 `isolation.ts` 的 `/lib64` 符号链接 | 暂不采用 | bwrap 的 `--symlink` 不要求目标存在，先实测，失败再改 |

依据的愿景原则是边界与可逆性：沙箱是权限边界，宽容只放在生成清单这一层；每个 PR 可以单独回退。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 不改系统提示、工具定义、历史消息和出口遮盖，模型已经见过的请求开头不变。
- 新函数是新代码，x64 上沙箱运行时的摘要和整个上线包的哈希会变；能保证不变的是只读目录清单、策略摘要和自检参数这些值。
- ARM 上暂时不能跑完整的 `npm run check`：扫描工具（semgrep、gitleaks、actionlint）的 ARM 版本第一步不固定进锁文件。
- 以后升级工具链要多维护一份 ARM 锁文件。
- 还没证实的事：`JOB_HOST_NOT_READY` 这类失败是否全部由 `/lib64` 连带引起；Playwright 的浏览器在这台机器上能否装齐；`fd` 的 aarch64 发行物文件名和摘要；ARM 上模型看到的可用命令清单是否和沙箱真实能力一致。这些在对应 PR 里实测。
- 这台 ARM 机可能被 Oracle 回收。代码改动不依赖这台机器长期存在，但 ARM 上的验收结果只在机器还在时能重做。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0176：CI 在 OVH 的云服务器上跑](0176-ci-on-ovh-vps.md)
- [事故和门槛](../incidents-and-gates.md)（I-73：只看改动本身，没核对每个值的产生处和使用处）
- [安装、启动和停止操作手册](../runbooks/install-start-stop-runbook.md)

[↑ 返回阅读导航](#contents)
