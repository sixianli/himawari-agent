## 结论摘要

- 最该先做的是**按内容哈希复用生产机上已有的材料**，不是“生产机去拉包”。实测上行 1.1–1.5 MB/s 是 Mac 的瓶颈；生产机下行 13.8 MB/s 说明目的端不缺带宽。复用可少传 `node_modules.tar.gz` 282 MB + `python-3.12.10.tar.gz` 34 MB，约省 210–290 秒。
- 残留路径问题应改成：清理器按**同一份目标路径清单**做最后一次清扫，能移走的移到一边，不移走就不进预检；同时把“清理失败”从静默继续改成预检前停止。
- 传输复用不能削弱安全：仍然以 `freeze-manifest.json` 的 SHA-256 为唯一依据，服务端对复用文件重新哈希，最后 `verify_frozen` 再全量核对。包的格式、manifest 的键集合都不改。
- 本方案不触碰模型请求组装，因此不改变系统提示、工具定义、历史、遮盖或每轮请求字节。

---

## 一、方案依赖的前提

以下来源均为仓库文件或本次材料；没有引用 web 结论。

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 上线前会先跑清理，再跑预检；但清理失败目前只打印，不阻止继续 | `scripts/delivery-mode/deploy.sh:16`：`release-cleanup.py ... \|\| echo "DEPLOY_CLEANUP_FAILED ..."`；`:83-87`：`cleanup before 1`，然后 `if ! ... deploy-preflight.py ... result preflight-failed` |
| P2 | 预检要求本次部署的每个目标路径都“不存在”，路径从 bindings 推导 | `deploy-preflight.py:99-101`：`return sorted({paths[key] for key in ('newPrefix','newOperations','evidenceRoot') ...} \| ...)`；`:199`：`('TARGET_PATH_ABSENT ' + path, facts.get('targetPath.' + path) == 'absent')` |
| P3 | 清理对非空 qualification 目录只保留，导致同名路径下次永远过不了预检 | `release-cleanup-remote.py:251-259`：`elif os.listdir(target): keep(target, 'qualification-not-empty')` |
| P4 | 清理已有“服务中/回退目标保留、其他删除”的规则，但没有“本次目标路径最终清扫” | `release-cleanup-remote.py:199-209`（旧版本删除）、`:219-225`（只保留服务中 stage 的 packet）、`:264-268`（失败 operations 删除） |
| P5 | 传输是全量逐成员，每个成员当场校验，最后再全量校验 | `transport-packet.py:82`：`require(member.isfile() and member.name in members and member.name not in seen, ...)`；`:87`：`require(seen == set(members), ...)`；`:88`：`common.verify_frozen(target, ...)` |
| P6 | 复用不能直接硬链接：读取函数要求 `nlink == 1` | `packet-common.py:41`：`require(path.resolve() == path and stat.S_ISREG(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 ...)` |
| P7 | S1 会再次核对冻结包成员集合、每个文件字节和 p5 的 7 个材料 | `S1-publish-and-install.py:29-30`（成员集合）、`:37-38`（逐文件哈希）、`:85-90`（p5 材料哈希） |
| P8 | 解压 node_modules 时逐文件按 `node-modules.json` 核对 | `extract-node-modules.py:31-32`、`:58`：`if digest.hexdigest() != item["sha256"] or count != item["bytes"]: raise ...` |
| P9 | node_modules 归档的生成参数看起来固定，且哈希已记入材料 | `collect-installer-dependencies.mjs:88`：`tar ["--sort=name","--mtime=@0","--owner=0","--group=0","--numeric-owner","--hard-dereference","--no-recursion","-czf",...]`；`:89` 记录 `archive.sha256` |
| P10 | Python 材料哈希写死，永不变化 | `make-packet.py:49-50`：`PYTHON_MATERIAL = ('python-3.12.10.tar.gz', 'f50d08...')`；`:530-531` 校验该哈希 |
| P11 | 源码 bundle 已经用服务端缓存做增量，是“内容可复用 + 使用时校验”的现成先例 | `make-packet.py:888-899`、`:921-929`；`install/source-cache.mjs:17-25`：`bundle verify`、`fetch ... refs/release/<head>`、`rev-parse` 必须等于 head |
| P12 | `onDeployFailure: keep` 是 Andy 的明确选择，不能顺手改成自动回滚 | `instances/andy-production.json:31`：`"onDeployFailure": "keep"`；`docs/incidents-and-gates.md:143` 记录 Andy 选“失败后不回滚,保留现场……以后的部署都改成这样” |
| P13 | 这些测试已经接入 `npm run check`，新增测试必须接进去 | `package.json:53-58`：`check:delivery-packet`、`check:delivery-deploy`、`check:delivery-rollback`、`check:delivery-cleanup`；`test/tooling/run-all-checks.test.mjs:60,62` |
| P14 | 模型请求的硬规则：固定在前、会变在后；已发内容只追加 | `.agents/instructions/prompt-prefix.md:27-28`：`固定的在前，会变的在后...每轮都会变的内容只放在最后一条用户消息里`；`:36`：`已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加` |
| P15 | I-73 的教训：每个新值都要查产生处和所有使用处，不能只看改动 | `docs/incidents-and-gates.md:112`：`双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」` |
| P16 | 现有反向用例把“非空 qualification 保留”和“残留路径拒绝”当作预期 | `test_release_cleanup.py:364-370`：`test_directory_with_content_stays_for_the_preflight_to_report`；`test_deploy.py:101-102`：`test_leftover_target_path_is_refused` |

