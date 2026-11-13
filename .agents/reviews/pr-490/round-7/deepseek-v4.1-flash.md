## 结论概要

本次增量（`cae882930..b0abee2b`）只改了两个文件：`scripts/operations/multi-user-exec/exec-accounts.mjs` 和 `test/tooling/multi-user-exec.test.mjs`。抽出的 `enableSockets`/`undoSockets` 在“回滚时恢复 enabled 状态”这一点上有一个可直接从代码证明的漏洞；其余主要是测试没覆盖到的分支和一个依赖 systemd 语义的推测性缺口。

---

## 问题

### 1. 严重度：中 — 回滚会把“已启用但未运行”的 socket 永久停用

- 文件:行：`scripts/operations/multi-user-exec/exec-accounts.mjs:308-313`（分支判断在 310 行）
- 问题：`undoSockets` 只按 `wasActive` 分两支，把“本轮之前未运行”一律当成“本轮才启用”，用 `disable --now` 回滚。若某 socket 在本次 apply 前是 **inactive + enabled**（例如管理员手动 `systemctl stop` 暂停过，或上一次 apply 的 `enable --now` 在 start 阶段失败但 enable 已生效），本次 apply 会把它启动；后续某个 slot 失败触发回滚时，`disable --now` 会把它的 enable 状态也去掉，恢复到的是“inactive + disabled”，与改动前状态不同。这与本轮声称的“回滚时恢复 enabled 状态”相反。
- 证据（亲自读到）：
  ```js
  308: export function undoSockets(changed, io) {
  309:   for (const item of changed) {
  310:     if (!item.wasActive) io.quiet("systemctl", ["disable", "--now", socketName(item.slot)]);
  311:     else if (!item.wasEnabled) io.quiet("systemctl", ["disable", socketName(item.slot)]);
  ```
  生产方在 `304` 行同时记录了 `wasActive` 与 `wasEnabled`，消费方却没有使用“`!wasActive && wasEnabled`”这一组合。
- 建议：三分支恢复：
  - `!wasActive && !wasEnabled` → `disable --now`
  - `!wasActive && wasEnabled` → `stop`（只撤销启动，保留 enable）
  - `wasActive && !wasEnabled` → `disable`（保留运行，只撤销 enable）
  并在新测试中补 `wasActive:false, wasEnabled:true` 的用例。

### 2. 严重度：低（推测，依赖 systemd 的实际执行顺序）— `enable --now` 部分成功时回滚漏记，可残留 enable 符号链接

- 文件:行：`scripts/operations/multi-user-exec/exec-accounts.mjs:303-304`、`352-354`、`237-257`
- 问题：`changed.push` 发生在 `io.run("systemctl", ["enable", "--now", socket])` **成功返回之后**。而 `systemctl enable --now` 是“先 enable、再 start”；若 enable 成功、start 失败，命令以非零退出，但 enable 符号链接已经建立，这一条不会进入 `changed`，回滚不会执行 `disable`。
  ```js
  303:     io.run("systemctl", ["enable", "--now", socket]);
  304:     if (!wasActive || !wasEnabled) changed.push({ slot: entry.slot, wasActive, wasEnabled });
  ```
  之后 `restoreUnits` 只按顶层单元文件恢复：
  ```js
  237: function presentUnits(directory, known) {
  238:   return existsSync(directory) ? readdirSync(directory).filter((name) => known.has(name)) : [];
  ```
  `presentUnits` 看不到 `/etc/systemd/system/sockets.target.wants/` 下的 enable 符号链接，因此新 slot 的单元文件被删掉后，`sockets.target.wants/himawari-exec-<slot>.socket` 可能成为悬空启用项。这属于本轮“启用/回滚 socket”逻辑没有覆盖的失败路径。
