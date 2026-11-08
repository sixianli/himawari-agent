## 复核结论（按严重度）

下面「证据」都是当前检出提交里我亲自读到的行；标「推测」的是由代码推出、但没有实测的部分。

### 高 1 — `Retry-After: 0`（或已过去的 HTTP 日期）会让 15 分钟预算永远用不完，变成无限紧循环
- 文件: `scripts/ci/verified-download.mjs:86-92`、`104-111`、`147`、`160-166`；`scripts/model-review/gateway.mjs:240-247`
- 问题: 预算只累加“等待毫秒数”，而 `Retry-After: 0` 会算出 0 毫秒；`waited + 0 > budget` 永远为假，循环永远不会结束。ADR 0181 第 5 条“累计等待超过 15 分钟就失败”在这一点上不成立。两条下载路径都受影响。
- 证据:
```js
// verified-download.mjs
if (/^\d+$/.test(text)) return Number(text) * 1000;      // "0" -> 0
const at = Date.parse(text);
return Number.isNaN(at) ? null : Math.max(0, at - now);   // 过去时间 -> 0
...
if (retryAfterMs !== null) return Math.min(retryAfterMs, longestDelayMs); // 0
...
return waitedMs + delay > budgetMs ? null : delay;        // 0+0>budget 永假
...
if (delay === null) throw ...;                            // 0 !== null，继续循环
```
```js
// gateway.mjs
retryAfterMs: parseRetryAfter(header?.[1]),
```
- 建议: 给延迟设一个下限（例如至少 1 秒），或把预算改为按“墙钟时间/尝试次数”计算（记录循环开始时间，`Date.now() - start > budget` 即失败），并补一条 `Retry-After: 0` 与过去日期的反向用例。
- 严重度依据: “服务器真的发 0”是推测；但 0 秒和过去日期都是合法的 HTTP 输入，代理、错误时钟、时钟偏差都会产生，而代码路径是确定的。

### 中 2 — curl 已收到 2xx 但进程非零退出时，被判为“不可重试”，报错还写成 `HTTP 200`
- 文件: `scripts/model-review/gateway.mjs:233-239`
- 问题: `network` 只在“退出码非 0 且状态码为 0/空”时才为真。若 curl 先收到了 `200` 响应头、随后因超时/连接中断以非 0 退出（`--max-time 300` 触发），`status=200`、`result.status!==0`，于是 `network=false`、`retryableStatus(200)=false`，立即抛出一句自相矛盾的 `GATEWAY_DOWNLOAD_FAILED ... (HTTP 200)`，不会重试。这与“网络错误重试”的说明不一致。
- 证据:
```js
const status = Number((result.stdout ?? "").trim().slice(-3));
if (result.status === 0 && status >= 200 && status < 300) return;
const network = result.status !== 0 && !status;
const retryable = network || retryableStatus(status);
const reason = network ? (...) : `HTTP ${status}`;
```
- 建议: 以退出码判定传输失败：只要 `result.status !== 0` 就当作可重试的网络失败（把 stderr 与已读到的状态码一起写进原因），只有退出码为 0 时才用状态码判断 404/403 等不可重试。同时给 `-D -`+`-w` 的状态码解析加一个反向用例。

### 中 3 — `cacheRead` 无大小上限，先把整个文件读进内存再校验摘要
- 文件: `scripts/ci/verified-download.mjs:38-60`
- 问题: 设计前提是“缓存可被同账号任务写入，所以每次使用前必须复验”。但复验是先 `readFileSync` 整个文件、再算 SHA-256。另一个任务只要在已知摘要名下放一个巨大文件（内容无需要匹配），下一个请求该工具的任务就会在验摘要前 OOM/被拖死，网络兜底也来不及执行。也就是说“摘要不符就拒绝”的完整性保证还在，但可用性没有保住。
- 证据:
```js
status = lstatSync(path);
if (!status.isFile()) { rmSync(...); return null; }
bytes = readFileSync(path);            // 无 size 上限，整文件入内存
if (sha256Of(bytes) !== sha256) { rmSync(...); return null; }
```
- 建议: 先用 `status.size` 做上限检查（超过合理上限直接删除/不读），或用流式哈希并设最大读取量；必要时把每个下载物的大小写进锁文件做两端校验。
- 标注: “攻击者可提前放巨大文件”属于推测的利用路径；“读取前无任何大小检查”是代码事实。