---

## 二、方案本身

### A. 目标 3：让残留路径自己消失，且不删证据

1. **统一“本次部署占用哪些路径”**
   - 新增一个共享函数（放在 `release-cleanup.py` 或独立 `delivery-paths.py`），返回与 `deploy-preflight.py:99-101` 完全相同的集合：`newPrefix`、`newOperations`、`evidenceRoot`、`transportRoot` 的父目录、`newQualificationEvidenceRoot`。
   - `deploy-preflight.py` 改为调用它；`release-cleanup.py` 的 plan 里增加 `targetPaths`，远端清理直接使用这一份。
   - 加一条测试：`preflight.target_paths(binding) == cleanup.target_paths(binding)`。这是直接针对“两份清单分开写”的根因。

2. **远端清理增加“目标路径最终清扫”**
   - 在现有规则跑完后，遍历 `targetPaths`；对仍存在且不是下列情况的路径执行 `move_aside`：
     - 正在服务的 `prefix`、`operations`、`stage`、`evidence`、`qualification`；
     - 回退目标 `oldPrefix`；
     - 单元文件、`config.json`、数据库或任何进程正在引用；
     - 符号链接或无法安全判断类型的路径（保留并报告）。
   - `move_aside` 优先用 `rename`：
     - 同一文件系统：移到 `archiveRoot/<类别>/<stamp>-<basename>`（`archiveRoot` 已经是 `/var/lib/himawari/release-cleanup`，见 `release-cleanup.py:34`）。
     - 跨文件系统（例如 `/opt` → `/var/lib`）：原地改名为 `<path>.attempt-failed-<stamp>`，不复制、不删除。
   - 这样 `TARGET_PATH_ABSENT` 能通过，证据仍在。**不再对非空 qualification 只 `keep`**；这是对 I-56 原有决定的修改，需要 Andy 明确同意（见第五节）。
   - 对服务中那一版的 qualification 要显式保留：从 `current['operations']` 的 basename 推出 `<evidenceParent>/qualification/<basename>`，不要把它当成普通残留移走。

3. **清理失败不再被预检掩盖**
   - `deploy.sh` 的预检前清理改为检查返回值：失败就输出 `DEPLOY_CLEANUP_FAILED_BEFORE_PREFLIGHT` 并停止，不再继续到预检后才看到 `TARGET_PATH_ABSENT`。
   - 新增测试：假 `release-cleanup.py` 返回非零时，`deploy.sh` 在 `S1_TRANSPORT` 之前停止，生产机不被改动。

