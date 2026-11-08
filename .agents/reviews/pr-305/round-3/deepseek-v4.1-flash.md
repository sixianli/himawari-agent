## 读代码证实的问题（按严重度）

### 1. 高：`cacheWrite` 会给任何目录写哨兵，随后 `pruneCache` 会删掉该目录里的无关文件

- 文件:行：`scripts/ci/verified-download.mjs:84`、`scripts/ci/verified-download.mjs:190-214`、`scripts/ci/install-tools.mjs:599-602`
- 问题：本轮把清理限制在「带 `.himawari-ci-downloads` 哨兵的目录」，但哨兵正是 `cacheWrite` 自己无条件创建的。`HIMAWARI_CI_CACHE_DIR` 只校验「绝对路径」，不校验是否是本工具的专用目录；一旦运维把它指向 `~/.cache`、共享数据目录等已有内容的目录，第一次缓存写入就创建哨兵，紧接着 `pruneCache` 会把所有既不是 64 位十六进制、也不以 `.tmp-` 开头的普通文件删掉。这是不可撤销的数据丢失，而且删除发生在正常成功路径上。
- 证据：
  - `verified-download.mjs:84`：`writeFileSync(join(directory, cacheMarkerName), "himawari download cache\n", { flag: "a" });`
  - `verified-download.mjs:190`：`lstatSync(join(directory, cacheMarkerName));`（有哨兵才继续）
  - `verified-download.mjs:208-214`：`(!temporary && !entry)` 时直接 `rmSync(path, { force: true });`
  - `install-tools.mjs:599-602`：命令行入口先算缓存目录、跑完 `installTools` 后调用 `pruneCache(cacheDirectory)`。
  - 现有用例没有覆盖真实顺序：`test/tooling/verified-download.test.mjs:317-325` 只调用 `pruneCache`，从不调用 `cacheWrite`，所以测试里没有哨兵；而 `verified-download.test.mjs:306-314` 明确期望带哨兵目录里的 `stray.txt` 被删除，说明「带哨兵就删陌生文件」是当前语义。
- 建议：最安全的做法是 `pruneCache` 只删除「64 位摘要名」和「`.tmp-*` 文件」，删除 `(!temporary && !entry)` 这一支，永不删未知名字；如果坚持清理陌生文件，则 `cacheWrite` 只在「目录是本次调用新建的」时创建哨兵（调用前用 `existsSync` 判断，且处理竞态），不要给预先存在的目录补哨兵。并补用例：预先存在的目录里放 `important.txt`，先 `cacheWrite` 再 `pruneCache`，断言文件仍在。
- 附带安全问题：`verified-download.mjs:84` 用 `flag: "a"` 写固定路径，会跟随符号链接。runner 的缓存目录对其他任务可写时，恶意任务可把 `.himawari-ci-downloads` 做成指向 `~/.bashrc` 等可写文件的符号链接，后续任务会向目标追加固定文本。建议用 `O_NOFOLLOW` 或先 `lstat` 拒绝符号链接，或干脆不写这个哨兵。

### 2. 中：`cacheRead` 摘要不符时的删除没有捕获异常，与作者「删除失败视为未命中」的说法不符

- 文件:行：`scripts/ci/verified-download.mjs:68-71`（以及 `:47-49` 未检查哨兵）
- 问题：作者说「cacheRead 删除失败视为未命中」。但只有「不是普通文件 / 超过大小上限」那一支包了 `try/catch`；摘要不符这一支是裸 `rmSync`。缓存文件只读、目录只读、文件系统错误时，`rmSync` 会抛错，`cacheRead` 不会返回 `null`，而是让整个下载失败，也不会回退到联网下载。另外 `cacheRead` 完全不检查哨兵，所以即使缓存目录不是本工具创建的，只要里面恰好有以期望摘要命名的 64 位十六进制文件且内容不符，也会被直接删除。
- 证据：
  ```
  68: if (sha256Of(bytes) !== sha256) {
  69:   rmSync(path, { force: true });
  70:   return null;
  71: }
  ```
  对比 `56-60` 那一支：
  ```
  57: try {
  58:   rmSync(path, { force: true });
  59: } catch {}
  ```
- 建议：把 `68-70` 的删除也包进 `try/catch`，失败就当未命中返回 `null`；删除前先确认目录带哨兵，或把缓存读写都限制在确认属于本工具的目录。补一个反向用例：把缓存目录 `chmod 0555`（或让删除必然失败），断言 `cacheRead` 返回 `null` 而不是抛错。

