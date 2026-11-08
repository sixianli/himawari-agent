我已掌握仓库现状，现在核对几个业界一手来源（重试策略、工具缓存先例、哈希固定的官方文档）。
# 方案：runner 本地内容寻址缓存 + 预热定时器 + 有界重试

## 一、方案依赖的前提

**读代码/来源证实的**

| # | 前提 | 来源 | 原话/要点 |
|---|------|------|-----------|
| P1 | 工具下载只有 3 次、10~20 秒间隔，504 可重试但撑不过几十分钟的故障 | `scripts/ci/install-tools.mjs:260`、`:262-264`、`:282` | `const downloadAttempts = 3;`、`10_000 + Math.random() * 10_000`、`retryable = response.status >= 500 …` |
| P2 | 下载物写进任务工作区，任务结束整目录删除；同工作区内已有“存在即验摘要复用”但复用不跨任务 | `ci.yml` 各 job「安装并核验固定工具」步骤（`--directory .ci-output/tools`）；`scripts/operations/ci-runner/job-completed.sh:12-14`；`install-tools.mjs:301-308` | `rm -rf -- "$(dirname "$GITHUB_WORKSPACE")"`；`if (existsSync(path)) { verifyDownload(...); return path; }` |
| P3 | 测试里的 HOME 被隔离到工作区内，gateway 安装目录是 `homedir()/.cache`，故每个任务都从 github.com 重新下 Magpie | `scripts/ci/run.mjs:135-139`（`isolatedEnvironment(path.join(directory, "environment"), …)`，HOME=工作区内）；`scripts/model-review/gateway.mjs:204-207`（`join(homedir(), ".cache", …)`）；`gateway-lock.json:6-11`（magpie 资产在 `github.com/yetone/magpie-releases`） | — |
| P4 | github.com 上的锁定物：python（astral-sh releases）、actionlint、gitleaks、magpie；node/npm/pyPI 不经 github.com | `ci/toolchain-lock.json:82,155,176,179`；`:16,56`（nodejs.org、registry.npmjs.org）；与「已核对的事实」一致 | — |
| P5 | gateway 安装本身已具备“先验后用 + 临时文件 rename 原子发布 + 摘要不符即删”的正确模式，值得推广 | `gateway.mjs:257-269`：`if (!existsSync(binary) \|\| sha256File(binary) !== asset.sha256)` → 写 `.download` → 验摘要 → `renameSync(partial, binary)`；反例测试 `test/tooling/review-gateway.test.mjs:497-516`（篡改下载报 `GATEWAY_INTEGRITY_MISMATCH`） | — |
| P6 | runner 服务可写路径只有 runner/home/logs，HOME 指向 `@ROOT@/home` 且不在任务后清理 | `gh-runner.service.in:19`（`Environment=HOME=@ROOT@/home`）、`:34`（`ReadWritePaths=@ROOT@/runner @ROOT@/home @ROOT@/logs`）；`clean-old.sh:21` 只删 `_work` 下 3 天没变的目录 | — |
| P7 | 摘要校验在多个层次独立重复存在，缓存命中后仍有下游兜底 | `install-tools.mjs:348-366`（`verifyInstalledTools` 每次运行重验全部下载物与锁摘要、可执行文件字节与归档一致）；`gateway.mjs:257`（启动前再验二进制） | — |
| P8 | 不允许 actions/cache；测试必须跑真 Magpie | `docs/adr/0174-no-github-cache-and-one-day-artifacts.md:63-64`：「三个工作流……都不用 `actions/cache`」；约束原文 | — |
| P9 | 新测试会进 CI：tooling 项目覆盖 `test/tooling/**`，跑在 ci-vps | `ci/policy.json:242-245` | `"include": ["test/tooling/**/*.test.ts", …]` |
| P10 | 现有摘要/重试测试基础 | `test/tooling/toolchain.test.mjs:141-163`（摘要不符、损坏的缓存下载物必须失败）、`:194-219`（503/429 重试、404 不重试） | — |
| P11 | `Himawari` 所有发布物 URL 都是公开匿名可下载（不在锁文件里出现任何带凭据地址），下载不需要 GitHub token | `ci/toolchain-lock.json`、`gateway-lock.json` 全部 URL 主机 ∈ `install-tools.mjs:18-24` 白名单 | — |

**业界一手来源（方案引用）**

