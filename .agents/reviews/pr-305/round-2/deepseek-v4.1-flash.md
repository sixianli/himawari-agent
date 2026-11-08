# 复核结论（fe158ee，增量 fa3708b..fe158ee）

说明：上一轮复核记录（`.agents/reviews/...`）在本仓库被 git 包装拒绝读取，下面的核对以作者说明和代码为准；我没有运行测试，只读了代码和 diff。增量里的代码改动只有 `scripts/ci/verified-download.mjs`、`scripts/ci/run.mjs`、`scripts/model-review/gateway.mjs` 和对应测试/ADR，其余是 `.agents` 记录。

## 一、读代码证实的问题

### 高：`pruneCache` 接受任意绝对路径并递归删除“不像缓存”的一切

- 文件：`scripts/ci/verified-download.mjs:28-31`、`:190-213`；`scripts/ci/install-tools.mjs:599-602`
- 问题：`HIMAWARI_CI_CACHE_DIR` 只校验“绝对路径”，随后 `pruneCache` 会把该目录下所有不匹配 64 位十六进制摘要名的条目（包括目录）以及超过 1 天的 `.tmp-*` 递归删除。若环境变量被误配成 `$HOME`、`/tmp`、`/srv/gh-runner/home` 甚至 `/`，`install-tools.mjs` 每次成功安装后都会对这些目录做不可撤销的大规模删除。该路径是第一提交（fa3708b）引入的，本轮“清理尽力而为”的改动没有缓解它。
- 证据：
  ```js
  // verified-download.mjs:28-31
  const directory = env[cacheEnvironmentKey];
  return directory && isAbsolute(directory) ? directory : null;

  // verified-download.mjs:201-207
  if ((temporary && age > temporaryMaxAgeMs) ||
      (!temporary && !entry) ||
      (entry && age > cacheMaxAgeMs)) {
    try { rmSync(path, { recursive: true, force: true }); } ...

  // install-tools.mjs:599-602
  const cacheDirectory = runnerCacheDirectory();
  if (cacheDirectory) process.env[cacheEnvironmentKey] = cacheDirectory;
  const record = await installTools(options);
  pruneCache(cacheDirectory);
  ```
- 建议：给缓存目录加哨兵文件（例如 `.himawari-ci-downloads`，由本工具首次创建），没有哨兵就拒绝清理；只删除名字匹配 `^[a-f0-9]{64}$` 或 `^\.tmp-` 的普通文件，未知条目只报告不删除，绝不对未知目录用 `recursive:true`；拒绝把 HOME、`/`、`/tmp` 这类路径当缓存目录。清理是不可逆操作，宁可少清。

### 中：15 分钟重试预算按“每个下载物”计算，累计可远超 15 分钟，可能吃满任务时限

- 文件：`scripts/ci/verified-download.mjs:126-136`、`:169`；`scripts/ci/install-tools.mjs:485-486`、`:525-529`
- 问题：`downloadVerified` 每次调用都从 `waited = 0` 开始、`budgetMs = retryBudgetMs`；`installTools` 串行下载 node、npm、python、headers、actionlint、gitleaks 以及每个 semgrep wheel，每个都可以各等 15 分钟。冷缓存遇持续 504 时总等待是 `15 分钟 × 下载物个数`，不是 ADR 写的“累计等待超过 15 分钟就失败”。`quality.yml` 的 `dependencies`、`node-observation`、`handoff` 任务 `timeout-minutes: 15`（`.github/workflows/quality.yml:149,187,273`），会被重试直接耗到超时被杀。
- 证据：
  ```js
  // verified-download.mjs:132
  budgetMs = retryBudgetMs,
  // verified-download.mjs:169
  const delay = retryable ? nextRetryDelay(attempt, waited, { retryAfterMs, random, budgetMs }) : null;
  // install-tools.mjs:485-486
  for (const [name, item] of installs)
    extractArchive(await downloadArtifact(item, downloads), join(prefix, name));
  ```
- 建议：把预算提升到 `installTools` 级别（一个进程共享一个截止时间），或至少按任务/步骤计算；同时确认 15 分钟任务里的安装步骤能在这之前干净失败。

### 中：`cacheRead` 删除超大/非普通文件失败会中断下载，违背“缓存尽力而为”

- 文件：`scripts/ci/verified-download.mjs:54-56`，调用点 `:137`
- 问题：新增的 `status.size > maxBytes` 分支里 `rmSync` 没有 try/catch。缓存目录不可写、文件被占用或属主异常时，`rmSync` 抛出会直接冒泡到 `downloadVerified` 顶部的 `cacheRead`（无 try），整个下载在联网之前就失败。缓存本应只是加速，删除失败应视为未命中。`pruneCache` 本轮已经加了 try/catch，这里没有，行为不一致。
- 证据：
  ```js
  if (!status.isFile() || status.size > maxBytes) {
    rmSync(path, { recursive: true, force: true });   // 可能抛 EACCES/EPERM/EBUSY
    return null;
  }
  ...
  const cached = cacheRead(cacheDirectory, expected.sha256);   // 无 try
  ```
