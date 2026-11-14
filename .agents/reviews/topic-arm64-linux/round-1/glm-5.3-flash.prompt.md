你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6e33c029fbed56b8201d7924c22dafe10ead139c。
问题、目标和约束：
# 问题
Himawari 目前只在 linux-x64（生产机、CI）和 darwin-arm64（开发）上出包和跑检查。Andy 有一台 Oracle 东京的 ARM 测试机（aarch64，Ubuntu 24.04.5，4 核 24GB），要让 Himawari 能在 linux-arm64 上：本地跑完整检查（`npm test`）、沙箱正常工作、出上线包并通过资格验证。现阶段只把它当测试机，不切线上。

# 目标
- 在 linux-arm64 上 `npm test` 能跑，集成测试里由平台差异引起的失败清零。
- 能产出 linux-arm64 的上线包，并在 ARM 机上完成一份资格验证和一次真实收发消息的验收。
- 找到并修掉根因，而不是只让测试通过。

# 约束
- 现有 linux-x64 的出包、CI（ci/policy.json 的必过检查）和生产机行为不能变；最好能证明逐字节不变。
- 不在 GitHub 上花钱，不新租机器；ARM 测试机可能被 Oracle 回收，不能成为必过检查的依赖。
- 能从机器动态取的值不写死。
- 沙箱是权限边界，改动要有回归证明和反向用例。
- 不得改变模型已经见过的请求开头（.claude/rules/prompt-prefix.md）。
- 生产机只有一台 x86，不动它。

# 已核对的事实（2026-11-12 在 ARM 机上实测，main 12ce0d0a；代码行号以 main 6e33c029 为准）
- ARM 机上没有 /lib64 和 /usr/lib64；/lib 是指向 usr/lib 的符号链接。
- Node 22.23.5、bubblewrap 0.11.2（源码编译）、npm ci、onnxruntime-node、@napi-rs/canvas、rename-native.c 编译，在 ARM 上都通过。
- build:node、unit（4384）、contracts（517）、node-services（1100）、admin-cli（34）、pi-compat（233）在 ARM 上全部通过。
- integration：198 失败 / 3980 通过。101 条报错是 `ENOENT: no such file or directory, realpath '/lib64'`，另有 JOB_HOST_NOT_READY、JOB_HOST_DEPENDENCIES_UNAVAILABLE。失败集中在 production-sandbox-lineage、production-task-environment-route、production-sandbox-scope、production-sandbox-queue-reentry、production-copy-save、sandbox-preparation-control 等文件。另有 7 个因没装 Playwright Chromium、3 个因缺预先打好的包而失败，与架构无关。
- `npm test`（scripts/ci/local.mjs）在 ARM 上立即抛 CI_LOCAL_PLATFORM_UNSUPPORTED（local.mjs:22-27）。
- /lib64 出现的位置：packages/platform-node/src/capabilities/isolation.ts:540-542；apps/agent-service/src/sandbox-command-inventory.ts:9、:70；scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:343；scripts/delivery-mode/sandbox-command-links.py:4；scripts/operations/hermes-*-seal.mjs；test/fixtures 和若干 probe 脚本。
- 平台名写死的位置：scripts/ci/install-tools.mjs:25、scripts/ci/build.mjs:133、scripts/ci/run.mjs:283/477/561、scripts/ci/test.mjs:151、scripts/ci/browser.mjs:128、scripts/ci/aggregate.mjs:201；scripts/delivery-mode/make-packet.py:385/428、run-packet-checks.py:163（`linux-x64-abi127-`）。
- 资格回执绑定主机名、平台、架构、内核：scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:37-41。
- 一手资料：bubblewrap 手册 `--ro-bind-try`「Equal to --ro-bind but ignores non-existent SRC」（https://github.com/containers/bubblewrap/blob/main/bwrap.xml）；Anthropic sandbox-runtime 的 linux-sandbox-utils.ts 对不存在的目录跳过（「A directory that is not there is skipped: bwrap cannot bind a missing source」）。

# 请你回答
从问题本身出发给出你的方案：改哪些地方、按什么顺序、怎样证明 x64 行为不变、怎样验证 ARM 上真的可用、有哪些我们没列出的写死 x64 或 x86 目录布局的地方（请自己读代码找）、有什么风险。