- 重试应指数退避加抖动：AWS Architecture Blog《Exponential Backoff And Jitter》（Marc Brooker，AWS VP/Distinguished Engineer）：https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/ ——「it should be considered a standard approach for remote clients」。
- curl 的 `--retry` 本就把 504 视为瞬态错误并按指数退避（最长 10 分钟）、遵守 `Retry-After`：https://curl.se/docs/manpage.html `--retry` 段：「Transient error means either: a timeout, an FTP 4xx response code or an HTTP 408, 429, 500, 502, 503, 504, 522 or 524 response code.」所以 gateway 的问题只在 `--retry 2`（`gateway.mjs:210`）次数太少，方向不用换。
- “缓存内容仍按本地哈希校验”是成熟做法：pip Hash-checking Mode 对缓存命中也复验哈希（「When installing from the cache of locally built wheels in hash-checking mode, pip verifies the hashes against those of the original source distribution」）：https://pip.pypa.io/en/stable/topics/secure-installs/
- “把常用工具预置在 runner 本身”是 GitHub 官方做法：hosted runner 镜像预装全部常用工具：https://github.com/actions/runner-images （README「Included Software」「Preinstallation Policy」）。自托管等价物就是把锁定物预置进 runner 可写目录，而不是每次任务现拉。

## 二、方案本身

核心思想一句话：**摘要校验就是供应链保证的全部，所以“从哪拿到字节”不重要——把“验证过的字节”留在 runner 自己的可写目录里，任务优先用本地已验证副本，github.com 504 时任务根本不出网。**

### 1. 内容寻址的跨任务缓存（改动 install-tools.mjs 与 gateway.mjs）

缓存根目录：`HIMAWARI_TOOL_CACHE`，缺省 `join(homedir(), ".cache", "himawari-ci-toolchain")`（沿用 gateway.mjs:204-206 已有的 `.cache` 约定）。任务里运行 install-tools 的进程 HOME 是 runner 真实 HOME=`@ROOT@/home`（gh-runner.service.in:19，不被 job-completed.sh 清理），所以缺省即落在可持久化的目录。

布局与算法（把 gateway.mjs:257-269 已验证的模式推广到全部下载）：

```
<root>/artifacts/<sha256>     # 内容寻址：文件内容就是该下载物，名字即期望摘要
<root>/tmp/                   # 在途下载
```

`downloadArtifact` 改为三段：
1. 工作区副本（现行为不动，install-tools.mjs:302-305）；
2. 缓存命中：读 `artifacts/<期望sha256>`，`verifyDownload` 复验 → 命中则复制（或同设备硬链接）进工作区 `downloads/`，**不出网**；复验失败 → `rmSync` 该条目、按 miss 处理（对应 pip 缓存也复验哈希的一手做法）；
3. miss → 下载（见 §2 重试）→ `verifyDownload` → 先写 `<root>/tmp/<sha256>.<随机>`，验证通过后 `chmod 0444` + `renameSync` 到 `artifacts/<sha256>`。rename 在 POSIX 同一文件系统内原子，两个任务并发发布同一 key 时，双方字节都必然等于该摘要（否则在验证一步就抛错），后写覆盖前写无差别；读到一半被清掉的竞争表现为 ENOENT，按 miss 处理。

`installGateway`（gateway.mjs）同样改：`download` 前先查缓存条目 `asset.sha256`，命中且 `sha256File` 匹配则填入 `partial` 跳过网络；miss 时把 `curlDownload` 提为 `--retry 5 --retry-max-time 900`（curl 原生退避 + Retry-After，见前提引用），其余逻辑（0555、rename、`GATEWAY_INTEGRITY_MISMATCH`）不动。测试注入的 `download`/`pack` 不受影响，6 个真 Magpie 用例照跑真程序——只是字节来源可以是已验证的本地副本。

`run.mjs:135` 的隔离环境里追加透传：`HIMAWARI_TOOL_CACHE`（run.mjs 进程自己的 `process.env.HOME` 仍是 runner 真实 HOME，用它算出缓存根，注入隔离 env），使 `test` 检查里的 gateway 安装也能命中缓存。

### 2. 有界重试改造（install-tools.mjs:260-291）

把 `downloadAttempts` 提到 5，等待改为**指数退避 + full jitter**：`wait = random(0, min(2^attempt * 5s, 120s))`，总窗口约 4~6 分钟——覆盖瞬态抖动，不把几十分钟故障拖进 60~90 分钟任务超时（“不放宽测试超时”约束不受影响：这是下载等待，不是测试超时）。长期故障由 §3 兜底。

### 3. 预热定时器（新增 ops 脚本 + systemd 单元）

新增 `scripts/operations/ci-runner/warm-tool-cache.sh` 与 `gh-warm-cache.service.in`/`.timer.in` 模板（复用 `install-runner.sh` 的渲染流程，`User=@USER@`、`ReadWritePaths=@ROOT@/home @ROOT@/logs`，比 runner 服务更小——**不给 runner 目录写权**）：