4. **停服后 `keep` 失败的“下一次重试”**
   - 不改失败当时的 `keep` 行为。只在**下一次显式运行** `deploy.sh` 时增加 `--retry`：
     - 先用只读探测读 systemd 单元；如果服务不是 active，且单元指向本包的 `newPrefix`/`newOperations`，说明上一次已经切到新版但没起来；
     - 运行 `bash rollback.sh "$packet"` 恢复旧版（rollback 不删除失败版本，现场仍在），然后再走清理、预检；
     - 如果 rollback 失败，停止并保留现场。
   - 默认不加 `--retry`，避免改变 Andy 选择的行为；是否把 `--retry` 设为默认，由他拍板。

### B. 目标 1：依赖不变时不重传 node_modules 和 python

核心原则：**包和 freeze-manifest 一个字节都不改**，只改传输时“跳过哪些成员”。

1. **新增一次只读的“复用计划”SSH 调用**（在 `S1_TRANSPORT` 之前）
   - 客户端把本地已冻结的 `freeze-manifest.json` 通过 stdin 发给生产机；远端校验 `sha256(manifest) == expected_freeze`，并复用现有的 manifest 结构校验规则（`transport-packet.py:67-70`）。
   - 复用来源：本次绑定里的 `service.pairSupervisor` 指向旧 operations；由它推出旧 stage：`/var/tmp/himawari-<旧label>-<旧compact>/packet`。这个 packet 正是 `release-cleanup-remote.py:219-225` 会保留下来的“服务中那一版的 rollback packet”。
   - 对 manifest 中每个成员，若旧 packet 里同相对路径的文件满足：普通文件、root 所有、`nlink == 1`、不可组/他人写、`size == manifest.bytes`、`sha256 == manifest.sha256`，就列入 `reuse`。
   - 输出一行确定性的 JSON：`TRANSPORT_PLAN {"reuse":[按路径排序的成员]}`。
   - 取不到旧 packet、计划调用失败、JSON 不合法，都**退回全量发送**，不报错阻断上线。

2. **传输命令带上计划**
   - `run-local-step.py` 的 `stream_packet` 跳过 `reuse` 中的成员；仍按 `['freeze-manifest.json', *sorted(members)]` 的顺序，manifest 永远第一个。
   - 远端 `production_main` 接受一个可选的 `--reuse <base64-json>` 参数；对其中每个路径重新做 `safe_relative` + “必须在 manifest 成员里”校验，绝不把计划里的路径直接当文件系统路径用。
   - **服务端不信任计划**：对计划里的每个成员，重新打开旧 packet 的文件、边复制边哈希、复制后再核对 `bytes/sha256`；任何不符就失败（`MEMBERS_INCOMPLETE` 或专门的 `REUSE_MEMBER_CHANGED`），不回退到“相信旧文件”。
   - 复制到目标后，仍执行 `verify_frozen(target)`（`transport-packet.py:88`），逐文件重新哈希整个包。复用只是少读网络，安全语义不变。

3. **为什么不改成硬链接**
   - `packet-common.py:41` 要求 `nlink == 1`；硬链接会让后续所有 `verify_frozen` 失败。用复制，接受服务端本地多一次 316 MB 的磁盘读，换掉 250 秒网络时间，仍然划算。

4. **预期效果**
   - `node_modules.tar.gz` 282 MB + python 34 MB 命中时不再走网络，剩约 97 MB（candidate 76 MB + 两个 JSON 16.5 MB + 源码 bundle 0.14 MB + 脚本）。
   - 上传从 272–365 秒降到约 65–90 秒（按 1.1–1.5 MB/s）。
   - 同一包重试时，candidate 也可能命中（如果旧 packet 还在），剩余约 20 MB，上传约 15–20 秒。
   - 安装 142–176 秒不变；S6 337–380 秒不变。

5. **必要的确定性验证**
   - `collect-installer-dependencies.mjs:88` 的 tar 参数看起来固定，但 gzip 头是否逐次相同**未核实**。加一条测试：同一依赖树连续生成两次 `node-modules.tar.gz`，断言 SHA-256 相同。若不同，先加 `gzip -n` 或改用 `--use-compress-program='gzip -n'`；仍不稳定就退回“按 `node-modules.json` 逐文件复用”，不要假装命中。
   - 在 deploy 日志里记录 `reuse` 字节数、成员数、计划耗时；下一次上线就能看到真实命中率，而不是靠估算。