- 证据：上述代码；`restoreUnits` 在 `252-257` 行只复制/删除 `presentUnits` 枚举到的顶层文件。
- 建议：在调用 `enable --now` 之前就把“意图”记入 `changed`（或失败后重新探测 `is-enabled` 并补记），回滚时按实际状态 `disable`；`restoreUnits` 对 `known` 单元同时清理 `*.wants/` 下的同名符号链接。若认为该路径不在本 PR 范围，至少加注释/测试说明。
- 说明：该“成功后才记录”的写法在上一轮的 inline 代码里已存在；这里列为问题是因为本轮把回滚逻辑重写成新函数并声称恢复 enabled 状态，仍留下此缺口。

### 3. 严重度：低 — 新测试缺少关键分支，其中一条不是对新增行为的反向用例

- 文件:行：`test/tooling/multi-user-exec.test.mjs:347-422`
- 问题：
  - 没有 `wasActive:false, wasEnabled:true` 的用例，正好漏掉问题 1。
  - `stops a socket this run started`（394-400 行）在旧的回滚语义（只对“之前未运行”的 socket 执行 `disable --now`）下同样会通过，因此它不是本轮新增“恢复 enabled”行为的反向用例，只是既有行为回归保护。
  - fake 的 `run` 不更新状态，测试只断言命令行字符串，无法验证真实 systemd 下的最终 enabled/active 状态。
- 证据：新测试里两组状态分别为 `{active:true,enabled:true}`/`{active:true,enabled:false}`（381-384 行）和全空状态（395 行），没有 inactive+enabled。
- 建议：按问题 1 的三分支各写一例；如需验证最终状态，让 fake 在 `run enable/disable/stop` 后更新 state 并断言 state，而不只是断言调用字符串。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆操作、文档一致性）

- **锁的失败路径**：`releaseLock`（103-108 行）在 `readFileSync`/`rmSync` 失败时吞掉异常并仍 `closeSync`，满足“不覆盖主错误”；锁内容为 `${pid}\n` 时才会删除，避免误删他进程的锁。已读代码确认。残留锁在进程退出后可由 `acquireLock` 的 ESRCH 分支接管（110-134 行，已读）。
- **不可逆/持久状态**：本轮唯一会持久改变系统状态的是 `enable`/`disable`。问题 1 会把“原本重启后仍会自动启用”的 socket 变成不自动启用，属于可恢复但会跨重启的配置漂移，可能造成单人网关重启后不再自启，直到下次 apply。`stop` 本身可逆。
- **不可信输入**：`enableSockets` 的 slot 均来自已通过 `parseLedger`/`parseExecConfig` 校验的 ledger（`plan.mjs:193-217`），会拼进 `socketName`，未发现新的注入面；测试里的 fake ledger 未校验，但只在测试中使用。
- **资源耗尽**：`enableSockets` 按 ledger 线性遍历，无新增无界递归；`parseLedger` 未限制 slot 数量，但 uid 范围与唯一性提供间接上限，且输入是 root 配置，未作为本轮问题。
- **符号链接/竞争**：本轮代码未新增文件系统写入路径（改动只在 socket 启停和锁）；既有 `setOwnerAndMode` 的 `O_NOFOLLOW`、`ensureDirectory`/`retire` 的 `lstat` 未改，未发现本轮引入的新问题。
- **文档/规则一致性**：仓库中 grep 未找到描述该工具或 `EXEC_LOCKED`/`EXEC_APPLY_INCOMPLETE` 的 Markdown 文档，因此本轮没有“文档与代码矛盾”的可核对项。第 7 轮作者说法的四条（启用/回滚抽取、恢复 enabled、放锁不覆盖主错误、4 条用例）中，第 1、3、4 条与代码一致，第 2 条只实现了一半（见问题 1）。
- **未核实**：无法读取前几轮的 `judgments.md`（稀疏检出中不存在，`git show` 对该 records 路径被拒绝），因此无法确认哪些旧意见已被明确判为“不改”；以上仅按本轮改动本身判断。也未能运行测试/lint（工具限制），测试是否 40 条全过未独立核实。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次改动只在 root 开通工具和其测试里，`git diff --stat` 显示增量仅 `exec-accounts.mjs` 与 `multi-user-exec.test.mjs`，没有触碰系统提示、工具定义、历史消息、遮盖逻辑或请求组装。发给模型的内容仍然只在末尾追加；本次也没有引入任何“每轮会变的值”进入请求头部。依据：`.claude/rules/prompt-prefix.md` 第 4 条（已经发出的内容不得改动，只能末尾追加）及第八节“改动前先问自己”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会（就模型请求而言）。该工具不参与请求内容的生成。生成物中确实存在时间值：`backupUnits` 的目录名（`exec-accounts.mjs:244`）和 `retire` 的重命名后缀（`:284`）使用 `new Date().toISOString()`；但它们只是文件系统路径，不进入模型请求。`renderUnits` 的字段顺序来自固定的对象字面量和 `Object.entries`，ledger 顺序由 `parseLedger` 保留，不含随机/集合遍历顺序。假如将来把 `.removed-<时间戳>` 路径作为工具结果喂给模型，会引入每轮变化的值，届时需要重新评估；当前代码没有这样做。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有。`package.json` 的 `check:steps` 加入了 `check:multi-user-exec`，其命令为 `node scripts/check-multi-user-exec.mjs && vitest run ... test/tooling/multi-user-exec.test.mjs`；本轮新增了 4 条用例（`multi-user-exec.test.mjs:347-422`）。

