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