### C. 目标 2：生产机拉包是否值得

**结论：现在不值得作为第一步；瓶颈在 Mac 的上行，不在生产机的下行。**

| 测量 | 数值 | 含义 |
|---|---|---|
| Mac → 生产机 | 413 MB / 272–365 s ≈ 1.1–1.5 MB/s | 当前实际上传吞吐 |
| 生产机从公网下载 | 13.8 MB/s | 目的端能吸收约 10 倍 |
| Mac 从公网下载 | 3.8 MB/s | Mac 的家宽下行也远高于其上行 |
| Hermes → Mac | 9.4 MB/s（局域网） | 只能证明局域网，不证明 Hermes 公网上行 |

- 如果“生产机拉”的来源是 Mac：只是把 TCP 方向反过来，物理上行还是 Mac 的 1.1–1.5 MB/s，**没有收益**。
- 如果来源是 Hermes：可能有用，但必须先测 **Hermes → 生产机** 的公网吞吐。9.4 MB/s 是 Hermes→Mac 的局域网数字，不能外推。未核实。
- 如果来源是公共对象存储/CDN：生产机 13.8 MB/s 能受益，但把包放上去仍要经过 Mac 或 Hermes 的上行；除非 Hermes 能直接上传且上行很快。涉及额外托管、凭据和费用，按约束要先问 Andy。
- 做完 B 的复用后只剩约 97 MB，按 1.4 MB/s 约 70 秒；此时再改拉/推方向，最多再省几十秒，优先级低于 S6（337–380 秒）和出包（约 8.6 分钟）。

### D. 其他建议

- **不要新增常驻服务**：复用计划是一次性 SSH 命令，不引入守护进程。
- **不要改 packet/manifest 的序列化格式**：现有多个校验器要求精确键集合（`transport-packet.py:67,70`、`packet-common.py:70`、`S1-publish-and-install.py:25`），加字段会连带破坏 freeze/审批。复用只读 manifest。
- **可选的小优化**：传输的 tar 流目前不压缩，`node-modules.json` 8.5 MB 和 `source-build-inputs.json` 8 MB 是明文 JSON；对 S1_TRANSPORT 开 SSH 压缩或 gzip 流可能再省 10–15 秒。收益小，先测量再决定。
- **后续再考虑逐文件复用**：如果以后 `package-lock.json` 频繁变化，才值得按 `node-modules.json` 的条目做文件级复用；当前 10-29 到 11-15 只变 1 次，整包复用足够。

---

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
|---|---|
| 把 `onDeployFailure` 改成自动回滚 | 直接违反 Andy 的明确选择（P12）。失败当时仍 `keep`；只在下一次显式 `--retry` 时恢复。 |
| 生产机从 Mac 拉包 | 物理上行不变，没有收益（见 C）。 |
| 生产机从 Hermes 拉包 | 可能有大收益，但 Hermes→生产机吞吐未测；且要把 Hermes 变成第二个可信来源、保留材料、处理访问凭据。作为测量后的第二阶段。 |
| 用 `rsync --copy-dest` 对整个包做差量 | rsync 会按文件跳过相同内容，但会把逐成员校验从现有 receiver 换成 rsync 的不透明协议，仍要最终全量校验；测试和故障定位更复杂。现有 tar receiver 已经能精确控制顺序、哈希和目录排他性。 |
| 硬链接复用 | 违反 `nlink == 1` 的读取前提（P6）。 |
| 在 freeze-manifest 或 p5-materials 里加 `reuse` 字段 | 多处校验器要求精确键集合；会改变 freeze SHA、审批引用和包字节。 |
| 删除非空 qualification 目录 | 违反“优先移到一边保留”；改为移动。 |
| 新增常驻缓存服务 | 违反“不新增常驻服务”；直接复用服务中 packet 即可。 |
| 只做压缩（zstd/gzip） | 对 413 MB 里已压缩的材料无效，收益远小于复用。 |
| 现在就把 S6 并行化 | S6 是剩余最大固定成本，但涉及生产机资源竞争和验收语义，需单独方案。 |

