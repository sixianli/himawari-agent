# 第十二版操作包和出包工具：只读快照与交接说明

写给“上线脚本按参数自动生成”线程。写于 2026-10-26，第十二次上线（源码 `470b6d30`）成功之后。

## 0. 这是什么

- 这是一份只读快照，只供写自动生成器时参考。不要直接用这里的文件上线：冻结后的包只对当时的生产状态有效，每次上线都要重新生成、重新冻结。
- 原件在 Andy 的 Mac 上：`himawari-agent/.ci-output/production/`。`.ci-output` 目录不进 git，云端线程看不到，所以做了这份快照。
- 快照里有：
  - `twelfth-freeze-tools/`：Mac 上用的出包小工具（下文第 7 节），加上本版的构建摘要 `cc-build-470b6d30-r1.summary`、`run-cand-470b6d30.out` 和新值表 `new-values-470b6d30.json`，它们是这些工具的真实输入样例。
  - `hermes-build/`：Hermes 测试机上构建候选产物的三个脚本（`e3-build.sh`、`build-cand.sh`、`run-cand.sh`），从 `/home/andy/himawari-tests/eleventh/` 原样取回。
  - `run-twelfth-packet-s0.sh`：在生产机上只读读取当前状态的脚本（S0，见第 1 节）。
  - `samples/new-values-aa563155.json`：第十一版的新值表，和本版的对照就是“旧值 → 新值”。
  - `packet/2026-10-26-twelfth-change-packet-01/`：第十二版操作包，已冻结（`inputs/bindings.json` 的 `status` 是 `frozen-approved`）。
- 快照里没有：`materials/` 下的大文件（安装包 tar.gz、源码 bundle、node-modules、Python 包，只留了 497 字节的 `context.json`）、`run-logs/` 上线日志、执行记录目录、任何密钥或 secrets 目录、数据库文件。推送前按 `scripts/scan-machine-secrets.mjs` 的同一组规则扫过，没有命中。

## 1. 先说明几个词

- 操作包（packet）：一次上线用的全部脚本、期望值和输入文件，目录名 `2026-10-26-twelfth-change-packet-01`。每个子目录管一段：`install/` 安装、`systemd/` 停服和启动、`maintenance/` 数据库复制和恢复、`acceptance/` 停服后的主机验收、`signing/` 签名、`measurement/` 读回、`steps/` 每一步的入口 `run-step.py`。
- 候选产物（candidate）：Hermes 用要上线的那个提交构建出的安装包，例如 `linux-x64-abi127-470b6d30…-1.tar.gz`，加上 `context.json`（记录构建用的提交号）。
- S0：上线前在生产机上只读读取当前状态，写进包里的三个文件：`inputs/s0-db-readback.json`（数据库版本、授权令牌号、配置指纹、systemd 单元文件指纹）、`inputs/system-tools-observed.json`（系统工具哈希）、`inputs/npm-observed.json`（npm 文件清单）。
- 配置指纹：生产配置文件 `/etc/himawari/config.json` 原始字节的 SHA-256，详见第 6 节。
- 单元文件（unit）：systemd 用来启动服务的配置文件 `himawari-prod.service`。
- `bindings`：包里的“本次上线参数表”。`inputs/bindings.draft.json` 是草稿，`inputs/finalize-bindings.py` 把它和 S0 合并，写出 `bindings.reviewed.json`（待审）或 `bindings.json`（冻结版）。
- 冻结（freeze）：`finalize-bindings.py --freeze-reviewed-packet …` 写出 `bindings.json` 和 `freeze-manifest.json`，后者记下包里每个文件的字节数和 SHA-256。冻结后改任何文件，上线脚本都会拒绝。
- `OWNED-SHA256SUMS`：`measurement/`、`systemd/`、`acceptance/`、`maintenance/` 各自带的文件哈希清单，改了这些目录里的文件就要重算。
- 授权令牌号（fencingToken）：数据库里记的“当前哪个服务实例有写权限”的递增编号。每次服务换实例都会加一，所以每次上线都要从 S0 重新读。

## 2. 出包命令顺序和耗时

时间是 2026-10-26 UTC，第十二版第一次出包。`P` 指操作包目录，`T` 指 `twelfth-freeze-tools/`，`REV` 是 40 位提交号，`REV8` 是它的前 8 位。