反向有效性：
- `keeps a lock that no longer holds our pid...` 和 `removes its own lock...`：若 `releaseLock` 无条件删除锁、或 `acquireLock` 不拒绝活锁，都会失败，属于有效反向用例。
- `leaves sockets that were already running...`：若回滚对 `wasActive:true, wasEnabled:false` 的 socket 不做 `disable`（上一轮语义），`toContain("disable himawari-exec-bobbyb.socket")` 会失败，属于有效反向用例。
- `stops a socket this run started`：在上一轮语义下也会通过，不能区分新旧实现，反向强度不足。
- **缺口**：没有 `wasActive:false, wasEnabled:true` 的用例，因此问题 1 不会被自动检查发现；问题 2 的失败路径也没有对应测试（现有 fake 不模拟部分成功）。

### 4. 改动产生/修改的每个值，两端是否都能接受？

逐个核对：
- `changed[]` 元素 `{slot, wasActive, wasEnabled}`：产生于 `exec-accounts.mjs:304`，使用于 `undoSockets` 的 `:309-311` 和测试 `:387-398`。字段名与类型两端一致；`slot` 会传入 `socketName`，其格式由 ledger 校验保证。**语义上消费端漏用了 `wasEnabled` 的一个组合（问题 1）。**
- 锁文件内容 `${process.pid}\n`：产生于 `:114`；`acquireLock` 用 `Number.parseInt` 读取（`:118`），`releaseLock` 用严格字符串比较读取（`:105`）。两端对“本工具写入的格式”一致；若锁被外部改写成 `" 123\n"` 之类，`acquireLock` 仍认作 pid 123，而 `releaseLock` 不会删除，会留下锁。本工具不会产生这种格式，属于外部干预场景。
- 四个导出函数 `acquireLock` / `releaseLock` / `enableSockets` / `undoSockets`：调用方只有 `main`（`:396,413`）和测试（`:9-13`），签名与实参一致。
- 测试里的 `fakeSystemctl` state 键使用 `socketName` 产物，`failing` 与 `args[2]` 对齐，未发现键名/参数错位。
- `check:multi-user-exec` 配置键：`package.json` 中脚本名与 `check:steps` 引用一致；未发现拼写或路径不一致。

**未核实**：前几轮 `judgments.md` 的关闭项、ADR 0234 原文，以及测试/lint 的实际运行结果。
