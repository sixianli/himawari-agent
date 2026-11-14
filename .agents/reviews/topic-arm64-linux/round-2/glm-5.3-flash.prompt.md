你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6e33c029fbed56b8201d7924c22dafe10ead139c。
待审核的方案：
# 让 Himawari 支持 linux-arm64（测试机用途）：线程方案 v2

代码基准：main 6e33c029。只把 ARM 机当测试和资格验收机，不切线上，不进 GitHub 必过检查。

## 对标和根因
- 根因：仓库把 x86-64 的目录布局（/lib64）和平台名（linux-x64、x64）当成所有 Linux 的固定事实，不是 ARM 不兼容。SRT 的 seccomp helper、资格回执 schema 本来就支持 arm64（packages/runtime-sandbox/src/srt-runtime-identity.ts:8-11；packages/execution-contracts/src/sandbox-qualification-v1.ts:45-46）。
- 业界做法：对宿主机不存在的目录，在生成绑定清单时跳过，而不是在边界校验处放宽。Anthropic sandbox-runtime linux-sandbox-utils.ts：「A directory that is not there is skipped: bwrap cannot bind a missing source」；本仓库 packages/runtime-sandbox/scripts/check-srt-boundary.mjs:149-165 已有先过滤存在再 realpath 的写法。/lib64 是 x86-64 ABI 专有（Debian 邮件列表：amd64 装 /lib64，「but not on arm64」，https://www.mail-archive.com/debian-ctte@lists.debian.org/msg09818.html ）。

## 前提和来源
1. ARM 机没有 /lib64、/usr/lib64；integration 198 失败中 101 条是 `ENOENT realpath '/lib64'`。来源：2026-11-12 机器实测输出。
2. 边界校验严格：packages/runtime-sandbox/src/policy.ts:64-72，`if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL")`。
3. 清单生成处对 /lib64 无条件 realpath：scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-353；同文件 354-364 已有对 /etc/mime.types 等 4 条的 ENOENT 容忍写法。测试夹具同样：test/fixtures/product-path-harness.ts:396、test/fixtures/mac-sandbox-deployment.ts:147、test/integration/sandbox-preparation-control.test.ts:588、test/integration/prepared-file-runner.test.ts:278、test/qualification/sandbox-install-restart-model.mjs:420，以及 packages/runtime-sandbox/scripts/probe-*.mjs、packages/runtime-pi/scripts/probe-foreground.mjs 和 packet-template/acceptance/cloud/probe-source 下的副本。
4. deploy-preflight.py:83 用正则从 seal 源码的 `readOnlyToolchainPaths: [` 到 `protectedPaths: [` 之间抽字面量；apps/agent-service/test/sandbox-command-inventory.unit.test.ts:78 要求 seal 清单包含全部 SANDBOX_READ_ROOTS。
5. isolation.ts:537-542 的自检无条件 `--symlink usr/lib64 /lib64`。
6. CI：local.mjs:20-27 平台白名单；local.mjs:38、build.mjs:133、run.mjs:283/477/561、test.mjs:151、browser.mjs:128 用三元表达式把 linux 一律叫 linux-x64；install-tools.mjs:25 `const platforms = ["darwin-arm64", "linux-x64"]`。
7. scripts/ci/context.mjs:143 `toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`，所以改主锁文件会改变 x64 产物记录里的上下文。
8. 出包链写死 x64：make-packet.py:385/428、run-packet-checks.py:163（`linux-x64-abi127-`）；hermes/build-candidate.sh:44/46、run-release-walkthrough.sh:31；packet-template/install/__PKT_LABEL__-artifact-install.mjs:14 和 collect-installer-dependencies.mjs:15 要求 `process.arch === "x64"`；hermes/capture-build-source-inputs.template.mjs:115 要求 x64 和固定主机名；acceptance/cloud/download-question-12.py:14 下载 `fd-v10.5.0-x86_64-unknown-linux-musl`。
9. 资格回执按真实机器绑定：cloud-protected-prepare.mjs:37-41。
未核实：JOB_HOST_NOT_READY 等是否全是 /lib64 的连带；Playwright 的 linux-arm64 Chromium 能否装；semgrep、gitleaks、actionlint 的 linux-arm64 发行物是否齐；isolation 自检不改时在 ARM 上是否通过。