| 顺序 | 做什么 | 在哪 | 命令 | 开始 | 用时 |
| --- | --- | --- | --- | --- | --- |
| 1 | 复制上一版的包和工具 | Mac | `rsync -a --exclude run-logs --exclude .claude --exclude 'materials/linux-x64-*' --exclude 'materials/node-modules.*' --exclude materials/npm-ls.json --exclude materials/context.json --exclude 'materials/source-*' <十一版包>/ <十二版包>/`；工具目录同样复制，排除 `cc-build-*`、`run-cand-*`、`new-values-*` | 10:08 | 不到 1 分钟 |
| 2 | 按序号改名 | Mac | `python3 -I T/rename-to-twelfth.py P`（先看改动），再加 `--apply` | 10:08 | 不到 1 分钟 |
| 3 | 构建候选产物 | Hermes | `bash e3-build.sh`（内部调 `build-cand.sh <bundle> <分支> REV <上一版提交> cc-build-REV8-r1` 和 `run-cand.sh REV cc-build-REV8-r1`，再装一次前缀目录） | 10:14:21 | 约 6 分钟（10:20:06 结束） |
| 4 | 取回材料 | Mac ← Hermes | `bash T/fetch-materials.sh REV cc-build-REV8-r1` | 10:25 | 约 1 分钟 |
| 5 | 生成新值表 | Mac | `python3 -I T/make-new-values.py REV T/run-cand-REV8.out T/new-values-REV8.json` | 10:26 | 几秒 |
| 6 | 清掉上一版的候选字段和冻结文件 | Mac | `python3 -I T/unfill-draft-twelfth.py --apply`；删 `P/inputs/bindings.json`、`P/inputs/bindings.reviewed.json`、`P/freeze-manifest.json` | 10:27 | 几秒 |
| 7 | 把上一版的哈希换成本版的 | Mac | `python3 -I T/retarget-candidate.py --packet P --old-values <上一版 new-values> --new-values T/new-values-REV8.json --apply` | 10:27 | 几秒 |
| 8 | 填候选字段 | Mac | `python3 -I T/fill-candidate-twelfth.py REV T/cc-build-REV8-r1.summary --apply` | 10:28 | 几秒 |
| 9 | 真实浏览器走查 | Hermes | 结果写进 `P/browser-acceptance/walkthrough.json` | 开始时间没单独记 | 10:41:56 完成 |
| 10 | 手改数据库版本和生产配置期望 | Mac | 手工，见第 3 节 C、D 组 | 10:41 | 约 10 分钟 |
| 11 | S0 | Mac → 生产机，只读 | `bash run-twelfth-packet-s0.sh`（包已冻结时它会拒绝） | 10:52 | 约 30 秒 |
| 12 | 填旧配置指纹，重算哈希清单 | Mac | `fill-old-config.py P --apply`；`regenerate-owned-sums.py P --apply`；`regenerate-cloud-input-files.py P "<改过的文件名，逗号分隔>" --apply`；`P/inputs/check-packet-consistency.py P` | 10:53 | 约 1 分钟 |
| 13 | 包检查和定稿检查 | Hermes | 把包（不含大文件）打成 tgz 上传；`run-packet-checks.sh <tgz>`；`run-finalize-checks.sh <tgz> <S0 的配置指纹>` | 10:54 | 约 2 分钟 |
| 14 | 定稿、冻结 | Mac | `P/inputs/finalize-bindings.py --candidate-from-s0`；`P/inputs/finalize-bindings.py --freeze-reviewed-packet round2/R2-L13/twelfth-20261026/reviewed`；`check-packet-consistency.py P`；`scripts/delivery-mode/browser-acceptance-gate.py P` | 10:56 | 约 1 分钟 |
| 15 | 上线 | Mac → 生产机 | `bash scripts/delivery-mode/deploy.sh P` | 10:57 | 见下表 |

从复制到开始上线共约 49 分钟，其中手工约 10 分钟、等 Hermes 约 9 分钟，其余是人工核对。第一次上线失败后，从第 11 步重来：11:26 S0，11:29 完成 `--candidate-from-s0`；12:00:30 冻结，12:00:41 开始上线。中间约 30 分钟是在修回滚脚本和跑测试，不算出包本身的时间。

第二次上线（成功）每一步的开始时间（UTC）：