- 每 30 分钟跑一次，`RandomizedDelaySec=10min` 错开两个 runner；
- 以 runner 用户身份、`HOME=@ROOT@/home`，对 `ci/toolchain-lock.json` 里 linux-x64 平台的全部条目（两个 node release 的 artifacts+headers、npm、python、actionlint、gitleaks、semgrep 全部 wheel）和 `gateway-lock.json` 的 magpie 资产，逐个走 §1 的“命中即触活、miss 即下载验证发布”路径；
- **不需要任何 GitHub token**：全部 URL 是公开发布物（前提 P11），满足“不把 token 放 VPS”；
- 失败只记日志退出非零，下一个周期自然重试——故障期间它反复把缓存补齐，故障一恢复即填满，之后的 CI 不受影响；
- 顺带每周期做容量核算：`du -sb` 超过上限（建议 2 GB）时按 mtime 从旧到新删除未命中条目，并往 `logs/disk.log` 追加一条（沿用 job-completed.sh:10 的行格式）。

### 4. 清理、失效与磁盘占用

- **失效是自动的**：条目 key = 锁文件里的期望摘要。锁一改，key 变，旧条目天然不再被引用，无需主动失效；`verifyInstalledTools`（install-tools.mjs:348-366）每次仍按当前锁复验，装错版本必然失败。
- **清理**：预热脚本按 mtime 删 45 天未触活的条目 + 2 GB 容量上限淘汰；`clean-old.sh` 不动（它管 `_work`，不管 home 缓存）。
- **磁盘估算（推测，非实测）**：node linux-x64 两个版本 ≈50 MB、headers ≈8 MB、npm ≈3 MB、python ≈35 MB、actionlint+gitleaks ≈10 MB、semgrep wheels ≈40 MB、magpie 单文件数十 MB——单 runner 约 200~500 MB，两个 runner 合计 < 1 GB，VPS 盘占用可忽略，且由 2 GB 硬上限兜底。

### 5. 对应的自动检查（含反向用例）

全部落在 `test/tooling/`（tooling 项目，随 CI 在 ci-vps 真跑，前提 P9）：

- `toolchain.test.mjs` 增补：
  - **反向：缓存中毒**——把错字节写进 `artifacts/<正确sha256>`，且 stub 永远返回 504 → 断言 `downloadArtifact` 抛 `下载摘要不匹配`、中毒条目被删除、**绝不返回错字节**；
  - **正向：离线命中**——正确条目在缓存、stub fetch 抛 504 → 断言成功且未联网（这正是 504 事故要保住的行为）；
  - **原子性**——并发 `Promise.all` 两次同 key 下载、以及 stub 中途失败，断言 tmp 不残留、最终字节与摘要一致；
- `review-gateway.test.mjs` 增补对称的“缓存命中不联网 / 中毒不使用”用例（现有 `GATEWAY_INTEGRITY_MISMATCH`/`GATEWAY_BINARY_CHANGED` 反例已在 ：497-516、:493-495，不改）；
- `ci-runner-scripts.test.mjs` 增补预热脚本用例：按锁解析清单、错字节的本地条目必须被拒绝重下。

## 三、考虑过但不选的做法

1. **第三方镜像做默认源**（npmmirror、Node/Python 国内镜像）：摘要校验使其技术上安全，但 `officialUrl`（install-tools.mjs:18-24,43-49）的白名单合同是“已审阅的发布源”，加镜像要重开安全审阅，且镜像与原站摘要打架时排障更难。只留作人工应急（手动把字节放进缓存，摘要校验兜底）。
2. **VPS 上架常驻反代/制品库（nginx 等）**：效果等价于 §1 缓存，但多一个要运维、要加固、要账号权限的服务；两个 runner 没必要。
3. **任务内 retry-forever 等故障过去**：几十分钟故障会吃掉任务全部超时预算，还把 GitHub 拖得更狠（无 jitter 的集群重试正是 AWS 文章批评的模式）。
4. **把二进制 vendor 进 git 仓库**：私有仓库存储/带宽、锁文件摘要双份维护，得不偿失。
5. **重做 runner 镜像预装工具**（GitHub runner-images 的自托管等价重装版）：效果同 §3 但运维重得多；预热缓存是同一效果的轻量实现。

## 四、风险与反例

- **同账号进程可写缓存目录** → 攻击者（或 bug）可投放错字节。反例：投毒条目 → 每次读取都 `verifyDownload` 复验 → 报错删除重下，永不使用（有反向用例）。这与现有信任模型一致：工作区字节本来就同一账号可写、同样靠摘要防篡改（toolchain.test.mjs:150 已有同类反例）。
- **缓存冷 + github.com 同时挂**（如新装机当天）→ 任务仍会失败。这是接受的残余风险：预热定时器把“冷”的窗口压到装机后 30 分钟内，且两个 runner 缓存独立，只影响新条目。
- **硬链接跨设备失败** → 回退为复制（约几百 MB 内的拷贝，秒级）。
- **预热与任务并发写同一 key** → rename 原子 + 字节必等（写入前已验证），无竞态产物。
- **504 期间预热也 504** → 预热失败不传染任务：任务有缓存就不出网；没缓存的任务照旧失败（诚实失败，不放宽保证）。

