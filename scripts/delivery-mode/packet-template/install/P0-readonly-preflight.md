# S0：冻结前的三项生产只读读取

固定目标是 `__PKT_ADDRESS__`，主机名 `__PKT_HOSTNAME__`，服务账号 `himawari-prod`（uid __PKT_SERVICE_UID__、gid __PKT_SERVICE_GID__），unit（systemd 服务定义）`himawari-prod.service`。当前运行的旧版本是第九次部署的 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__`，Node 是 `/opt/himawari/node/bin/node`。

S0 只读不写：三个本地脚本经 SSH 标准输入送到服务器执行，服务器上不留脚本，不停服务，不改数据库、配置或 unit。它要以 root 连接生产服务器，必须先得到用户对第十次 S0 的批准（G180），并且 [read-s0-db.mjs](../s0-db/read-s0-db.mjs) 已定稿；读取之后读取脚本若再改，要先问用户再重读。在 MacBook 的仓库根目录运行：

```sh
bash .ci-output/production/run-__PKT_LABEL__-packet-s0.sh
```

[包装脚本](../../run-__PKT_LABEL__-packet-s0.sh)以第五次已在生产跑通的 `run-sixth-s0.sh` 为基础（包名、执行记录目录、错误码前缀和 npm 核对的批准参数从“eleventh”换成“__PKT_LABEL__”），并在连接服务器之前自己先做本地检查：参数个数不是 0 时打印用法并以 64 退出；包里已有 `freeze-manifest.json` 时以 `__PKT_LABEL_UPPER___S0_PACKET_FROZEN` 拒绝（S0 只在冻结前运行）；`signing/collect-system-tools.mjs` 写死的 `verifierSha256` 必须等于 `signing/cloud-system-tool-bindings.mjs` 的 SHA-256，否则以 `__PKT_LABEL_UPPER___S0_VERIFIER_CHANGED` 拒绝；脚本摘要记录 `S0.<时间>.script-sha256.txt` 也包含 `cloud-system-tool-bindings.mjs`。三条 `ssh` 都带 `ServerAliveInterval=15` 和 `ServerAliveCountMax=4`；每次读取后、改名之前，输出必须是非空的合法 JSON，否则以 `__PKT_LABEL_UPPER___S0_OUTPUT_INVALID:<名字>` 停下并保留 `.partial` 供诊断。然后依次执行：

1. **数据库读取**：以 `himawari-prod` 运行 [read-s0-db.mjs](../s0-db/read-s0-db.mjs)，数据库以只读、query_only 方式打开。输出 Schema（数据库结构版本，第十次是 51）、完整迁移记录、部署身份、epoch 和 fencing token（租约代数和防止旧进程继续写的递增编号）、升级门计数（未解决的沙箱预约必须为零）、12 张历史表各自的行数和摘要、当前授权（编码路由指向的 `directory:himawari-prod-workspace-20261015`）、工作目录 `/var/lib/himawari/workspace` 及其 `files/`、`repos/` 的 device/inode、属主和权限、pi 和 exa 的能力声明比较结果、旧 unit、旧配置和旧 pair supervisor（第五次的 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/pair-supervisor.mjs`）的 SHA。不含消息正文、工具结果或秘密。保存为 `inputs/s0-db-readback.json`。
2. **系统工具身份**：以 root 运行 [collect-system-tools.mjs](../signing/collect-system-tools.mjs)，只读 `/usr/bin/bwrap`、`/usr/bin/socat`、`/usr/bin/bash`、`/usr/bin/rg` 及其符号链接链的属主、权限、device/inode 和 SHA-256，不执行这些工具。保存为 `inputs/system-tools-observed.json`。
3. **npm 只读核对**：以 root 运行 [observe-production-npm.py](../acceptance/helpers/observe-production-npm.py)，核对已安装 npm 的完整文件字节，并执行一次受限的 `npm --version`（离线、禁止写文件、用户配置为 `/dev/null`，全局配置路径 `/opt/himawari/node/.__PKT_LABEL__-__PKT_DATE_COMPACT__-npm-empty-globalconfig` 必须不存在且执行后仍不存在）。保存为 `inputs/npm-observed.json`。

三个目标文件已存在时包装直接拒绝，不覆盖。第五次的 S0 读回留在第五次操作包的 `inputs/`；从第五次复制进第六次草稿的四份旧文件（这三份读回和第五次冻结的 `inputs/bindings.json`）已在 2026-10-18 挪出本包，放在 `.ci-output/sixth-packet-work/removed-from-packet/`（文件名前加 `inputs-`，摘要记在同目录的 `SHA256SUMS.txt`），不作为第六次的输入；第六次必须重新读。这四份是复制后又经第六次改名的版本（例如 `schemaVersion` 已改成第六次的名字），除 `system-tools-observed.json` 外，内容和摘要都与第五次包内冻结的原件不同，核对第五次证据时要用第五次包内的原件。执行日志、脚本摘要和输出摘要留在 `.ci-output/production/__PKT_DATE__-__PKT_LABEL__-change-execution-01/`。

冻结助手 [finalize-bindings.py](../inputs/finalize-bindings.py) 读取这三份文件，要求：Schema current、minimumWriter、迁移账本条数和最大值都是 50；没有未解决的预约；部署身份 active；编码路由的授权是第四次的 `directory:himawari-prod-workspace-20261015`，未撤销、未到期；工作目录和两个子目录属于服务账号、权限 0700，目录的 device/inode 等于授权记录；旧 unit、旧配置和 pair supervisor 的 SHA 写进绑定，供 S2、S7、S9 核对。任何不符只报告差异（错误码 `__PKT_LABEL_UPPER___S0_*`、`__PKT_LABEL_UPPER___OLD_GRANT_*`），不修改历史，也不改模板预期。

能力声明的比较要用登记时的程序目录。生产数据库里的能力目录在第五次 `S7_CATALOG_UPGRADE` 时已改成第五次快照的声明，声明里的程序路径以 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__/lib/himawari-agent` 开头；第五次之前的部署只换能力快照，没有重新登记。比较前两边各自把自己的目录换成同一个占位符再逐字比较，所以 S0 读取、维护程序和 S7 启动检查都用 `read-s0-db.mjs` 导出的 `catalogRegistrationPrefix`（现在是第五次安装目录）处理声明一侧。第六次的 `S7_CATALOG_UPGRADE` 再把登记换成第六次快照的声明，程序路径随之变成第六次的安装目录，所以升级之后的读回改用新安装目录比较（`maintenance/maintenance-common.mjs` 的 `readCatalogState`），见 [能力登记与签署](../signing/catalog-binding-report.md)。

S1 之后每一步还会按自身规则重新核对当前身份、权限、SHA 和状态；S0 通过不代替执行时的读回。