### 3. 中：`curlDownload` 把「非 ENOENT/EACCES 的所有非零退出」都当网络错误重试，非网络错误会卡满 15 分钟

- 文件:行：`scripts/model-review/gateway.mjs:239-244`
- 问题：本轮把 4xx 改成按状态码判定，这本身对；但只要 `result.status !== 0` 且解析出的状态不是 4xx，就进入 `network === true` 并重试。`curl` 的退出码 3（URL 格式错误）、1（不支持的协议）、2（初始化失败）、23（写文件失败）、26（读错误）、43（参数错误）等都不是网络抖动，却会按 10 秒到 5 分钟的间隔反复重试，累计到 15 分钟预算才失败。锁文件里的 `url` 在 `lockFromRelease` 里只检查「存在」，没有校验协议或主机，手写错误的锁会把 CI 拖住 15 分钟。
- 证据：
  ```
  239: if (result.error?.code === "ENOENT" || result.error?.code === "EACCES")
  240:   throw new Error(`GATEWAY_DOWNLOAD_FAILED ${url} (${result.error.message})`);
  241: const status = Number((result.stdout ?? "").trim().slice(-3));
  242: if (result.status === 0 && status >= 200 && status < 300) return;
  243: const network = result.status !== 0;
  244: const retryable = status >= 400 ? retryableStatus(status) : network;
  ```
- 建议：只把明确的瞬时网络退出码（如 5/6/7/18/28/35/52/56 等）视为可重试；其余非零退出立即失败。补一个 `exit: 3`（或 `exit: 1`）的用例，断言只调用一次 `spawn` 就抛错。

### 4. 低：下载响应体和缓存写入都没有大小上限（作者已承认响应体无上限）

- 文件:行：`scripts/ci/verified-download.mjs:152-156`、`scripts/ci/verified-download.mjs:79-86`
- 问题：`Buffer.from(await response.arrayBuffer())` 会先把整个响应体读进内存；`cacheWrite` 也没有 `cacheEntryMaxBytes` 检查。`cacheRead` 只在「读」时拒绝超过 512 MB 的文件，挡不住下载阶段的内存和磁盘消耗。若上游返回异常大的 200 响应，单个 CI 任务可能先吃满内存/磁盘。
- 证据：
  ```
  155: if (response.ok) {
  156:   bytes = Buffer.from(await response.arrayBuffer());
  ```
  `cacheWrite` 中只有 `writeFileSync(temporary, bytes, ...)`，没有长度上限。
- 建议：至少用 `Content-Length` 预检并在读取时累计超过上限就中止；缓存写入前也检查 `bytes.length > cacheEntryMaxBytes`。

### 5. 低：`.tmp-*` 目录会被当成「陌生条目」尝试删除，且永远删不掉，只反复报错

- 文件:行：`scripts/ci/verified-download.mjs:206-217`
- 问题：作者说「新鲜 `.tmp-*` 只计文件」。实际是：`.tmp-*` 目录使 `temporary === false`、`entry === false`，于是落入 `(!temporary && !entry)` 分支，代码对目录执行非递归 `rmSync`，抛 `EISDIR` 后被捕获并 `report`。结果不是「忽略」，而是每次清理都打一行错误；而且由于不递归，这种目录永远不会被清掉。
- 证据：
  ```
  206: const temporary = name.startsWith(".tmp-") && status.isFile();
  207: const entry = digestPattern.test(name) && status.isFile();
  208: if (
  209:   (temporary && age > temporaryMaxAgeMs) ||
  210:   (!temporary && !entry) ||
  ...
  214:   rmSync(path, { force: true });
  ```
- 建议：对目录直接 `continue`（或显式区分 `status.isDirectory()`），不要进入 `(!temporary && !entry)` 的删除分支；补 `.tmp-*` 目录的用例。

### 6. 低：作者说「quality.yml 已停用」与代码不完全一致