| 步骤 | 开始 | 用时 |
| --- | --- | --- |
| S1_TRANSPORT | 12:00:52 | 3 分 46 秒 |
| S1_INSTALL | 12:04:38 | 2 分 47 秒 |
| S2_STOP（停服） | 12:07:25 | 9 秒 |
| S3_COPY51 | 12:07:34 | 20 秒 |
| S6_ACCEPTANCE | 12:07:54 | 6 分 45 秒 |
| S6_PUBLISH_MATERIALS | 12:14:39 | 9 秒 |
| S6_FINALIZE_BINDINGS | 12:14:48 | 8 秒 |
| S6_SIGN | 12:14:56 | 18 秒 |
| S6_RUNTIME_PROTECTION | 12:15:14 | 39 秒 |
| S6_READ | 12:15:53 | 13 秒 |
| S7_DB_STATUS | 12:16:06 | 14 秒 |
| S7_CONFIG_APPLY | 12:16:20 | 10 秒 |
| S7_CATALOG_UPGRADE | 12:16:30 | 42 秒 |
| S7_SWITCH_START | 12:17:12 | 2 分 25 秒（服务 12:18:14 起来） |
| S8_READBACK | 12:19:37 | — |

停服时间约 11 分钟（12:07:25 到 12:18:14），其中 `S6_ACCEPTANCE` 占将近 7 分钟。步骤名里的 `51`（`S3_COPY51`、`S9_RAW_RESTORE51`、`S9_RAW_CONTROL51`）是历史上定下的固定名字，和数据库版本无关，生成器不要按数据库版本拼。

## 3. 每次手改或靠工具替换的字段

下表的“旧值”是第十一版（`aa563155`），“新值”是第十二版（`470b6d30`）。长哈希只写前 8 位，完整值在 `samples/new-values-aa563155.json`、`twelfth-freeze-tools/new-values-470b6d30.json` 和 `packet/…/inputs/bindings.json` 里。“应从哪推出”是生成器该读的来源。

### A 组：版本序号和路径（`rename-to-twelfth.py` 做的文字替换）

| 文件 | 字段或内容 | 旧值 → 新值 | 应从哪推出 |
| --- | --- | --- | --- |
| 全包的文件名和文本 | 版本词、错误码前缀 | `eleventh` → `twelfth`、`tenth` → `eleventh`、`ELEVENTH_` → `TWELFTH_` | 本次序号。生成器应该让版本名只出现在一个参数里，而不是全文替换 |
| 全包 | 新安装目录 | `/opt/himawari/releases/2026-10-26-eleventh` → `…-twelfth` | 参数：本次发布名 |
| 全包 | 新操作目录 | `/opt/himawari/operations/eleventh-20261026` → `twelfth-20261026` | 参数：本次发布名 |
| `systemd/S7-switch-start-readback.py`、`maintenance/maintenance-common.mjs` | 前端静态目录（staticRoot）的旧值和新值 | 旧 `…/2026-10-26-eleventh/share/control-center`，新 `…/2026-10-26-twelfth/share/control-center` | 旧值 = 正在运行的单元文件里 `--prefix` 的值 + `/share/control-center`（S0 能读到）；新值 = 新安装目录 + 同样后缀 |
| `systemd/himawari-prod.service.draft` | 新单元文件里的安装目录和操作目录 | 随上面两行变 | 同上 |

### B 组：候选产物（`retarget-candidate.py` 和 `fill-candidate-twelfth.py` 做的替换）