---

## 四、风险和反例

1. **旧 packet 不在或已损坏**：复用计划退回空集，全量发送，正确但慢。反例测试：删掉旧 packet 的 `node-modules.tar.gz`，传输仍成功。
2. **计划与传输之间旧文件被清理/替换**：receive 重新校验失败，`MEMBERS_INCOMPLETE` 或哈希错误，安全失败；重跑一次即可。不要为了“能过”而放宽校验。
3. **`node-modules.tar.gz` 逐次字节不稳定**：复用永远不命中，速度回到现状。先用两次构建同 SHA 测试确认；不稳定就显式 `gzip -n`，或改成逐文件复用。
4. **非空 qualification 被移走后，原目录权限/属主丢失**：移动保留 inode 和权限；但目标父目录必须以 root 身份操作，移动后要做一次 `lstat` 回报。测试断言内容仍在归档、目标路径不存在。
5. **被数据库/配置/进程引用的旧 release 被移走**：必须先判 `in_use` 并保留；此时预检仍会失败，这是正确的“不能自动处理”的情况，需人判断。
6. **移走的失败 release 占磁盘**：只对“本次目标路径”移走，并沿用现有 `keepFailedAcceptance` 一类保留上限；空间预检会在此之前拦住。
7. **清理失败仍然继续**：如果保留现有 `|| echo` 行为，预检失败信息会误导。方案 A3 改为停止；测试要覆盖。
8. **复用路径穿越**：计划里的路径必须来自 manifest 且 `safe_relative`；服务端只接受 manifest 成员。反例测试：把 `../escape` 放进计划，必须被忽略或拒绝。

---

## 五、需要人拍板的取舍

1. **非空 qualification 改成“移到一边”**：这会修改 I-56 当时“有内容则保留并标 `qualification-not-empty`”的决定。建议改成移动，否则同名路径永远过不了预检。需要 Andy 同意。
2. **是否把 `--retry` 设为默认**：默认 `--retry` 更省事，但会在下一次 deploy 开始时自动跑 rollback；默认关闭则仍要人多打一个参数。建议先默认关闭，观察一次。
3. **失败现场保留多久**：移到 `release-cleanup` 或原地 `.attempt-failed` 后，是下一次清理删除，还是保留 N 次？建议沿用现有 `keepFailedAcceptance` 的保留数，不新增常量。
4. **是否保留失败 attempt 的 packet 材料以便重试复用 candidate**：保留约多占 1 GB，但同一包重试可再省 76 MB 上传。建议第一阶段不做，只复用服务中 packet。
5. **是否在测到 Hermes→生产机足够快后做“生产机拉包”**：需要先测量，且涉及第二个可信来源和 Hermes 材料保留；不先做。
6. **是否并行化 S6**：如果 Andy 的第一目标是总时长，S6 比传输更值得下一步投入，但安全影响更大，需另出方案。
7. **是否把预检前清理失败改为致命错误**：会改变现有“清理失败不改变上线结果”的语义（ADR 0120），但能消除误导性预检失败。建议改。

---

## 六、读代码/来源证实的，与推测/未核实的

**已证实（代码或材料）：**
- 传输当前是全量、逐成员校验、最后全量校验（P5、P7、P8）。
- 清理对非空 qualification 只保留，这是同名路径反复失败的机制（P3）。
- 预检目标路径与清理规则是两份代码，且清理失败被忽略（P1、P2）。
- `onDeployFailure: keep` 是 Andy 的明确选择（P12）。
- node_modules 解压和 S1 都会再次核对材料，安全模型是“每一层都重算哈希”（P7、P8）。
- 源码 bundle 已经采用“服务端缓存 + 使用时校验”的模式（P11）。
- 模型请求规则与本方案无关；本方案不触碰请求组装（P14）。