- 文件:行：`.github/workflows/quality.yml:1-4`、`:149`、`:187`
- 问题：`quality.yml` 不是停用状态，它仍有 `workflow_dispatch` 入口，且 `dependencies`、`node-observation` 等任务 `timeout-minutes: 15`。手动触发时，缓存未命中又遇到持续 5xx，重试预算（等待时间上限 15 分钟）可能正好吃满甚至超过该任务 15 分钟的总时限。作者在说明里把它归为「有意不处理」，但「已停用」的说法不准确。
- 证据：
  ```
  1: # schedule 尚未授权；预定 UTC 时间记录于 ci/quality-policy.json。
  3: on:
  4:   workflow_dispatch:
  ...
  149: timeout-minutes: 15
  ...
  187: timeout-minutes: 15
  ```
- 建议：把说明改为「没有定时 schedule，但仍可手动触发」；或者给这些 15 分钟任务单独传入更小的 `budgetMs`，避免重试等待吃满任务时限。

### 7. 低：直接执行的脚本（如 `quality.mjs`）不会自动拿到缓存目录

- 文件:行：`scripts/ci/quality.mjs:181`、`.github/workflows/quality.yml:43`
- 问题：`HIMAWARI_CI_CACHE_DIR` 只由 `run.mjs` 传给检查子进程、由 `install-tools.mjs` 命令行入口设置。`quality.mjs` 由工作流直接执行，直接调用 `downloadArtifact(distribution, downloads)`，没有传 `cacheDirectory`，`explicitCacheDirectory()` 此时为空，因此这次下载不会使用持久缓存（只会享受新的重试）。这不是 I-89 里 github.com 504 的主路径，但和「runner 上保留缓存」的目标有差距。
- 证据：`quality.mjs:181` 是 `const archive = await downloadArtifact(distribution, downloads);`，没有第三个参数；`quality.yml:43` 直接运行 `node scripts/ci/quality.mjs ...`。
- 建议：在这些直接入口里也调用 `runnerCacheDirectory()` 并设置环境变量，或让 `downloadArtifact` 在 `GITHUB_ACTIONS=true` 时自行回退到 `runnerCacheDirectory()`（同时保留测试显式传 `null` 的能力）。

## 说法与代码不一致

- 「cacheRead 删除失败视为未命中」：不成立，摘要不符分支的 `rmSync` 未捕获，见问题 2。
- 「清理只在带哨兵文件的目录里做」：对 `pruneCache` 成立，但哨兵由 `cacheWrite` 自己创建，所以「本工具没创建过的目录不会被清理」这个保证不成立，见问题 1。
- 「新鲜 `.tmp-*` 只计文件」：进入 entries 时只计文件是对的；但 `.tmp-*` 目录会落入陌生条目分支并被尝试删除（失败后报错），不是被安静忽略，见问题 5。
- 「quality.yml 已停用」：不准确，仍有 `workflow_dispatch` 和 15 分钟任务，见问题 6。
- 「重试预算整个进程共享」「curl 有 4xx 时按状态码判定」：与代码一致，但后者的副作用是把所有非网络非零退出也纳入重试，见问题 3。

## 推测 / 未核实

- runner 的 `HOME`（`/srv/gh-runner*/home`）是否真的不被每日清理、缓存能否跨任务保留，我没有运维权限核实，只能按 ADR 0181 的说法记录为「未核实」。
- `quality.yml` 的手动触发是否实际使用、以及 15 分钟预算是否真的会被吃满，属于从代码和超时配置推断，未实跑。
- 测试是否在 CI 的 tooling 项目里因共享 `processBudget` 或真实缓存出现顺序相关失败，我没有运行测试，未核实。
- 符号链接哨兵能被利用到多大危害（追加内容是固定短文本）属于安全推断，未做利用验证。

## 侧重检查