## 五、需要人拍板的取舍

1. 重试上限从 3 次/最长约 30 秒 → 5 次/最长约 6 分钟：每次 504 瞬态抖动都会让任务多等几分钟，可接受吗？
2. 缓存放在 `@ROOT@/home/.cache`（home 目录）还是单独申请一个 `@ROOT@/cache` 可写路径并改 service 的 `ReadWritePaths`？前者零 systemd 改动，后者语义更清晰——**建议前者起步**。
3. 2 GB / 45 天这两个清理参数要不要进配置文件而不是写死在脚本里。

## 六、读到的 vs 推测

**证实**：前提 P1–P11 全部来自上表所列文件与网址。
**推测**：① 任务里 install-tools 进程继承 runner 服务的 HOME（由 gh-runner.service.in:19 推断，未在 VPS 实测）；② §4 的磁盘体积数字（未逐一 HEAD 各发布物）；③ `ci/policy.json` 未逐步骤锁定命令行参数，改 install-tools 内部行为/加 env 不会触发 `CI_QUALITY_WORKFLOW_MISMATCH`（需跑 `npm run check:ci-policy` 验证）；④ 504 期间 `raw.githubusercontent.com` 是否同挂未测（本方案不下载 license 文件，不受影响）。

## 七、必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会，且该规则在此不适用。本改动只动了 CI 的下载与安装路径，不组装任何发给模型的请求：系统提示、工具定义、历史、遮盖结果一个字节都不碰。唯一的模型侧产物是 review-gateway 测试启动的真 Magpie 程序，其字节被三重摘要校验钉死（gateway.mjs:257/262-266 → lock sha256；install-tools.mjs:352-366；本方案缓存命中前再验一次），行为与改动前逐字节相同。也不存在“每轮会变的值”需要挪到最后的问题。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。改动引入的唯一“复用”以 sha256 为准入条件：缓存条目按期望摘要命名、每次使用前复验（对齐 pip hash-checking 对缓存也复验的一手做法），命中与未命中产出的字节必然相同；没有时间字段、没有依赖前后文的遮盖、没有无序集合，并发发布靠原子 rename 且内容必等。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
有，§5 所列全部测试位于 `test/tooling/`，随 CI tooling 项目真跑（policy.json:242-245）。关键反向用例：缓存投毒 + 断网 stub → 现实现会“信任缓存”或“静默用错字节”的任何错误实现都会让断言失败；离线命中用例则保证 504 事故不再复现。gateway 侧已有 `GATEWAY_INTEGRITY_MISMATCH`、`GATEWAY_BINARY_CHANGED` 反例（review-gateway.test.mjs:497-516、:493-495）继续生效。

**4. 改动产生/修改的每个值，两端都能接受吗？**
- `HIMAWARI_TOOL_CACHE`：产生端 run.mjs（从真实 HOME 计算）与预热脚本；消费端 install-tools.mjs、gateway.mjs。两端都只当文件路径 join/existsSync，无格式校验可冲突；缺省值与 gateway 现行 `homedir()/.cache` 约定一致（gateway.mjs:204-206）。
- 缓存条目名 `<sha256>`：产生端已被 `digest()`（install-tools.mjs:40）与 `lockFromRelease` 正则（gateway.mjs:182）强制 `/^[a-f0-9]{64}$/`，文件系统安全；消费端用它做目录名 + 验证目标，两端约束同源（同一锁文件）。这是对 I-73 教训的直接落实：不是只看 diff，而是把“摘要能被两端接受”逐端核对过。
- `--retry 5 --retry-max-time 900`（curl）与 `downloadAttempts=5`：只影响下载成功率的取值区间，无下游校验依赖重试次数。
- systemd 单元键（`RandomizedDelaySec`、`ReadWritePaths` 收窄到 home/logs）：产生端是模板渲染，消费端是 systemd 本身；比 gh-runner.service.in:34 现有值更小权限，方向一致。
- disk.log 新行：与 job-completed.sh:10 同格式，消费端是人工巡检，无机器解析方（未核实是否有别的脚本读 disk.log——grep 过 job-completed/clean-old，未见其他读取方）。
- 未改动任何锁文件条目、URL 白名单、schemaVersion，故 `installTools`/`verifyInstalledTools` 的全部现有校验（install-tools.mjs:77-246、348-448）原样生效。