- 建议：用 try/catch 包住这次 `rmSync`，失败时只 `report` 并 `return null`，不要影响下载。

### 中低：`curlDownload` 把“非零退出”一律当网络失败，导致 4xx 也可能重试满预算，和 ADR 不符

- 文件：`scripts/model-review/gateway.mjs:233-241`；ADR `docs/adr/0181-persistent-verified-download-cache-on-runners.md:57`
- 问题：`const network = result.status !== 0;` 后 `retryable = network || retryableStatus(status)`。当 curl 非零退出但已打印出 4xx 状态（如 `~/.curlrc` 带 `--fail` 导致 404 退出 22、写文件失败退出 23、读取响应体中途超时）时，404/403 也会被当网络失败重试到 15 分钟预算。ADR 明确写“404、403 和摘要不符不重试”，二者不一致。
- 证据：
  ```js
  const network = result.status !== 0;
  const retryable = network || retryableStatus(status);
  const reason = network ? `${...}${status ? ` (HTTP ${status})` : ""}` : `HTTP ${status}`;
  ```
- 建议：解析出状态码时优先按状态码判定可重试性（4xx 除 408/429 外直接失败），只有完全没有状态码时才按网络错误重试；对明确的本地错误（写文件失败 23 等）也应快速失败。

### 低：本轮清理逻辑没有自动检查

- 文件：`test/tooling/verified-download.test.mjs:258-275`、`:282-305`
- 问题：
  - “新鲜 `.tmp-*` 计入总量”和“删除失败被忽略”这两个本轮改动没有任何用例；现有 `removes stale temporary files...` 只测过期 `.tmp` 和不匹配条目，`evicts...` 只测普通条目。
  - “超过 512 MB”的用例用 `maxBytes: 5` 覆盖参数，没有验证默认常量 `cacheEntryMaxBytes`；把 512 MB 改错成 1 字节也不会失败。
  - 所谓“接线用例”只是读取源码字符串（`toContain("...cacheEnvironment(process.env)")`），不实际运行 `run.mjs`，即使把调用写进死代码也能通过，且对格式改动很脆。
- 建议：为 `pruneCache` 增加“新鲜 tmp 占满 1 GB 被清”、“rm 失败不影响其它条目”的反向用例；对默认 512 MB 常量单独断言；用真实的 `runCheck`/子进程断言 `HIMAWARI_CI_CACHE_DIR` 出现在子进程环境里，而不是只匹配源码文本。

### 低：新计入总量的新鲜 `.tmp-*` 目录永远删不掉

- 文件：`scripts/ci/verified-download.mjs:213`、`:219`
- 问题：`temporary` 条目只要不超过 1 天就无条件 `push`（不看 `isFile()`），但超量淘汰时用的是非递归 `rmSync(entry.path, { force: true })`。若出现同名目录，会抛 `EISDIR` 被捕获 `continue`，总量永远降不下来，还会继续淘汰其它合法条目。
- 建议：只把普通文件的 `.tmp-*` 计入总量，或对临时目录用递归删除。

### 低：联网响应体没有上限，缓存上限只能保护“读缓存”这一侧

- 文件：`scripts/ci/verified-download.mjs:147-151`（相关 `cacheRead` 的 lstat/read 之间也有 TOCTOU）
- 问题：`Buffer.from(await response.arrayBuffer())` 会把任意大小的响应体一次性读入内存。缓存侧新增了 512 MB 上限，但网络侧没有；服务器/CND 异常返回超大响应仍可拖垮任务。`lstat` 的大小检查与后续 `readFileSync` 之间也存在被替换的窗口。
- 建议：流式写入临时文件并边写边算摘要、超过上限即中止；或至少检查 `content-length` 并在读取时累计计数。

## 二、推测/未核实

- 上述 `cacheRead` 删除失败、目录不可写等具体情况没有在真实 runner 上复现，是按 Node `fs` 语义推断；风险成立，触发概率未验证。
- `curl` 4xx + 非零退出需要特定环境（`~/.curlrc` 配 `--fail`、写盘错误、中途超时），未在真实 runner 核实。
- “15 分钟 × 下载物个数”是算术推断；实际是否撞满任务超时取决于故障持续时间。
- 高严重度的误配删除需要有人把 `HIMAWARI_CI_CACHE_DIR` 设为绝对路径但指向非缓存目录；代码路径已证实，实际误配置未观察到。
- 本轮新增测试从代码看能通过，也未运行验证。

## 三、侧重检查