- 错误路径：检查了 `downloadVerified` 的 fetch 异常、非 2xx、摘要不符、缓存写入失败、缓存读取删除失败；`curlDownload` 的 4xx、5xx、Retry-After、超时、ENOENT/EACCES、其他非零退出；`pruneCache` 的删除失败。发现的问题 2、3、5。
- 不合规范或不可信输入：检查了缓存目录中的符号链接、非摘要名字、超大文件、伪造哨兵、目录冒充缓存条目，以及 `HIMAWARI_CI_CACHE_DIR` 只校验绝对路径。发现的问题 1、2。
- 安全：缓存内容每次使用前重新校验 SHA-256，符号链接在 `lstat` 阶段被拒绝，这一点没问题；但哨兵写入会跟随符号链接，且共享 runner 上任务可写缓存目录，见问题 1 附带说明。
- 资源耗尽：响应体无上限、`cacheWrite` 无上限（问题 4）；重试预算只计等待时间，不计每次请求最长 120 秒/300 秒，实际墙钟可能超过 15 分钟（问题 6）。
- 不可撤销操作：`pruneCache` 和 `cacheRead` 都会直接删除文件，且 `pruneCache` 在成功路径自动运行；问题 1、2 正属于这一类。
- 规则/文档与代码一致：核对了 `.claude/rules/prompt-prefix.md`、`docs/adr/0181`、`docs/incidents-and-gates.md` 的 I-89、`quality.yml`；发现质量工作流「已停用」的说法不准确，以及 ADR 未写清哨兵由谁创建、清理依赖它。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次改动只涉及下载/缓存和 CI 子进程环境：`scripts/model-review/gateway.mjs` 改的是 Magpie 的下载与缓存（`:222-265`、`:293-319`），没有改 `opencode-review.mjs` 的请求组装；`run.mjs:155` 只是给检查子进程增加 `HIMAWARI_CI_CACHE_DIR` 环境变量，没有新增发给模型的内容。我还检查了 `runtime-environment-block` 一侧，没有发现它会扫描 `process.env` 并把该变量写进请求。因此发给模型的内容仍只在末尾追加，没有新增每轮变化的值；`ADR 0181` 的「本次没有改动任何发给模型的内容」与代码一致。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。新增的随机/时间值（`.tmp-` 文件名里的 pid 和随机数、重试抖动、Retry-After、缓存文件 mtime）都只存在于本地缓存和重试逻辑，不进入模型请求。缓存文件以 SHA-256 命名，哨兵内容是固定字符串，没有依赖前后文的遮盖或带时间的序列化。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有检查，但不完整。`test/tooling/verified-download.test.mjs` 覆盖了缓存命中、投毒删除、超限、符号链接、非摘要名、摘要不符、Retry-After、预算、404、Magpie 的 4xx/重试、`installGateway` 命中缓存；`toolchain.test.mjs` 覆盖了重试预算和摘要不符。按代码判断：
   - 4xx 反向用例（`verified-download.test.mjs:400-410`）若恢复旧逻辑会失败，是有效的。
   - 进程共享预算用例（`:203-217`）若恢复每次调用独立预算会失败，但它只测了两个显式传入同一 `budget` 的 `downloadVerified` 调用，**没有测默认的 `processBudget`，也没有测 `curlDownload` 与 `downloadVerified` 共用同一对象**。
   - 「不删除非本工具创建的目录」用例（`:317-325`）只调用 `pruneCache`，没有先 `cacheWrite`，所以即使问题 1 存在它也会通过，属于假阳性反向用例。
   - 没有「删除失败」用例，问题 2 不会被自动发现；也没有 `.tmp-*` 目录用例，问题 5 不会被发现。

4. **改动产生或修改的每个值，每一处使用它的地方都能接受吗？**
   逐个核对如下：
   - `HIMAWARI_CI_CACHE_DIR`：产生方 `cacheEnvironment` / `install-tools` 只给绝对路径；使用方 `explicitCacheDirectory` 也要求绝对路径，两端一致。但直接执行的 `quality.mjs` 不会自动拿到它（问题 7）。
   - `cacheMarkerName`：产生方 `cacheWrite`（`:84`）；使用方 `pruneCache`（`:190`、`:205`）。两处字符串一致，但使用方把它当作「目录归本工具所有」的证明，产生方却对任何可写目录都会写它，这是典型的 I-73 式「清单/哨兵能通过校验，但来源不可信」（问题 1）。
   - `processBudget` / `budget.waitedMs`：`verified-download.mjs:19`、`:138` 与 `gateway.mjs:230` 使用同一对象，数值类型一致；但所有重试测试都显式传 `budget`，默认单例和跨工具共享没有被测试覆盖。
   - `cacheEntryMaxBytes`：只用于 `cacheRead` 的读取上限，`cacheWrite` 和下载阶段不检查，写入端和读取端的限制不对称（问题 4）。
   - `retryBudgetMs`、`cacheMaxBytes`、`cacheMaxAgeMs`、`temporaryMaxAgeMs`：与 ADR 0181 的 15 分钟、1 GB、30 天、1 天一致，未发现使用方不接受的取值。
   - 序列化格式：本次没有新增写进模型请求或持久化协议的字段；缓存内部只有文件名、固定哨兵和原始字节。