| 文件 | 字段 | 旧值 → 新值 | 应从哪推出 |
| --- | --- | --- | --- |
| `inputs/bindings.draft.json` 的 `d1Commit`、`gateCommit`、`candidate.testedCommit`；`inputs/finalize-bindings.py` 的 `head =`；`install/twelfth-artifact-install.mjs` 的 `const head`；`systemd/S7-startup-readback.mjs` 的 `receipt.source.revision` | 上线的提交号 | `aa563155…` → `470b6d30…` | 参数：要上线的提交 |
| `bindings.draft.json` 的 `candidate.archiveBytes/archiveSha256/archivePath`；`install/p5-materials.json`；`install/twelfth-artifact-install.mjs` 的 `expected` 表 | 安装包 | 64138340 字节 `bbb339fc` → 64137729 字节 `4b341bf8` | Hermes 构建产物（`run-cand` 输出的 `artifactName/artifactSha256/artifactBytes`） |
| 同上 | `contextSha256`、`contextBytes` | `a4ae0292` → `fbaa323e` | `run-cand` 输出 |
| `candidate.sourceTreeDigest`；`twelfth-artifact-install.mjs` 的 `expectedSourceTreeSha256` | 源码树指纹 | `663137c3` → `2ff8e75c` | `run-cand` 输出的 `sourceTreeSha256` |
| `installationInputs.sourceBundlePath/Bytes/Sha256`；`twelfth-artifact-install.mjs` 的 bundle 文件名 | 源码 bundle | `source-aa56315.bundle` 103302952 字节 `def06f27` → `source-470b6d3.bundle` 103368750 字节 `cf873860` | 生成 bundle 后计算 |
| `installationInputs.sourceModeProofSha256` 等 | 源码文件权限证明 | `f9791c85` → `e988930f` | `cc-build-REV8-r1.summary` |
| `install/p5-materials.json`、`twelfth-artifact-install.mjs` | node-modules 包、node-modules 清单、npm-ls 的哈希和字节数 | 见两份 new-values | `run-cand` 输出 |
| `twelfth-artifact-install.mjs` | 源码输入记录数 | 见 new-values 的 `sourceInputRecordCount` | `run-cand` 输出第一行 `capture records N` |
| `acceptance/cloud/adaptation-manifest.json`、`acceptance/cloud/r2l6-source-manifest.json` | `regressionSource` 的哈希和字节数 | 见 new-values | `make-new-values.py` 的第 4 个参数（回归用的提交） |
| `bindings.draft.json` 的 `candidate.materialReadback`、layer3/layer4 的“未运行”说明 | 说明文字里的提交号 | 跟着提交号变 | 提交号 |

### C 组：数据库版本（全靠手改，最容易漏）

第十一版的参数表写的是 55（`expectedInitialSchema`、`expectedMinimumWriter`、`targetSchema` 都是 55），再在 `S7_CONFIG_APPLY` 里额外把数据库从 55 迁到 56；第十二版上线时数据库已经是 56，新代码也是 56，所以不需要迁移。下面这些全是手改的：

| 文件 | 字段或内容 | 旧值 → 新值 | 应从哪推出 |
| --- | --- | --- | --- |
| `inputs/bindings.draft.json` 的 `maintenance` | `targetSchema` | 55 → 56（`expectedInitialSchema`、`expectedMinimumWriter` 在草稿里写成 `S0_DB:schema.current`、`S0_DB:schema.minimumWriter`，由 S0 自动填，结果也是 55 → 56） | 目标版本 = 新代码里最大的迁移号 |
| 同上 | 恢复点名字 | 键 `recovery55Id`、值 `eleventh-20261026-raw-schema55` → 键 `recovery56Id`、值 `twelfth-20261026-raw-schema56` | S0 的当前数据库版本 |
| `inputs/finalize-bindings.py`、`inputs/verify-finalize-bindings.py` | `recovery_contract`、S0 版本期望 `{'current': 55, …}`、禁止出现的旧键列表 | 55 → 56；禁止列表加上 `recovery55Id` | S0 的当前数据库版本 |
| `maintenance/maintenance-common.mjs` | 恢复点版本检查、`recovery56Id` | 55 → 新增常量 `currentSchema = 56` | 同上 |
| `maintenance/run-maintenance.mjs` | 证据文件名 | `s3-copy-before55.json`、`s3-copy-after55.json` → `…56.json`；`recovery55Readback` → `recovery56Readback`；`recoveryPoints.schema55` → `schema56` | 同上 |
| `maintenance/S9-control-files.py` | `schema`、`recovery_id`、保留恢复点的版本检查 | 55 → 56；`(55, 56)` → `== 56` | 同上 |
| `maintenance/verify-s9-control-fixtures.py` | 测试数据里的版本和键名 | 55 → 56 | 同上 |
| `s0-db/read-s0-db.mjs` | 允许的当前版本 | `[55, 56]` → `=== 56` | 同上 |
| `maintenance/raw-copy-recovery.mjs` | 允许的版本列表 | `[50, 51, 55]` → `[50, 51, 55, 56]` | 同上 |
| `systemd/S7-switch-start-readback.py` | 启动前后的版本期望 | `(state, 55)` → `(state, 56)` | 同上 |
| `maintenance/maintenance-common.mjs`、`maintenance/run-maintenance.mjs` | 迁移代码 | 删掉 `migrateDatabaseTo56` 及相关函数；`S7_CONFIG_APPLY` 不再调 `db migrate` | 当前版本 = 目标版本时不迁移 |
| `maintenance/verify-migrate56-fixtures.mjs` | 迁移测试 | 删掉 | 同上 |