## 做法
### PR 1：清单生成处"只跳过确实不存在的可选系统目录"（修根因）
- 新增一个小函数：按输入顺序逐条 realpath，只有标为可选的条目遇到 ENOENT 才跳过，其他错误（EACCES 等）和必选条目缺失一律抛错；保序去重。产品侧放 packages/runtime-sandbox，交付侧在 packet-template/signing 放同逻辑模块，两处用同一组用例互测。
- cloud-seal.mjs：/lib64 归入可选组；字面量仍留在 `readOnlyToolchainPaths: [` 块内（前提 4）。
- 测试夹具、探针脚本及其 packet 副本改用同一函数，并同步 check:probe-sources 的指纹记录。
- isolation.ts：只有宿主机存在 usr/lib64 时才加 `--symlink usr/lib64 /lib64`；探测函数可注入，测试覆盖"有/无 lib64"两种，x64 参数与现在逐项相同。
- 不改：policy.ts 的严格校验、SANDBOX_READ_ROOTS、MERGED_DIRECTORIES、sandbox-command-links.py、历史的 scripts/operations/hermes-*-seal.mjs。
- 证明 x64 不变：改前先在 x64 记录 seal 清单、自检参数、固定输入的 policyJson 和摘要，改后逐值比对。只承诺到"值不变"，不承诺整包哈希不变（源码改了哈希必变）。
- 反向用例：EACCES 必须抛；必选目录缺失必须抛；policy 直接收到不存在路径仍拒绝；x64 上 /lib64 必须仍在清单里。
### PR 2：本地检查认 linux-arm64，托管 CI 一字不改
- 新增统一的平台名函数（darwin-arm64→macos-arm64、linux-x64→linux-x64、linux-arm64→linux-arm64，其余报错），替换前提 6 的各处；test.mjs、browser.mjs 从被验证产物的清单取平台。
- local.mjs 放行 linux-arm64；本地运行（hosted=false）时为 build 合成一个 linux-arm64 成员，GITHUB_ACTIONS 下禁止合成。ci/policy.json、check-policy.mjs、aggregate.mjs、工作流文件不改。
- 工具链：新增独立的 ci/toolchain-lock.linux-arm64.json，只在 linux-arm64 上合并进内存；主锁文件一个字节不改（前提 7）。第一步只放 npm test 需要的 Node、Python；扫描器（semgrep、gitleaks、actionlint）先不放，ARM 上暂不能跑完整 npm run check。
### PR 3：出包、安装、资格认 linux-arm64
- 平台和 ABI 从产物记录（artifact-record）读，包名、安装脚本、收集依赖脚本、回执各端与它交叉校验；默认行为仍是 linux-x64。x64 与 ARM 的包或回执互换必须被拒（自动用例）。
- Hermes 构建身份（平台、架构、主机名、uid）改成构建配置字段，x64 默认值不变；ARM 用现场探测生成的配置。
- fd 等验收下载物按架构选，aarch64 的文件名和 SHA-256 固定进清单。
- ARM 包标为"非生产候选"，deploy 预检遇到非 linux-x64 的候选直接拒绝，防止误装到生产机。
- 在 ARM 机上：出包、安装、seal、资格回执、起临时进程用测试账号真发一条消息收到回复。
### 验收
- ARM：npm test 通过，/lib64 类失败清零，其余失败逐条归类；check:srt-boundary 和真实沙箱探针通过；资格回执校验通过；真消息收发。
- x64：值级基线一致；check:prompt-prefix、check:delivery-packet、check:delivery-deploy、check:product-path-configuration 通过；ci/policy.json 和工作流无 diff。

## 是否改变模型已见过的请求开头
不改系统提示、工具定义、历史、遮盖。模型唯一可见的是"沙箱可用命令"，它在运行环境说明里、只在最后一条消息中出现；SANDBOX_READ_ROOTS 和候选命令顺序不变，x64 上内容不变。

## 取舍（依据：边界与可逆性）
- 宽容只放在生成清单这一层，权限边界校验保持严格。
- 不用 `--ro-bind-try`：它会把任何写错或消失的路径都静默吞掉。
- 不把 ARM 加进 ci/policy.json：测试机可能被回收，不能成为必过检查的依赖。
- 不在 ARM 机上手工建 /lib64 链接：机器补丁，回收即失效，且掩盖根因。

## 需要 Andy 定的
1. PR 3 验收用哪个模型 key 发真消息（不得与生产共用预算）。
2. ARM 上是否也要能跑完整 npm run check（要多固定三套扫描器的 ARM 版本，以后升级工具要多维护一个平台）。建议先不做。
