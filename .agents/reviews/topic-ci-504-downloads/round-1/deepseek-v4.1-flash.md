## 结论先说

**最合适的做法不是把重试从 3 次加到很多次，而是把“已经校验过的原始下载物”从每个任务都会被删掉的 workspace 移到每个 runner 自己可写的持久目录**，做成按摘要寻址的本地缓存：

- 命中缓存时重新计算 SHA-256/SHA-512，摘要不符就删除并重下，绝不使用；
- 只缓存下载物，不缓存解压后的工具目录；工具仍每次解压并复验 executable 字节和运行版本；
- Magpie 仍下载并启动真程序，缓存的是已验证的二进制和插件 tarball，不改变 review-gateway 的 6 个真程序用例；
- 清理按“最后使用时间 + 大小上限”做，缓存可随时整体删除，不影响供应链保证；
- 重试只作为短抖动兜底，不靠它硬扛几十分钟的 504；
- **完全冷缓存且 GitHub 仍 504 时仍会失败**，要覆盖这一点需要只读种子目录或镜像，这是需要人拍板的取舍。

---

## 一、方案依赖的前提

以下“读代码证实”的条目均来自当前提交 `2995d535`。

| # | 前提 | 来源 | 原话/依据 | 证实方式 |
|---|---|---|---|---|
| P1 | CI 工具下载到任务 workspace，任务结束整个 workspace 被删 | `.github/workflows/ci.yml:49`；`scripts/operations/ci-runner/job-completed.sh:12-14` | `run: node scripts/ci/install-tools.mjs --directory .ci-output/tools --node "$CI_NODE"`；`case "${GITHUB_WORKSPACE:-}" in "$WORK"/*/*) rm -rf -- "$(dirname "$GITHUB_WORKSPACE")" ;; esac` | 读代码证实 |
| P2 | 现有摘要复用只看同一个目录，且写入不是原子的 | `scripts/ci/install-tools.mjs:301-309` | `const path = join(directory, expected.filename); if (existsSync(path)) { verifyDownload(readFileSync(path), expected); return path; } ... writeFileSync(path, bytes, { flag: "wx" });` | 读代码证实 |
| P3 | 工具下载只重试 3 次，间隔 10~20 秒；Magpie 用 `curl --retry 2` | `scripts/ci/install-tools.mjs:260-264,282,288`；`scripts/model-review/gateway.mjs:209-218` | `const downloadAttempts = 3;`；`setTimeout(resolveWait, 10_000 + Math.random() * 10_000)`；`curl -fsSL --retry 2` | 读代码证实 |
| P4 | 真正依赖 github.com 的是 CPython、actionlint、gitleaks 和 Magpie；Node/npm/PyPI 在别的源 | `ci/toolchain-lock.json:82,155,160,175,180`；`scripts/model-review/gateway-lock.json:6` | 例如 `https://github.com/astral-sh/python-build-standalone/releases/download/...`、`https://github.com/rhysd/actionlint/releases/download/...`、`https://github.com/yetone/magpie-releases/releases/download/v0.1.3240/magpie-cli-linux-amd64` | 读代码证实 |
| P5 | 每个 runner 有独立 root，服务可写自己的 `runner/home/logs` | `scripts/operations/ci-runner/gh-runner.service.in:19,34`；`scripts/operations/ci-runner/runners.sh:9-20` | `Environment=HOME=@ROOT@/home`；`ReadWritePaths=@ROOT@/runner @ROOT@/home @ROOT@/logs`；两个 runner 分别是 `/srv/gh-runner`、`/srv/gh-runner-2` | 读代码证实 |
| P6 | 测试子进程的 `HOME` 被改成 workspace 内的目录 | `scripts/ci/run.mjs:134-139`；`scripts/ci/install-tools.mjs:312-320` | `...isolatedEnvironment(path.join(directory, "environment"), ...)`；`const home = join(directory, "home");` | 读代码证实；在 VPS 上的实际行为未实测 |
| P7 | Magpie 安装目录默认在 `homedir()/.cache` | `scripts/model-review/gateway.mjs:204-207` | `return join(homedir(), ".cache", \`himawari-magpie-${lock.magpie.version}-${digest}\`);` | 读代码证实 |
| P8 | `review-gateway` 属于 `tooling` 项目，在 `policy` 和 `coverage` 任务里跑 | `ci/policy.json:19,148,242-243`；`test/tooling/review-gateway.test.mjs:675` | `"projects": ["tooling"]`；`"include": ["test/tooling/**/*.test.ts", "test/tooling/**/*.test.mjs"]`；`const install = () => installRealGateway();` | 读代码证实 |
| P9 | 项目明确禁用 `actions/cache`，每个任务重新下载并校验 | `docs/adr/0174-no-github-cache-and-one-day-artifacts.md:63` | “每个任务从锁定的下载地址重新下载固定工具和 npm 包，并照旧校验摘要。” | 读代码证实 |
| P10 | 允许复用下载缓存，但每次必须重新解压并验证，不复用上次安装的 executable | `docs/runbooks/install-start-stop-runbook.md:352` | “CI 恢复下载缓存时，工具安装前缀只允许已有普通 `downloads`、`wheels` 目录；已有解压程序、安装记录或目录符号链接仍拒绝。每次重新核对归档摘要、解压安装并验证工具身份，不复用上次安装的 executable。” | 读代码证实 |
| P11 | 任务开始时有 16 GiB 磁盘下限 | `scripts/operations/ci-runner/job-started.sh:9,17-18` | `FLOOR=$((16 * 1024 * 1024 * 1024))`；`below the 16 GiB floor; job refused` | 读代码证实 |
| P12 | 每日清理只删 `_work` 和 `_diag`，runner 忙时跳过 | `scripts/operations/ci-runner/clean-old.sh:9-22` | `find "$RUNNER_ROOT/runner/_work" -mindepth 1 -maxdepth 1 -mtime +3 -exec rm -rf -- {} +`；`runner_has_job "$RUNNER_USER"` 后 `continue` | 读代码证实 |
| P13 | `run.mjs` 给子进程的是白名单环境，不在名单里的变量会被丢掉 | `scripts/ci/run.mjs:134-158` | `const env = { ...isolatedEnvironment(...), ...Object.fromEntries([...GITHUB_*...]), HIMAWARI_CI_PYTHON: tools.python, HIMAWARI_CI_NPM: tools.npmCli, ... }` | 读代码证实 |
| P14 | 本次改动不碰模型请求组装，但必答问题仍按只追加规则核对 | `.claude/rules/prompt-prefix.md:27-28,35-36,51-52` | “固定的在前，会变的在后”；“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”；“同样的内容，每次都要序列化成同样的字节” | 读代码证实 |
| P15 | I-73 的教训是：双模型复核只看了改动，没有逐个核对产生方和使用方的契约 | `docs/incidents-and-gates.md:112` | “双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” | 读代码证实 |