### D 组：生产配置期望（手改；第十二版第一次上线就失败在这里）

第十一版上线时把生产配置从 `publicFetch.maximumBytes = 32768` 改成 102400，并给 `deepseek-primary` 模型写入 `contextWindow = 1000000`、`maxTokens = 32768`。第十二版上线时这些已经是新值，`S7_SWITCH_START` 里却还留着“原值必须是 32768”的期望，于是报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`。

| 文件 | 字段 | 旧值 → 新值 | 应从哪推出 |
| --- | --- | --- | --- |
| `systemd/S7-switch-start-readback.py` 的 `static_root_configuration` | 原配置期望 | “原值 32768，改成 102400；补上模型上限” → “原值必须已经是 102400，模型上限必须已经是 1000000/32768，不能有 `budgets`，不再改” | S0 读到的生产配置当前值，不该写死 |
| `maintenance/maintenance-common.mjs` | `approvedPublicFetch = { from: 32768, to: 102400 }` | → `approvedPublicFetchBytes = 102400`，只检查不修改 | 同上 |
| `maintenance/run-maintenance.mjs` | 新版本读配置后的检查 | `approvedPublicFetch.to` → `approvedPublicFetchBytes` | 同上 |
| `maintenance/verify-fixtures.mjs` | 测试数据里的“原配置” | 改成 102400、1000000/32768、无 `budgets` | 同上 |

### E 组：生产机当前状态（每次 S0 后都要更新）

| 文件 | 字段 | 旧值 → 新值 | 应从哪推出 |
| --- | --- | --- | --- |
| `systemd/S2-stop-and-inspect.py`、`maintenance/S9-control-files.py` | `OLD_CONFIG_SHA` | `219a21da` → `e889278a` | S0 的 `service.configurationSha256`，由 `fill-old-config.py` 填。服务每次重启都会变，见第 6 节 |
| `bindings.json` 的 `service.oldConfigSha256` | 旧配置指纹 | 同上 | 草稿里写 `S0_DB:service.configurationSha256`，`finalize-bindings.py` 自动填 |
| `bindings.json` 的 `service.oldUnitSha256` | 旧单元文件指纹 | `ea42411a` → `e2239417`（等于上一版的 `newUnitSha256`） | `S0_DB:service.unitFragmentSha256`，自动填 |
| `bindings.json` 的 `service.newUnitSha256` | 新单元文件指纹 | `e2239417` → `6935a793` | `finalize-bindings.py` 对 `systemd/himawari-prod.service.draft` 算 SHA-256 |
| `bindings.json` 的 `authority.*` | 授权令牌号等 | `fencingToken` 29 → 31 | `S0_DB:authority.*`，自动填 |
| `bindings.json` 的 `inputReadbacks` | 三份 S0 文件的 SHA-256 | 每次不同 | `finalize-bindings.py` 自动算 |

### F 组：哈希清单（工具重算）

- `measurement/`、`systemd/`、`acceptance/`、`maintenance/` 的 `OWNED-SHA256SUMS`：`regenerate-owned-sums.py P --apply`。
- `acceptance/cloud/cloud-inputs.draft.json` 里的文件哈希：`regenerate-cloud-input-files.py P "<改过的文件名>" --apply`。第二个参数必须列全改过的文件，传空字符串只做检查。
- `freeze-manifest.json`：冻结时由 `finalize-bindings.py` 生成。

## 4. `bindings.json` 的结构

顶层键（`schemaVersion` 为 `himawari.twelfth-change-bindings.v1`）：

| 键 | 子键 | 来源 |
| --- | --- | --- |
| `status` | — | 草稿是 `candidate-awaiting-s0-db-and-freeze`，`--candidate-from-s0` 后是 `ready-for-Claude-review`，冻结后是 `frozen-approved` |
| `d1Commit`、`gateCommit` | — | 提交号 |
| `candidate` | `testedCommit`、`archivePath/Bytes/Sha256`、`contextPath/Bytes/Sha256`、`sourceTreeDigest`、`materialReadback`、`layer3Status/Fingerprint/Counts/Projects`、`hermesLayer3Report*`、`hermesLayer3TestsReport*`、`hermesLayer4Report*`、`layer4Scope`、`layer4FinalCandidateEvidence*`、`layer4CandidateRelation`、`evidenceIds`、`artifactRuntimeAndUiContentSha256`、`installationRehearsalEvidence`、`installedPrefixDigestHermesOnly`，共 31 个 | Hermes 构建（B 组） |
| `installationInputs` | `sourceBundlePath/Bytes/Sha256`、`sourceModeProofPath/Bytes/Sha256/RecordCount`、`sourceModeCounts`、`sourceModeProofDigestBeforeAndAfter`、`sourceModeCaptureWritesPerformed`、`sourceModeCapturePermissionChangesPerformed`、`installationWrapper`、`materialManifest` | Hermes 构建 |
| `host` | `address`、`hostname`（`vmi3618928`）、`account`、`uid`、`gid`、`node`、`nodeVersion`、`nodeSha256`、`systemBwrapIdentity`、`programBwrapIdentity`、`serviceAccount`、`systemBwrap`、`programBwrap`、`apparmorRestrictUnprivilegedUserns` | 固定，`finalize-bindings.py` 用 `system-tools-observed.json`、`npm-observed.json` 核对 |
| `paths` | `oldPrefix`、`newPrefix`、`config`、`stateRoot`、`database`、`privateRoot`、`secretDirectory`、`evidenceRoot`、`transportRoot`、`validationSource`、`uiVerificationRoot`、`newOperations` | `oldPrefix`/`newPrefix`/`newOperations` 随版本变（A 组），其余固定 |
| `identity` | `deploymentId`、`ownerId`、`agentId`、`hostId` | S0（部分用 `S0_DB:` 占位），并核对固定值 |
| `maintenance` | `expectedInitialSchema`、`expectedMinimumWriter`、`targetSchema`、`recoveryMethod`（`stopped-raw-copy-v1`）、`recovery56Id` | C 组 |
| `service` | `unit`、`unitFragmentPath`、`oldUnitSha256`、`oldConfigSha256`、`pairSupervisor`、`workerTokenFile`、`newPrepareHelper`、`newRuntimeProtectionFile`、`newQualificationEvidenceRoot`、`newUnitSha256` | E 组；路径随版本变 |
| `smoke` | `designer`、`workspace`、`file`、`expectedToolCalls`、`operatorSuppliedPaidRequestsAuthorized`、`stage`、`finalPaidAcceptance` | 固定 |
| `approvals` | `qualificationRule`、`executionMethod`、`packageRef`、`executor`、`databaseFallbackExecutor`、`finalPaidAcceptanceExecutor` | `packageRef` 在冻结时写入，其余固定 |
| `authority` | `authorityEpoch`、`fencingToken`、`ownerId`、`agentId`、`deploymentId`、`status` | 全部来自 S0 |
| `workspace` | `decisionRef`、`routeKey`、`grantId`、`canonicalPath`、`subdirectories` | 固定，用 S0 核对 |
| `inputReadbacks` | 三份 S0 文件路径 → SHA-256 | 自动算 |

草稿里的 `S0_DB:<路径>` 占位符由 `finalize-bindings.py` 的 `resolve()` 按点号路径从 `s0-db-readback.json` 取值。本版草稿用了 12 个：`authority` 的 6 个、`identity.deploymentId`、`identity.hostId`、`schema.current`、`schema.minimumWriter`、`service.configurationSha256`、`service.unitFragmentSha256`。生成器可以照这个办法把更多字段改成从 S0 取。

## 5. 为什么 `S6_ACCEPTANCE` 到 `S6_READ` 排在 `S2_STOP` 之后

已经确认的事实（读代码）：

- `steps/packet-common.py` 的 `service_state()` 要求服务的 `MainPID` 是 `0`、`ActiveState` 是 `inactive`，否则报 `TWELFTH_PACKET_SERVICE_MUST_REMAIN_STOPPED`。`steps/run-step.py` 除了 `S2_STOP`、`S8_READBACK`、`S9_TRANSPORT_PREFLIGHT`、`S9_TRANSPORT_APPLY` 以外，每一步执行前都调用它。
- `acceptance/S6-limited-host-acceptance.sh` 自己也检查 `MainPID=0`，状态是 `inactive` 或 `failed`。`acceptance/cloud/run-cloud-acceptance.sh`、`prepare-twelfth-snapshot.sh` 和 `measurement/S6-service-read.py` 也检查服务已停。
- `S6_ACCEPTANCE` 在生产机上以 `himawari-prod` 账号真实启动沙箱做检查；`S6_SIGN`、`S6_RUNTIME_PROTECTION` 写的是新服务启动时要读的文件。

推断（没有找到书面理由）：这个顺序沿用了第一次安装时的“受限主机验收”设计（ADR 0050、0051），当时生产机上没有在跑的服务，所以“服务必须已停”被写成了每一步的通用前提。

要把它挪到停服之前，至少要改上面列的五处检查，并确认两件事：一，验收时启动的沙箱会不会和正在运行的服务抢同一个状态目录、端口或沙箱资源；二，`S6_SIGN` 和 `S6_RUNTIME_PROTECTION` 写的文件只放在新版本目录里、不会被旧服务读到。这两点我还没有验证。

## 6. 服务重启时改写的配置字段，和配置指纹的算法

- 单元文件的 `ExecStartPre`（启动前先跑的命令）是 `/opt/himawari/node/bin/node --no-global-search-paths /opt/himawari/operations/twelfth-20261026/cloud-protected-prepare.mjs --prepare /etc/himawari/config.json`。
- 它每次启动都改写配置里的 `capabilityDeployment` 字段：`{ "snapshotPath": "/var/lib/himawari/state/deployment/capability-deployment.json", "sha256": "sha256:<快照文件的哈希>" }`。快照文件里有 `checkedAt` 和 `observedAt` 两个字段，值是启动那一刻的时间（`new Date().toISOString()`），所以快照哈希每次都不同，配置文件的字节也每次都不同。配置文件的修改时间就等于服务启动时间。
- 配置指纹就是配置文件原始字节的 SHA-256，不做任何排序或规范化：`hashlib.sha256(pathlib.Path('/etc/himawari/config.json').read_bytes()).hexdigest()`（`systemd/S2-stop-and-inspect.py` 的 `digest()`）。S0 把它记在 `s0-db-readback.json` 的 `service.configurationSha256`。
- 后果：S0 到上线之间只要服务重启过一次（包括一次回滚），旧配置指纹就失效，必须重跑 S0、重填、重新冻结。实例：第十二版第一次 S0 读到 `3351547e…`，回滚重启后第二次 S0 读到 `e889278a…`。
- 生产配置顶层键：`agentId`、`cacheDirectory`、`capabilityDeployment`、`concurrency`、`deadlines`、`deploymentId`、`http`、`identity`、`memory`、`modelDescriptors`、`ownerId`、`publicMode`、`publicOrigin`、`repositoryAllowlistRefs`、`runPolicy`、`runtimeDirectory`、`schemaVersion`、`secretReferences`、`stateRoot`。

## 7. 现有生成工具在哪、怎么用

Mac：`himawari-agent/.ci-output/production/twelfth-freeze-tools/`（每版从上一版目录复制一份再改名，例如 `unfill-draft-eleventh.py` → `unfill-draft-twelfth.py`）。凡是带 `--apply` 的，不带时只打印要改什么。

| 工具 | 用法 | 做什么 |
| --- | --- | --- |
| `rename-to-twelfth.py` | `<包> [--apply]` | A 组文字和文件名替换（`PAIRS` 表），跳过 `materials/`、`run-logs/` |
| `fetch-materials.sh` | `REV cc-build-REV8-r1`，在仓库根目录跑 | 从 Hermes 拉安装包、`context.json`、node-modules 包和清单、`npm-ls.json`、`source-build-inputs.json` |
| `make-new-values.py` | `REV <run-cand 输出> <新值表输出> [<回归提交>]` | 读以 `CAND_OK` 结尾的 `run-cand` 输出，写出 19 个键的新值表 |
| `retarget-candidate.py` | `--packet P --old-values <旧表> --new-values <新表> [--apply]` | 在固定的一组文件里把旧值换成新值（B 组） |
| `unfill-draft-twelfth.py` | `[--apply]` | 把草稿里的 `candidate.*`、`installationInputs.*`、`approvals` 恢复成 `PENDING`，并重置 `finalize-bindings.py` 的 `head` 和 `OLD_CONFIG_SHA` |
| `fill-candidate-twelfth.py` | `REV <cc-build 摘要> [--apply]` | 填 `PENDING:candidate.`、`PENDING:user.` 的值和 `finalize-bindings.py` 的 `head` |
| `fill-old-config.py` | `<包> [--apply]` | 用 S0 的配置指纹替换两处 `OLD_CONFIG_SHA` |
| `regenerate-owned-sums.py` | `<包> [--apply]` | 重算四个 `OWNED-SHA256SUMS` |
| `regenerate-cloud-input-files.py` | `<包> "<改过的文件，逗号分隔>" [--apply]` | 更新 `cloud-inputs.draft.json` 的文件哈希 |
| `run-packet-checks.sh` | 在 Hermes 上：`<包 tgz>` | 解包后并行跑包里所有 `verify-*` 检查（含第 8 节的新检查） |
| `run-finalize-checks.sh` | 在 Hermes 上：`<包 tgz> <旧配置指纹>` | 跑 `verify-finalize-bindings.py` 一类的定稿检查 |
| `layer3-verdict.py` | — | 读 Hermes 构建报告判定是否通过 |
| `run-twelfth-packet-s0.sh` | 在 `production/` 目录：无参数 | 通过 ssh 只读读取生产机，写三份 S0 文件；包已冻结时拒绝 |

Hermes：

- 构建脚本：`/home/andy/himawari-tests/eleventh/e3-build.sh`、`build-cand.sh`、`run-cand.sh`。工具链在 `/data/hermes/himawari/tool-audit-round2/r30/tools/bin`，源码检出在 `/home/andy/himawari-tests/r2-u1/source`。
- 构建输出：`/data/hermes/himawari/tool-audit-round2/r2-u1/artifacts/cc-build-REV8-r1/`、`/data/hermes/himawari/tool-audit-round2/r2-u1/evidence/cc-build-REV8-r1.summary`、`/data/hermes/himawari/tool-audit-round2/r2-l13/candidate-REV8/`。
- 包检查目录：`/home/andy/himawari-tests/twelfth/`。
- Hermes 根分区只剩约 1.4 GB 空闲（构建日志里的 `free=1431736320`），生成器不要在根分区留大文件。
- 只能通过 `himawari-agent/.ci-output/handoff/scripts/hermes-ssh.sh` 和 `hermes-upload.sh` 连接；代码用 git bundle 同步，不在 Hermes 上改代码。

## 8. 两道失败检查在哪

1. 生产配置期望检查：`packet/…/systemd/verify-switch-config-fixtures.py`。它用“当前生产配置的样子”做测试数据，跑 `S7-switch-start-readback.py` 里的配置检查。由 `twelfth-freeze-tools/run-packet-checks.sh` 第 24 行调用，在 Hermes 上出包时跑。已验证：放进第十二版第一次失败的旧 S7 脚本，它报 `TWELFTH_SWITCH_ORIGINAL_PUBLIC_FETCH_CHANGED`、退出码 1；放新脚本退出码 0。
2. 回滚步骤名检查：仓库里的 `scripts/delivery-mode/test_rollback.py` 的 `PlanTest`。它检查 `rollback.py` 要跑的每个步骤名都在包的 `steps/run-step.py` 里，并且和 `deploy.sh` 里唯一的 S3 步骤一致。代码在分支 `claude/eleventh-hotfix`（提交 `2135359c`，PR #38，还没合并到 `main`）。另外 `scripts/delivery-mode/browser-acceptance-gate.py` 目前也只在这个分支上。

## 9. 生成器最该先解决的三件事（建议）

1. 把数据库版本（C 组）和生产配置当前值（D 组）改成从 S0 读出后自动生成期望，不再手写数字。这两组是这两次出事的直接原因。
2. 版本名、安装目录、操作目录只作为一个参数传入，取代全文替换和每版复制工具改名。
3. 冻结紧挨着上线做，并在上线前再核对一次配置指纹，因为任何一次重启都会让它失效。