**推测或未核实：**
- `node-modules.tar.gz` 在相同依赖树下是否逐字节稳定：tar 参数看起来固定，但 gzip 头未验证；必须用两次构建同 SHA 的测试确认。
- Hermes → 生产机的真实公网吞吐：未测，不能从 Hermes→Mac 9.4 MB/s 外推。
- 11-15 三次残留的具体清理日志不在仓库里；只能从现有代码确认“非空 qualification 会被 keep”，无法逐条复现当时是哪条规则先失败。**未核实。**
- 复用命中率：`package-lock.json` 期间只变 1 次，推测命中率很高，但要靠 deploy 日志统计确认。
- 移走失败 release 后的长期磁盘占用：取决于保留策略，未实测。
- S6 能否安全并行化：未读透 `run-cloud-acceptance.sh` 的并发假设，**未核实**。

---

## 七、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 本方案只改 `scripts/delivery-mode/**`、测试和文档，不碰 `packages/runtime-pi`、`packages/prompt-catalog`、`apps/agent-service` 的请求组装、历史存储和遮盖。对于同一个 commit，生产机最终安装的文件仍由同一份 freeze-manifest 逐字节校验，delta 只改变“这些字节怎么到生产机”，不改变“到的是哪些字节”。

依据 `.agents/instructions/prompt-prefix.md:27-28`：`固定的在前，会变的在后`、`每轮都会变的内容只放在最后一条用户消息里`；`:36`：`已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加`。本方案没有向系统提示、工具定义、历史或最后一条用户消息加入任何新值。现有的 `npm run check:prompt-prefix`（`package.json:65`）仍会拦住误改请求组装的情况。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 模型可见的系统提示、工具定义、历史、遮盖结果都不经过本方案的代码。传输复用只按 SHA-256 判断：同一文件只有哈希完全相同才复用，否则重传，所以生产机上的文件字节不会因为“复用”而改变。新增的 `reuse` 列表按 manifest 路径排序；新增的 `stamp` 只出现在清理归档路径和日志里，不进 packet、manifest 或模型请求。依据 `prompt-prefix.md:53-56`（序列化顺序固定、遮盖确定）和 `prompt-prefix.md:10-11`（字节匹配、改动开头会全部重算）。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，而且要按现有门槛接入 `npm run check`（`package.json:53-58`）。

**新增/修改的检查：**
- `test_release_cleanup.py`：
  - 非空 qualification 被移到归档，目标路径不存在；归档里内容仍在。
  - 服务中 qualification / 被进程使用的目录仍保留，预检仍失败（反向）。
  - `preflight.target_paths(binding) == cleanup.target_paths(binding)`。
  - 构造一棵包含所有目标路径的树，跑一次 apply 后，所有非服务路径都消失。
- `test_deploy.py`：
  - 预检前清理返回非零时，在 `S1_TRANSPORT` 之前停止，生产机不被改动。
  - 残留路径被清理后，同一包可以直接重跑，不再需要人工移走。
- `steps/verify-steps.py`（Hermes 真机 fixture）：
  - 计划列出匹配文件时，客户端跳过，目标文件字节/mode 正确。
  - 旧 packet 文件被改一个字节 → 不列入计划；若客户端仍跳过，接收端必须失败。
  - 旧 packet 文件是符号链接、属主不对、`nlink != 1` → 不复用。
  - 客户端忽略计划、仍发送已复用成员 → 接收端按重复成员失败。
  - 计划里出现 manifest 之外的路径 → 忽略或拒绝。
  - 没有旧 packet → 全量发送仍成功。
- 确定性测试：同一依赖树两次生成 `node-modules.tar.gz`，SHA 必须相同。

**反向用例真的会失败：** 每个新增正向用例都要有对应的“去掉修复就失败”的变异验证：
- 去掉 `move_aside` 调用 → 非空 qualification 测试失败。
- 去掉复用源的哈希核对 → “改一字节不复用”测试失败。
- 让客户端无条件全量发送 → 计划跳过测试失败（上传字节数不符合预期）。
- 让接收端相信计划不重算哈希 → 篡改旧文件测试失败。
- 删除 `target_paths` 共享函数、恢复两份清单 → 一致性测试失败。

特别说明：现有 `test_release_cleanup.py:364-370` 明确断言“非空目录保留”，这是旧的安全决定；新方案必须**有意反转**这条用例，而不是悄悄删掉。反转本身要写进 ADR/事故记录，并由 Andy 同意（见第五节）。

