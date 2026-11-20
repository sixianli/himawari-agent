你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 34f2e1411ce45e483eae0d3cbb3418343c0ad67e。
待审核的方案：
# 方案审核材料：把 Himawari 生产从 x86-64 主机迁到 ARM64 主机（线程的方案）

问题、目标、Andy 的约束、已核实的事实和一手资料，与同目录的 `34f2e1411ce4-plan.md` 相同，请先读它。下面只补充之后新核实的事实，然后是线程自己的方案。请找出线程方案里漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。

## 之后新核实的事实（2026-11-20，目标机只读查看）

- 目标机上 uid 999 已被 `ocarun`（Oracle Cloud Agent 的运行账号）占用，gid 988 已被 `gh-ci-share`（CI runner 的共享组）占用；Contabo 生产服务账号是 uid 999 / gid 988，并且模板里多处写死这两个数。
- 目标机 `/usr/bin/socat` 是指向 `socat1` 的符号链接；`/usr/bin/bash`、`/usr/bin/rg`、`/usr/bin/bwrap` 存在。
- 目标机 docker 组只有 `ubuntu` 一个成员；两个 runner 账号是 `gh-runner-arm-1`（uid 995）、`gh-runner-arm-2`（uid 994）。
- `unattended-upgrades` 的自动重启是默认关闭（`Automatic-Reboot "false"` 是注释掉的默认值）。
- Contabo 发布包里 `onnxruntime-node` 是 1.30.0，只带 `bin/napi-v6/linux/x64`（打包时按平台过滤，见 `scripts/package-node-runtime.mjs` 的 `NATIVE_BINARY_ROOTS`）；ADR 0253 记录在这台 ARM 机上 `npm ci` 装 `onnxruntime-node` 通过。
- `cloud-seal.mjs:441` 写死主机签名公钥路径 `qualification/first-20261007/host-qualification-public-key.pem`，缺失时报 `FIRST_SIGNING_KEY_REQUIRED`。
- `scripts/ci/platforms.mjs:15` 的 `ARTIFACT_PLATFORM_KEYS` 只有 `macos-arm64` 和 `linux-x64`。

## 线程的方案

A 代码（完成 ADR 0253 第 4 条并扩到生产）

- A1 目标平台显式化：实例文件加 `platform`（`linux-x64` / `linux-arm64`），`make-packet.py`、`run-packet-checks.py` 按平台找产物；安装脚本把 `process.arch === "x64"` 换成渲染进去的目标架构；Node 摘要、Python 包按平台从 `ci/toolchain-lock.json` 取；fd 按平台钉住。x64 默认值和产出字节不变。
- A2 ARM 候选在 ARM 上原生构建：在 Oracle 这台机上开一个独立构建账号（无 sudo、读不到生产目录，参照 ADR 0056 在 Contabo 上开 `himawari-ci` 测试账号的先例），构建机身份写进仓库配置；better-sqlite3、`rename-native` 在那里编译，浏览器发布验收也在那里跑。备选：GitHub 的 ARM runner 出产物；在 Hermes 上交叉编译（不推荐，原生模块和浏览器验收必须在真实 ARM 上跑）。
- A3 `cloud-seal.mjs`、探测脚本、`deploy-preflight.py` 的只读目录清单改用 `packages/testing/src/read-only-toolchain.mjs` 里已有的“可选 `/lib64` 不存在才跳过”写法（上线包里放同语义的副本，不把测试包打进生产），同时更新 `scripts/delivery-mode/probe-sources.json` 里的摘要。
- A4 新主机首装上线包：不读 S0 的运行版本，要求目标机上服务不存在、目录为空；安装锁定版本的 Node，建服务账号，装服务单元，跑现有的验收和 `cloud-seal` 生成新回执，`cloud-protected-prepare` 一行不改。数据不在首装包里。
- A5 并行验证副本：配置里不写 `runPolicy.proactive`、`realEval`、`museIntake`，不装心跳，不装 cloudflared；提醒是否仍会投递要实测，必要时加一个明确的“验证副本”开关。
- A6 新 ADR 取代 ADR 0253 的“ARM 只做测试、线上不切换”。

B 运维第一阶段：用首装包装到 Oracle → 生成新回执（主机名 `himawari-prod`、架构 arm64、内核 `7.0.0-1013-oracle`）→ 在 Contabo 上用 SQLite backup 做一致性拷贝，复制过去核对大小和关键表行数 → 用 `ssh -L` 把 Oracle 的 127.0.0.1:8400 转到本地做问答、搜索、抓取、文件、记忆验证；这份数据副本只用于验证，切换时丢弃。

C 第二阶段（只设计）：按 `docs/runbooks/authority-transfer-runbook.md` 停 Contabo、export、在 Oracle import（epoch 和 fencing token 各加一）、activate；cloudflared 换到 Oracle；心跳迁过去。

D Oracle 系统锁定：内核和受检程序 `apt-mark hold`，自动更新排除名单，GRUB 固定到当前内核，照 `docs/runbooks/production-server-access-runbook.md` 的 Contabo 做法。

E 和 CI runner 同机：给 runner 设 CPU 上限，或把 CI 挪走。

## 请回答

1. 线程方案漏掉了什么场景，哪一步会失败或出错，按严重程度排。
2. 哪些判断是错的，依据是哪段代码或哪份文档。
3. 和业界成熟做法不一致的地方（附一手来源）。
4. 你会怎样改这份方案。