### 业界一手来源（用于选择做法）

| 来源 | 原话 | 用途 |
|---|---|---|
| [Bazel: The repository cache](https://bazel.build/run/build#the-repository-cache) | “Bazel tries to avoid fetching the same file several times... An entry is taken from the cache if Bazel knows for sure that it has a copy of the correct file, that is, if the download request has a SHA256 sum of the file specified and a file with that hash is in the cache.”；“Upon each cache hit, the modification time of the file in the cache is updated... last use... clean up the cache.” | 按摘要寻址、命中校验、用 mtime 做 LRU |
| [Bazel: Distribution files directories](https://bazel.build/run/build#deprecated-distribution-files-directories) | “you can specify additional read-only directories to look for files instead of fetching them. A file is taken from such a directory if the file name is equal to the base name of the URL and additionally the hash of the file is equal to the one specified in the download request.” | 只读种子目录的合法性 |
| [npm cache](https://docs.npmjs.com/cli/v11/commands/npm-cache) | “All data that passes through the cache is fully verified for integrity on both insertion and extraction. Cache corruption will either trigger an error, or signal to `pacote` that the data must be refetched, which it will do automatically.”；“npm will not remove data by itself: the cache will grow...” | 损坏缓存自动重取；缓存需要显式清理 |
| [Go Modules Reference: Module cache](https://go.dev/ref/mod#module-cache) | “The `go` command will only contact a proxy when it needs information not already in the cache.”；“When the `go` command downloads a module... it computes a cryptographic hash and compares it with a known value... reports a security error if a downloaded file does not have the correct hash.”；“The module cache has no maximum size, and the `go` command does not remove its contents automatically.” | 跨构建复用、每次校验、显式 GC |
| [Go: Checksum database](https://go.dev/ref/mod#checksum-database) | “It makes untrusted proxies possible since they can’t serve the wrong code without it going unnoticed.” | 镜像不可信也可用，只要摘要固定 |
| [GitLab: Caching in GitLab CI/CD](https://docs.gitlab.com/ci/caching/) | “By default, the cache is stored on the machine where GitLab Runner is installed.” | 自托管 runner 用本地缓存是成熟做法 |
| [AWS: Retry with backoff pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html) | “Operations should be idempotent when you use the retry with backoff pattern.”；示例代码把 `GatewayTimeout` 作为可重试状态 | 只对幂等 GET 重试，504 可重试，但必须有上限 |

---

## 二、方案本身

### 1. 缓存位置与键

每个 runner 独立一份，不跨 runner 共享：

```
/srv/gh-runner/home/.cache/himawari-ci/
  v1/content/sha256/<前2位>/<完整sha256>/<filename>
  v1/content/sha512/<前2位>/<完整hex>/plugin.tgz
  v1/tmp/
```

- 路径来源：优先 `HIMAWARI_CI_CACHE_DIR`；未设置时，仅在 `GITHUB_ACTIONS=true` 且 `HOME` 存在时用 `$HOME/.cache/himawari-ci`。这样 CI 里自动落到 runner 的持久 home，本地开发默认不写持久缓存。
- 缓存属于 runner 账号，目录 `0700`；拒绝符号链接，避免把读写引到别的目录。
- 键就是锁文件里的摘要，不是“文件名+版本”：
  - 工具、wheel、Magpie 二进制用 SHA-256；
  - npm 插件 tarball 用 SHA-512 的 **hex**（锁里是 `sha512-<base64>`，必须转 hex 再进路径，不能把 `/`、`+` 直接放进路径）。
- 不建缓存索引。目录本身就是索引，少一个会损坏、会与真实文件不一致的清单。

### 2. 读写协议：命中必须重新校验，写入必须原子

建议抽一个共享模块，例如 `scripts/ci/download-cache.mjs`，供 `install-tools.mjs` 和 `gateway.mjs` 使用。核心逻辑：

```text
read(expected):
  p = entryPath(expected)
  if p 是普通文件且不是符号链接:
    if 摘要(p) == expected:
      touch(p)                 // 更新 mtime，供 LRU
      return p
    log CACHE_DIGEST_MISMATCH
    rm(p)                      // 绝不使用
  return null

store(expected, bytes):
  tmp = v1/tmp/<pid>-<random>
  writeFileSync(tmp, bytes, { flag: "wx" })
  fsync(tmp)
  if 摘要(tmp) != expected: rm(tmp); throw
  rename(tmp, p)               // 同目录 rename，读者只会看到“不存在”或“完整文件”
```

`downloadArtifact` 的行为改为：

1. 先查持久缓存；
2. 命中：校验后，把文件 **复制或 reflink** 到本任务的 `downloads`/`wheels`，不建符号链接（`installTools` 和 `verifyInstalledTools` 都要求普通文件）；
3. 未命中：网络下载 → 校验 → 写入缓存 → 再复制到本任务目录；
4. 本任务目录已有文件仍按现有逻辑校验；不符则删除并重下；
5. 缓存写入失败（例如 home 只读、磁盘满）只记录 `CACHE_WRITE_FAILED`，仍用本次下载的字节继续，不因缓存故障让 CI 额外失败。

### 3. 接入 `install-tools.mjs`

- 给 `installTools()` 增加可选 `cacheDirectory`，只传给 `downloadArtifact`，不改 `installation.json` 的字段。
- CLI 增加 `--cache <dir>`，或直接读 `HIMAWARI_CI_CACHE_DIR`；二者都走同一个 `resolvePersistentCacheDirectory()`。
- `downloads`、`wheels` 仍然在本任务前缀里存在，因此 `verifyInstalledTools()` 的现有检查（`install-tools.mjs:348-369`）不用改。
- 仍然每个任务重新解压、重新校验 executable 字节和运行版本；**不缓存解压后的 node/python/actionlint/gitleaks 目录**，符合 P10。

### 4. 接入 Magpie

- 增加 `gatewayCacheDirectory()`，同样优先 `HIMAWARI_CI_CACHE_DIR`，否则保留现有 `homedir()/.cache` 行为。
- `installGateway()`：
  - 二进制：先查 `sha256` 缓存；命中则校验后复制到安装前缀；未命中则 `curl` 到临时文件 → 校验 → 写缓存 → 复制到前缀；仍执行 `chmod 0555` 和 `rename`。
  - 插件：先查 `sha512` 缓存中的 tarball；命中则复制到 `pack` 目录并校验 `npmIntegrity`；未命中才 `npm pack`、校验、写缓存。之后每次仍从 tarball 解压到本次安装前缀。
  - **不持久化解压后的 plugin 目录**。如果以后为了省时间要持久化，必须给插件目录写全量文件摘要清单并在每次使用前复验，否则一个任务可以改掉插件文件而 marker 不变。
- 为了测试隔离：只有当调用方没有显式传 `prefix` 时才默认使用持久缓存；显式传 `prefix` 的测试不碰真实 home。`review-gateway.test.mjs` 里的 `installRealGateway()` 在 CI 中会拿到 `run.mjs` 传下来的持久缓存。

### 5. 环境变量必须穿过 `run.mjs` 的白名单

这是最容易漏的一处：`run.mjs` 不是把 `process.env` 原样传给 vitest，而是重新拼一个 env（P13）。所以只改 `install-tools` 的 CLI 不够，`review-gateway` 测试仍会落到 workspace 的 `HOME`。

做法：

- 在 `run.mjs` 进入 `runCheck()` 前，用 **父进程** 的 `HOME` 计算缓存目录：
  - 有 `HIMAWARI_CI_CACHE_DIR` 就用它；
  - 否则 `GITHUB_ACTIONS=true` 时用 `join(process.env.HOME, ".cache", "himawari-ci")`；
  - 都没有则不启用持久缓存。
- 把这个值显式加进 `run.mjs` 的 `env` 白名单，和 `HIMAWARI_CI_PYTHON`、`HIMAWARI_CI_NPM` 放在一起。
- `quality.mjs` 同样处理；`main.yml` 的安装步骤走 CLI，也会自动使用同一默认目录。
- **不需要改 systemd 服务、不需要重启 runner、不需要 sudo。** 下一次任务自然生效；这同时满足“不杀 runner 进程”。

### 6. 清理、失效与磁盘占用

**失效：**

- 锁文件里的摘要变了 → 新摘要 → 新缓存路径；旧条目自然不再命中，由 LRU 清理。
- 缓存条目摘要不符 → 立即删除，重新下载；下载仍不符 → 失败。绝不返回旧字节。
- 整个缓存目录是纯缓存，任何时刻 `rm -rf "$HIMAWARI_CI_CACHE_DIR"` 都安全，只影响下一次是否需要联网。

**清理：**

- 每次 `installTools()` / `installGateway()` 成功写入后调用 `prune(cache, { maxBytes, maxAgeMs, tmpMaxAgeMs, keep })`：
  - 删除 `v1/tmp` 中超过 1 天的临时文件；
  - 删除最后使用超过 30 天的条目；
  - 仍超过上限时，按 mtime 从旧到新删除，直到低于上限；
  - `keep` 放本次刚写入/命中的路径，避免刚下载就被自己删掉；
  - 不跟随符号链接。
- 命中缓存时 `utimesSync` 更新时间；这样“最后使用时间”是真实的，不依赖 `atime`（很多文件系统是 `noatime`）。
- 可选：在 `clean-old.sh` 里加一次按年龄的兜底清理（跳过正在跑任务的 runner）。但核心清理不依赖它；只要 CI 任务在跑，`install-tools` 就会执行 prune。

**磁盘：**

- 每 runner 上限建议 **2 GiB**；两个 runner 最坏 4 GiB，占 16 GiB 下限的 12.5%。
- 任务内还会复制一份到 workspace 的 `downloads`/`wheels`，任务结束随 workspace 删除；这是临时峰值，不是长期占用。
- 锁文件没有记录字节数，**实际总量未实测**；按 Node、CPython、actionlint、gitleaks、semgrep wheel 闭包和 Magpie 二进制的常见大小推测在数百 MiB 量级，所以 2 GiB 上限有足够余量。这个数字是推测，不是实测。
- 建议在 `job-completed.sh` 的 `disk.log` 里增加 `cache_bytes=`（`du -sb` 缓存目录）。现有测试只检查 `avail=`，增加字段不会破坏；如果担心外部解析，先不加，只写进 runbook 的排查命令。

### 7. 重试：只做短抖动兜底

重试不是本方案的核心。建议：

- 最多 4 次，指数退避 + full jitter（例如 5s、10s、20s，总等待不超过 60~120 秒）；
- 只对幂等 GET 重试；`408`、`429`、`503`、`504` 可重试；`404`、`401`、`403` 和摘要不符不重试；
- 有 `Retry-After` 时遵守它，但受单文件总预算约束；
- 每个文件的下载预算必须小于任务剩余时间，不修改任何测试超时。

理由：AWS 的一手文档明确说重试要幂等、要有 backoff 上限；但 504 持续几十分钟时，靠重试只会把任务拖长，不能保证成功。缓存才是主修复。

### 8. 冷启动兜底（需要人拍板）

持久缓存只能保证“以前成功下载过的文件，在 504 时不再需要 GitHub”。如果部署后缓存仍是空的，或者某个新锁文件第一次下载时 GitHub 正好 504，仍会失败。

两个可选兜底：

1. **只读种子目录（推荐，离线、无新服务）**：例如 `/srv/ci-artifacts` 或每个 runner home 下的只读目录。查找顺序：本地缓存 → 只读种子 → 网络。种子里的文件名和摘要必须与锁一致；命中后复制到本地缓存，后续从本地缓存取。种子由人工/root 从一台能访问 GitHub 的机器放入，VPS 不放 token。Bazel 的 `--distdir` 就是这种成熟做法。
2. **镜像 URL**：锁里增加一个受审阅的备用地址，主地址 504 时尝试镜像，最终仍用锁里的 SHA-256/SHA-512 校验。Go 文档明确说“不可信代理”在摘要固定时也可用。需要托管和费用，和“省钱”目标要权衡。

上线当次还需要**一次性预热**：在 GitHub 仍可用时，在每个 runner 上跑一次工具安装，或从已有 `.ci-output/tools/downloads` / 开发机把同摘要文件放进缓存/种子。否则修复上线后的第一次运行仍是冷缓存。

---

## 三、考虑过但不选的做法

| 做法 | 不选的原因 |
|---|---|
| 只把 `downloadAttempts` 加到很多次、等待更久 | 504 持续几十分钟时仍会失败，还会拉长每个任务；AWS 文档也要求重试有上限。不能解决“每个任务都重新下载”的根因。 |
| 用 `actions/cache` | 明确被 ADR 0174 和本次约束禁止；会重新产生 GitHub 存储/费用。 |
| 继续把缓存放在 workspace / `.ci-output` | `job-completed.sh` 会删掉整个工作区（P1），再重跑仍是冷缓存。 |
| 用符号链接或 bind mount 把 workspace 的 `downloads` 指向共享缓存 | `installTools` 明确拒绝符号链接；bind mount 需要 root，且破坏 runner 之间的隔离。 |
| 直接复用持久目录里已解压的工具 | 违反 runbook P10；解压后的 executable 可被任务修改，摘要保证会失效。 |
| 把工具预装进系统路径 | 版本不再由锁文件决定，破坏“固定版本、摘要不符不使用”的供应链保证。 |
| 用假 Magpie / mock 二进制 | 明确禁止；review-gateway 必须启动真程序。 |
| 改走 GitHub API asset 端点或第三方 `ghproxy` | 仍然依赖 GitHub 生态；匿名 API 有速率限制，第三方代理可用性和信任都更差。摘要能防篡改，但不能解决“代理本身也挂了”。 |
| 把二进制 vendor 进仓库 | 仓库体积和更新成本大；仍需解决多平台、多版本。 |
| 只做一台机器上的中央共享缓存 | 两个 runner 互相看不到，且没有共享写目录；需要 root/网络服务，改动大。 |
| 无上限缓存 | 会和 16 GiB 磁盘下限冲突；npm/Go/Bazel 文档都说明缓存不会自动清理，必须显式 GC。 |

---

## 四、风险与反例

1. **冷缓存仍会因 504 失败。** 这是本方案最大的残余风险。缓解：只读种子/镜像、上线时预热。不能声称只靠本地缓存就能覆盖“从未下载过”的文件。
2. **两个 runner 各有一份缓存，不能互相兜底。** 某台 runner 刚重装或缓存被清空时，它仍是冷的。需要种子/镜像，或接受该 runner 暂时失败。
3. **缓存可被任务删除或塞满。** 任务账号能写自己的缓存，恶意 PR 可以删条目或写垃圾；摘要校验保证不能用错误字节，prune 和上限限制磁盘 DoS。删除只会导致重下，不会降低供应链保证。
4. **原子写仍可能留下临时文件。** 用唯一临时文件名 + `rename`，临时文件超过 1 天由 prune 删除；最终路径只会出现完整文件。
5. **缓存命中后的复制成本。** 用 copy/reflink；不要用硬链接，因为硬链接会让任务对 workspace 文件的修改同时改到缓存 inode。copy 多占一份临时磁盘，但任务结束就释放。
6. **Magpie 插件树如果持久化会被篡改。** 方案选择只缓存 tarball，每次重新解压；如果为了性能改成持久化解压目录，必须增加全量文件摘要清单和每次复验。
7. **`run.mjs` 漏传环境变量。** 这是最容易让“缓存看起来实现了、实际 review-gateway 还在重新下载”的反例；必须用测试锁住。
8. **测试污染真实缓存。** `installTools()` 库函数不应默认启用持久缓存；只有 CLI 和 `run.mjs` 显式传。测试用临时目录。否则 CI 里的单元测试会读写 runner 真实 home，既污染缓存又掩盖问题。
9. **清理与运行中的任务竞争。** 如果在任务运行中按年龄删缓存，可能删掉正在读取的文件。核心 prune 在任务内执行，且 `keep` 当前条目；若加每日清理，必须沿用 `runner_has_job` 跳过忙碌 runner。
10. **只读种子过期。** 种子不是事实来源，摘要不符就拒绝；种子缺文件时回退网络。它只能提高可用性，不能降低校验。
11. **GitHub Actions 自身下载 action 的路径未核实。** 本次材料只说明 release 下载 504；如果 action tarball 也走同一个故障面，runner 自己的 `_actions` 缓存会帮忙，但本方案未覆盖。标为未核实。
12. **重试预算与任务超时。** 如果单个文件重试等待过长，可能挤占测试时间；方案把重试限制在 60~120 秒，且不超过任务剩余预算。

---

## 五、需要人拍板的取舍

1. **缓存上限和保留时间**：建议每 runner 2 GiB、30 天；是否接受，或改成 1 GiB / 14 天。
2. **是否增加只读种子/镜像**：如果目标是“即使从未下载过、GitHub 又 504，CI 也不失败”，必须做；只做本地缓存做不到。种子需要人工/root 维护，镜像需要托管费用。
3. **Magpie 是否只缓存下载物**：建议只缓存二进制和插件 tarball，每次解压；如果更看重测试速度，才考虑持久化解压目录，但必须加全量摘要复验。
4. **重试预算**：建议最多 4 次、总等待 60~120 秒；也可以保持现状 3 次，因为主修复是缓存。
5. **是否在 `disk.log` 增加 `cache_bytes`**：便于观察磁盘，但会改日志格式；建议加，当前测试不依赖精确字段。
6. **是否上线当次做一次性预热**：如果 GitHub 仍在 504，需要从开发机/已有缓存把同摘要文件放进种子或 runner 缓存；否则要等 GitHub 恢复后第一次成功运行才能变热。

---

## 六、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本方案只改 CI 的下载缓存、文件系统路径、环境变量和缓存清理，不修改系统提示、工具定义、历史消息、资料块或遮盖逻辑。发给模型的内容仍然只在末尾追加；每轮会变的值仍然只在最后一条消息里。依据是 `.claude/rules/prompt-prefix.md:27-28`：

> “固定的在前，会变的在后。顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。”
>
> “每轮都会变的内容只放在最后一条用户消息里。”

以及 `:35`：

> “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

具体到 Magpie：缓存路径只影响二进制/插件从哪里读取，不进入 `messages` 或 `tools`。`review-gateway.test.mjs:384-427` 的透传用例仍然逐字节比较用户消息和工具定义；本改动不触碰这些字段。新增的 `HIMAWARI_CI_CACHE_DIR` 只是 test/tooling 进程的环境变量，不会出现在模型请求里。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 缓存键使用锁文件里的固定摘要，不使用时间、随机数、主机名或无序集合：

- 工具/wheel/Magpie 二进制：锁里的 SHA-256；
- 插件 tarball：锁里的 SHA-512（转成 hex 作为路径，比较时仍用原始 `sha512-<base64>`）；
- 临时文件名里的随机数只用于写临时文件，不会成为最终缓存路径，也不会进入任何模型内容；
- mtime 只用于文件系统 LRU，不参与摘要或键。

需要特别保持 `gateway.mjs` 的 `gatewayInstallDir()` 稳定：它现在用 `JSON.stringify(lock)` 的 SHA-256 前 12 位（`gateway.mjs:204-207`）。如果改成哈希锁文件原始字节，反而更稳定；不要改成依赖对象遍历顺序或 `Date.now()`。本方案建议保持或改成“锁文件字节的 SHA-256”，并在测试里固定同一锁文件的路径。

`.claude/rules/prompt-prefix.md:51` 要求：

> “同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序...都要固定，不能依赖对象遍历顺序或数据库返回顺序。”

本方案不新增任何进入模型请求的序列化值。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有。现有检查继续保留：

- `test/tooling/toolchain.test.mjs:141-163`：摘要不符必须失败；损坏的本地缓存下载物必须失败；
- `test/tooling/toolchain.test.mjs:165-226`：连接中断/503/429 重试、404 不重试、摘要不符不重试；
- `test/tooling/toolchain-lifecycle.test.mjs:312-322`：只复用下载缓存，仍重新安装并独立校验；
- `review-gateway.test.mjs:457-529`：Magpie 二进制和插件摘要不符必须失败、二进制被替换能被 `binaryProblem` 发现；
- `test/tooling/ci-runner-scripts.test.mjs:689-700`：clean-old 在 `pgrep` 失败时不得清理。

需要新增的自动检查（建议都放进 `tooling` 项目）：

1. **持久缓存命中不联网**：第一次用 mock `fetch` 下载并写缓存；清空任务目录后第二次用“任何 URL 都抛错”的 `fetch` 安装，必须成功。旧代码没有持久缓存，这个用例会红。
2. **损坏缓存不使用**：在缓存路径写错误字节，mock `fetch` 返回正确字节，必须得到正确字节并修复缓存；再让 `fetch` 失败，必须拒绝，且错误里包含摘要不符。去掉摘要比较时这个用例必须红。
3. **同文件名不同摘要不串用**：两个 artifact 文件名相同、摘要不同，分别安装；各自必须拿到自己的字节。
4. **原子写**：注入写入失败或预先留下 `.tmp-*`，最终路径不得出现半文件；下一次运行必须能恢复。
5. **LRU/上限**：造几个旧 mtime 的缓存文件，调用 prune，超过 30 天和超过上限的必须删除；反向：去掉 prune 后旧文件必须还在。
6. **环境变量传递**：`run.mjs` 构造的 test env 必须包含指向 runner home 的 `HIMAWARI_CI_CACHE_DIR`，且不等于 workspace；旧代码会丢掉它，测试必须红。
7. **Magpie 持久缓存**：第二次 `installGateway()` 在下载函数抛错时必须成功；篡改缓存二进制/插件 tarball 时必须触发重新下载或失败，绝不能安装坏文件。
8. **重试预算**：504 后成功、连续 504 到预算耗尽必须停、`Retry-After` 被遵守、404 和摘要不符不重试；旧代码没有总预算，相关用例应红。
9. **清理脚本**：旧缓存文件按年龄删除；正在跑任务的 runner 不得清理；旧 `clean-old.sh` 不碰缓存，相关用例应红。

验证“反向用例真的会失败”的方法：先只在当前 HEAD 上加测试和 mock，不改实现，跑 `vitest --project tooling`，确认上述 1、6、7、9 等用例失败；再逐步实现。如果反向用例在旧代码上直接通过，说明它没有真正测到持久缓存或校验路径。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

按 I-73 的教训，逐个核对产生方和使用方：

| 值 | 产生处 | 使用处 | 两端校验/结论 |
|---|---|---|---|
| `HIMAWARI_CI_CACHE_DIR` | `download-cache.mjs` 的 `resolvePersistentCacheDirectory()`；`run.mjs`/`quality.mjs` 显式写入 test env；CLI 可 `--cache` 覆盖 | `install-tools.mjs` 的 `installTools()`/`downloadArtifact`；`gateway.mjs` 的 `gatewayCacheDirectory()`/`installGateway()`；prune | 必须传绝对路径、目录可建、拒绝符号链接；`run.mjs` 的白名单必须包含它，否则 review-gateway 仍在 workspace 下载。两端用同一个 helper，测试锁定路径。 |
| 缓存键 SHA-256 | 锁文件 `artifact.sha256`、wheel `sha256`、Magpie `asset.sha256` | 缓存路径、`verifyDownload`、`prune` | 现有 `digest()`/`artifact()` 已要求 64 位小写 hex；路径只用 hex，无 `/`、`..`。 |
| 插件缓存键 SHA-512 | `gateway-lock.json` 的 `plugin.integrity`（`sha512-<base64>`） | 路径、`npmIntegrity` 比较 | 不能把 base64 直接放路径（含 `/`、`+`）；先转 hex，再用原始 `npmIntegrity` 比较。需要给锁值加 `^sha512-[A-Za-z0-9+/=]+$` 校验。 |
| 本地 `downloads` / `wheels` 文件 | 从缓存复制或网络下载 | `installTools` 解压；`verifyInstalledTools` 按现有路径读取；`pip --find-links` | 仍是普通文件、仍逐项校验摘要；不要用符号链接，否则 `installTools` 的目录检查和 `verifyInstalledTools` 都会拒绝。 |
| `installation.json` / `verification.json` | 现有代码 | `verifyInstalledTools`、`local.mjs`、`quality.mjs`、`main-confirm.mjs` | **本方案不往里加缓存路径或字段**，避免改变已有消费者；`verification.json` 里已有的 `verifiedAt` 保持原样，不进入模型内容。 |
| `gatewayInstallDir()` / 安装前缀 | `gateway.mjs:204-207` | `installGateway()` 默认 prefix；`opencode-review.mjs:2828`；测试 | 保持现有行为；本方案只加下载缓存，不改 prefix 的语义。若改为基于锁文件字节哈希，只需固定同一锁文件路径；不要让路径依赖对象遍历顺序。 |
| `GATEWAY_INSTALLED` 输出 | `gateway.mjs:790` | 人工/脚本 | 路径可能随缓存根变化，但没有机器消费者；保持一行格式即可。 |
| `disk.log` 的 `cache_bytes`（可选） | `job-completed.sh` | 人工排查；`ci-runner-scripts.test.mjs:105` 只检查 `avail=` | 额外字段不会破坏现有 `toContain`；如果外部有精确解析，先不加。 |
| `clean-old.sh` 的缓存路径（可选） | `runners.sh` 的 `RUNNER_ROOT` | clean-old 的 `find` | 必须用 `$RUNNER_ROOT/home/.cache/himawari-ci`，与 download-cache helper 一致；跳过忙碌 runner；不跟随符号链接。 |
| 只读种子目录（可选） | 人工/root 放置 | 下载器在本地缓存之后、网络之前读取 | 文件名和摘要必须匹配锁；不匹配就跳过；种子只读，任务不能修改。 |
| 重试参数（次数/退避/预算） | `install-tools.mjs`/`gateway.mjs` 常量 | `fetchArtifact`、`curl` 包装 | 参数只影响下载行为，不影响摘要；测试锁定 504、404、Retry-After 和预算。 |

特别提醒：`run.mjs` 现在不会继承任意 `HIMAWARI_*` 环境变量（P13）。如果只改了 CLI 而没在 `run.mjs` 里加 `HIMAWARI_CI_CACHE_DIR`，`policy`/`coverage` 里的 review-gateway 仍然会在 workspace 里重新下载 Magpie，问题只修了一半。这正是 I-73 说的“产生方和使用方一起核对”。

---

## 七、未核实与推测

- **未核实**：当前锁文件对应下载物的实际总字节数；本文按常见大小推测为数百 MiB，没有实测。
- **未核实**：VPS 上 GitHub Actions 是否严格把服务模板的 `HOME` 传给任务子进程；代码上服务设置 `HOME=@ROOT@/home`，但未在 VPS 实测。方案因此不依赖一定是 runner home：`run.mjs` 用父进程 `HOME` 计算，CLI 用 `GITHUB_ACTIONS` + `HOME`，并在测试里锁定。
- **未核实**：504 是否也影响 runner 下载 action tarball、`api.github.com` 或 `objects.githubusercontent.com`；本次材料只说明 release 文件地址 504。
- **推测**：两个 runner 在一次完整 CI 后都会各自变热；实际取决于 GitHub 如何把任务分给两个 runner，未实测。
- **推测**：30 天 + 2 GiB 足以覆盖当前锁文件和常规版本更新；没有实际访问频率数据。
- **未核实**：npm 插件 tarball 在同一版本下是否逐字节确定；方案仍在每次命中时用锁里的 `sha512` 重新校验，所以即使 tarball 变化也不会使用不符的内容。