### 4. 每个新值/修改值，产生它的地方和使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `freeze-manifest.files[].path/bytes/sha256` | `finalize-bindings.py:284-310` | `transport-packet.py:67-93`；`packet-common.py:70-91`；`S1-publish-and-install.py:27-38`；`artifact-install.mjs` 间接经 p5 | 格式、路径安全、精确键集合、逐文件字节；本方案不改格式，只读 |
| `p5-materials.json` 的 `name/bytes/sha256/sourceName` | 模板 + `make-packet.py:543-560`、`regenerate_hashes` | `S1-publish-and-install.py:85-91`；`artifact-install.mjs:18-27`；`verify-finalize-bindings.py:83,302`；`S9-clean-transport.py:26` | S1 要求 p5 哈希等于实际材料；artifact-install 再要求 `expected` 和 p5 一致；复用新增消费方必须用同一哈希，不能自己另算 |
| `freezeSha256` | 本地 `verify_frozen` / `sha(manifest)` | `transport-packet.py:101` 的 `expected_freeze`；清理的 `stale_transports`；`run-step.py` 参数 | 远端必须 `sha(manifest)==expected_freeze`；计划调用和传输调用都复用这一条 |
| `reuse` 列表 | 新增的远端计划命令 | 新增的客户端 `stream_packet` | 生产端只输出 manifest 成员；客户端再校验 `safe_relative` 和成员集合；接收端重新哈希，不信任列表内容 |
| 复用来源根路径 | 客户端从 `service.pairSupervisor` 推出旧 stage | 远端计划命令 | 必须是绝对、规范、root 所有、不可组/他人写的真实目录；文件再用 `common.read` 校验 `uid/nlink/mode` |
| `targetPaths` | 新增共享函数，输入 bindings | `deploy-preflight.py`；`release-cleanup.py` plan / remote cleanup | 两端必须完全相等；新增一致性测试；远端只接受位于已知根下的路径 |
| `newQualificationEvidenceRoot` | `bindings.draft.json:118` + `finalize-bindings.py` | `deploy-preflight.py:101`；`release-cleanup-remote.py:248-259`；`S6-limited-host-acceptance.sh:14,22-25`；`publish-signing-materials.py:12` | 清理移动后，S6 的 `test ! -e` 通过；移动前校验父目录必须是 `<evidenceParent>/qualification` |
| 归档/移走目标路径及 `stamp` | `release-cleanup-remote.py` 新增 `move_aside` | 清理报告、后续清理、人工诊断 | `stamp` 用 UTC 固定格式；目标路径只在 `archiveRoot` 或原父目录下；不得进入 `targetPaths`；同名冲突要加序号 |
| `node-modules.tar.gz` 的哈希 | `collect-installer-dependencies.mjs:88-89` | `make-packet.py:552-553`；p5 模板；`artifact-install.mjs:61`；`extract-node-modules.py:58` | 所有使用处都对比同一个 `sha256`；复用新增一处消费也必须用 manifest/p5 里的值 |
| `python-3.12.10.tar.gz` 的哈希 | `make-packet.py:49-50` | `make-packet.py:530-531`；p5 模板 | 写死常量；复用只按这个哈希命中，不会接受别的 Python 包 |
| transport 报告新增字段（如 `reusedMembers`） | `transport-packet.py` | 目前只有日志/测试；`test_release_cleanup.py:73,187` 只检查结果文件存在 | 不加入 `s1-result`、freeze-manifest 或 p5；若加，先确认没有精确键校验器 |

I-73 的教训在这里的具体落点是：`reuse` 列表和 `targetPaths` 都是“只在产生端看起来对”的典型值。方案要求**产生端、跳过端、接收端、最终校验端**都各自校验；`targetPaths` 则由预检和清理共用同一个函数，并加相等性测试。

---

**一句话取舍建议：** 先做 A（自动移走残留 + 统一路径清单）和 B（按哈希复用已有材料），这两项直接命中目标 1 和目标 3，且不改变模型请求和安全模型；“生产机拉包”先测 Hermes→生产机吞吐，再决定是否值得作为第二阶段。