- 错误路径：`cacheRead` 删除失败会中断下载（中）；`pruneCache` 的删除失败已忽略（符合说明，但会静默掩盖问题）；`curlDownload` 的 ENOENT/EACCES 立即失败正确，非零退出重试范围过宽（中低）。
- 不合规范/不可信输入：`HIMAWARI_CI_CACHE_DIR` 任意绝对路径 → 破坏性清理（高）；`expected.sha256`、缓存文件名均有 64 位小写十六进制校验（install-tools `digest()`、gateway `lockFromRelease`），一致。
- 安全：缓存按内容摘要复验，篡改/符号链接/非摘要名不会命中；但缓存目录与工具目录共享 runner 账号，跨任务可写，靠摘要兜底，未发现新的提权路径。
- 资源耗尽：缓存读取有 512 MB 上限（好）；网络响应无上限、`.tmp` 目录不可淘汰、每下载物各 15 分钟预算（见上）。
- 不可撤销操作：`pruneCache` 是删除操作，缺少目录身份校验，是本轮最需要处理的风险。
- 规则/文档一致性：ADR 说“404、403 不重试”与 `curlDownload` 的实际分支不一致；ADR 说“累计等待超过 15 分钟”实际是每个下载物各 15 分钟；“任务整体时限不变”在 15 分钟任务上会被重试预算吃满。ADR 关于 tooling 测试共享真实缓存（`:53`）与代码一致，但共享范围比举例的 gitleaks 测试更大（toolchain-lifecycle 也会经 `installTools` 写真实缓存），属可接受的副作用。

## 四、必答问题

1. **是否改变模型已见过的请求开头？** 不会。本次 diff 只改 CI 下载/安装（`scripts/ci/*`）和 `scripts/model-review/gateway.mjs` 的 `curlDownload`/`installGateway`（下载并安装 Magpie 二进制），不涉及系统提示、工具定义、历史消息或遮盖逻辑；没有新增会进入模型请求的字段。发给模型的内容仍由原有代码只在末尾追加，每轮变化的值仍在最后一条消息里——本改动没有触碰该路径（我未重审整个请求组装链路，只核对了本改动范围，依据 `prompt-prefix.md` 的 append-only 要求）。ADR `:85` 的“本次没有改动任何发给模型的内容”与 diff 相符。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。新增的不确定值只有：缓存临时文件名里的 `pid`+`randomBytes`（`verified-download.mjs:77`，最终改名为内容摘要）、重试的 `Math.random()` 等待时长、文件 `mtime`。这些都不参与模型请求序列化；缓存最终文件名是确定性的 SHA-256。没有新增“依赖前后文的遮盖”、带时间的请求字段或无序集合。
3. **有没有对应的自动检查，反向用例真的会失败吗？** 部分有。Retry-After 0→1 秒、超大缓存条目拒绝、curl 2xx 后非零退出重试、curl 缺失立即失败都有用例，且按代码推断去掉对应修复会失败；但这些用例没有运行，只做了静态核对。缺口：清理相关改动（新鲜 tmp 计入总量、删除失败忽略）无测试；512 MB 默认常量无用例；`run.mjs` 接线只做源码字符串匹配，不验证真实行为。见上“低：本轮清理逻辑没有自动检查”。
4. **每个新值的产生端和使用端是否都接受？**
   - `HIMAWARI_CI_CACHE_DIR`：产生于 `cacheEnvironment`（`verified-download.mjs:33-36`）和 install-tools CLI（`:599-600`），消费于 `explicitCacheDirectory`（`:28-31`，被 `run.mjs:155`、`install-tools.mjs:273`、`gateway.mjs:293` 使用）；两端都要求绝对路径，产生端只返回绝对路径，一致。问题不在取值格式，而在“任意绝对路径都会被 `pruneCache` 当缓存目录清理”（高）。
   - 缓存文件名：由 `sha256Of` 产生的 64 位小写十六进制；`cacheRead`/`cacheWrite`/`pruneCache` 的 `digestPattern` 与锁校验（`install-tools.mjs:46-48`、`gateway.mjs:190`）一致。
   - 512 MB 上限：只在 `cacheRead` 默认参数使用，无其它消费端，自洽；但默认值没有测试锁住。
   - 重试预算：产生端是每调用一次的 `budgetMs`，与 ADR 的“累计 15 分钟”叙述不一致（见上）。
   - 额外观察：`run.mjs` 把缓存目录传给所有 tooling 测试后，`toolchain-lifecycle.test.mjs` 会经 `installTools→downloadArtifact` 把合成的假工件写进真实缓存（摘要随 tar mtime 每次变化，靠 30 天/LRU 清理）。ADR 已承认测试会读写真实缓存，但“写入假工件”是超出举例的副作用，虽无正确性影响，建议测试显式传 `cacheDirectory: null` 或独立临时目录。