### 低 4 — tooling 测试会读写真实 runner 缓存；与 ADR“免得单元测试写进真实缓存”的表述不一致
- 文件: `scripts/ci/run.mjs:155-157`；`vitest.workspace.ts:6-14`；`test/tooling/gitleaks-config.test.mjs:65-74`；`test/tooling/review-gateway.test.mjs:692`
- 问题: `run.mjs` 把真实缓存目录作为 `HIMAWARI_CI_CACHE_DIR` 传给检查子进程，而 `ci/policy.json` 的 policy 和 coverage 都会跑 `tooling` 项目。vitest 的 `toolingEnvironment` 把所有 `GITHUB_*` 清空，却没有清空 `HIMAWARI_CI_CACHE_DIR`；`explicitCacheDirectory()` 也不看 `GITHUB_ACTIONS`。因此 tooling 测试里任何没显式传 `cacheDirectory` 的 `downloadArtifact`/`installGateway` 都会命中/写入真实缓存。对真正的 Magpie 用例这是本 PR 的目的（ADR 第 2 条），但对 `gitleaks-config.test.mjs:73` 是副作用；且没有任何测试固定“测试是否共享真实缓存”这件事。ADR 0181:53 的“免得单元测试写进真实缓存”因此只在库函数层面成立，在 CI 测试进程里不成立。
- 证据:
```js
// run.mjs
...(runnerCacheDirectory(process.env) ? { [cacheEnvironmentKey]: runnerCacheDirectory(process.env) } : {}),
```
```ts
// vitest.workspace.ts
const toolingEnvironment = {
  ...Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith("GITHUB_")).map(...)),
  GITHUB_ACTIONS: "false",
  HIMAWARI_REVIEW_GATEWAY: "",
};
```
- 建议: 明确取舍并写进 ADR：要么在 `toolingEnvironment` 里置空 `HIMAWARI_CI_CACHE_DIR`，只让需要真实网关的用例显式传入一个受控目录；要么明确写下“tooling 测试允许共享真实缓存”，并使 `gitleaks` 等用例显式隔离。至少补一条用例证明普通单测不会碰真实缓存。

### 低 5 — `curl` 不存在（ENOENT）时也会重试满约 15 分钟才失败
- 文件: `scripts/model-review/gateway.mjs:233-236`
- 问题: `spawnSync` 找不到 curl 时 `status` 为 `null`、`stdout` 为空，`status` 解析为 0，`network = result.status !== 0 && !status` 为真，于是把“程序不存在”当成网络错误重试。旧实现会立即失败；新实现会白等 15 分钟。
- 证据:
```js
const status = Number((result.stdout ?? "").trim().slice(-3)); // "" -> 0
const network = result.status !== 0 && !status;                // null!==0 && !0 => true
```
- 建议: `spawnSync` 返回 `result.error?.code === "ENOENT"`（或 `EACCES`）时立即抛出，不进入重试预算。

### 低 6 — 清理不统计/不删除 24 小时内的 `.tmp-*`；清理异常会让 install-tools 失败
- 文件: `scripts/ci/verified-download.mjs:190-208`、`scripts/ci/install-tools.mjs:599-603`
- 问题: 新生成的 `.tmp-*` 既不进入 `entries`、也不计入 1 GB 总量，直到超过 24 小时才可能被删，期间磁盘上限可被绕过；另外 `pruneCache` 里的 `rmSync` 没有逐项 try/catch，删除失败会向上抛，使已经成功安装工具的 CLI 以非零退出，和“缓存/清理不额外拖红 CI”的意图不完全一致（ADR 只说缓存写失败不失败）。
- 证据:
```js
const entry = digestPattern.test(name) && status.isFile();
if ((temporary && age > temporaryMaxAgeMs) || (!temporary && !entry) || (entry && age > cacheMaxAgeMs)) {
  rmSync(path, { recursive: true, force: true });   // 未包 try
  continue;
}
if (entry) entries.push({ ... });                    // 新 .tmp-* 不计入总量
```
- 建议: 把新鲜 `.tmp-*` 也计入总量（或设单文件上限），并把清理做成 best-effort（`try/catch` + 报告），不让清理失败改变安装结果。

---

## 读代码证实 vs 推测

- **读代码证实**: 上述 1、2、3、5、6 的全部代码路径；4 中 `run.mjs` 注入、vitest 未清空该变量、`ci/policy.json` 的 policy/coverage 包含 `tooling` 项目；`gitleaks-config.test.mjs` 与 `review-gateway.test.mjs` 的默认缓存使用。
- **推测**: `Retry-After: 0` 或过去日期在 GitHub/CDN 实际发生的概率；巨大缓存文件攻击的实际可执行性（受同账号权限和磁盘配额影响）；新增测试在当前环境是否全部通过（我没有运行测试，只做了静态核对）。
- **未核实**: 生产 runner 上 `HOME` 的确切值（ADR 说是 `/srv/gh-runner*/home`，我没有读机器）；新增测试里 `rmSync` 对符号链接的实现细节我按 Node 语义判断为“删链接不删目标”，但没有运行验证。

---

## 侧重检查

- **不可信输入**: 检查了 `Retry-After`（数字、HTTP 日期、0、过去时间）和缓存文件名/符号链接。发现 0/过去时间导致无限循环（高 1）；非摘要名与符号链接会被拒绝或删除，符合作者说明。
- **资源耗尽**: 缓存读取无大小上限（中 3）；`.tmp-*` 不计入 1 GB 上限（低 6）；零延迟重试可绕开 15 分钟预算（高 1）；ENOENT 重试 15 分钟（低 5）。
- **错误路径**: curl 非零退出但已见 2xx 被误判为不可重试（中 2）；缓存写失败被吞掉且不失败 CI（符合说明）；清理异常会传播（低 6）。
- **不可撤销操作**: `pruneCache` 会删除缓存目录下所有非摘要名文件；在专门缓存目录内符合设计，但若 `HIMAWARI_CI_CACHE_DIR` 被误配到共享目录，会删除无关文件。该风险来自配置，不是本次代码越权；未发现越出指定目录的删除。
- **完整性**: 命中时重新算摘要、摘要不符删除、符号链接不读、写入先 `.tmp-*` 再改名、复制而非硬链接，均与作者说明和 ADR 一致。
- **文档与代码一致性**: ADR 0181:53 的“免得单元测试写进真实缓存”在实际 CI 流程里不成立（低 4）；ADR 0181:57 的“累计等待超过 15 分钟就失败”在 `Retry-After: 0` 时不成立（高 1）；其余“404/403 不重试、缓存写失败不失败 CI、30 天/1 GB 清理”与代码基本一致。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本次 diff 只涉及 CI 下载/缓存脚本、本地复核网关的安装器、文档和测试，没有改动系统提示、工具定义、历史消息、遮盖或任何请求序列化代码；`gateway.mjs` 只负责安装 Magpie 二进制，安装前后字节由 SHA-256 校验，不进入请求体。因此仍然只在末尾追加、每轮会变的值仍在最后一条消息。依据规则仍成立。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。缓存是内容寻址的，命中时必须重算摘要一致才使用；随机数只用于重试抖动和临时文件名，时间只用于缓存 mtime/清理，均不进入模型输入。没有新增依赖遍历顺序的集合或带时间的请求字段。

3. **有没有自动检查，反向用例真的会失败？** 有：`test/tooling/verified-download.test.mjs` 覆盖断网命中、投毒删除、摘要不符不入缓存、失败后无半截文件、符号链接/非摘要名、Retry-After、预算、404 不重试、prune、curl 504/404/预算、`installGateway` 命中不下载；`test/tooling/toolchain.test.mjs` 把“一直失败”从 3 次改成 7 次并断言等待序列。把这些逻辑单独回退，新用例会因导入失败、等待次数不符或 `Retry-After` 不生效而失败。**缺口**：没有反向用例覆盖 `Retry-After: 0`/过去日期、curl 非零退出但已见 2xx、curl 不存在、以及“tooling 测试不碰真实缓存”；高 1、中 2、低 5 正是这些缺口下的真实路径。

4. **每个新值的使用方都能接受吗？** 逐个核对：
   - `HIMAWARI_CI_CACHE_DIR`：`run.mjs`/`install-tools.mjs` 产生的是绝对路径；消费端 `explicitCacheDirectory` 明确要求 `isAbsolute`，相对路径返回 null（`verified-download.mjs:26-29`），两端一致。
   - 缓存文件名 = SHA-256：工具链锁由 `install-tools.mjs:46-47,58-69` 校验为 `[a-f0-9]{64}`；Gateway 锁在 `gateway.mjs:186-193` 校验为 `[0-9a-f]{64}`；`cacheRead/cacheWrite/pruneCache` 用同一个 `digestPattern=/^[a-f0-9]{64}$/`。两端一致。`readGatewayLock` 本身不校验，但即使锁文件恶意写成非摘要，`cacheRead` 会直接不命中，随后 `sha256File(partial)!==asset.sha256` 会拒绝，不会使用错误内容。
   - 缓存目录/时间/大小常量只在模块内使用，无外部消费者。
   - 文档新增的 I-89、ADR 0181 是纯文本，没有后端校验消费者；ADR 编号 `0181` 未被占用。
   - 唯一的“两端不一致”是测试/文档层面：`run.mjs` 传给测试子进程的显式缓存目录，与 ADR 0181:53 声称的“单元测试不写真实缓存”不一致（低 4）。
