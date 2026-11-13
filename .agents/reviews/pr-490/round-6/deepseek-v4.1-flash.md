## 结论概览

本轮增量（`7ec59e477..cae882930`）只改了 3 处：`converge` 的 socket 回滚范围、锁文件删除条件、qualify 的两条断言。没有发现高危新问题；作者对这三处的文字描述与代码一致。以下是按严重度排列的问题。

---

### 1. 中：本轮两处行为改动没有任何自动化反向用例

- 文件:行：`scripts/operations/multi-user-exec/exec-accounts.mjs:327-335`、`scripts/operations/multi-user-exec/exec-accounts.mjs:394`；`package.json:40`
- 问题：`check:multi-user-exec` 只跑 `check-multi-user-exec.mjs` 和 `test/tooling/multi-user-exec.test.mjs`，而后者只覆盖 `plan.mjs`、`check` 脚本和“账本缺失”用例，没有覆盖 `converge` 的回滚，也没有覆盖锁文件清理。本轮新增的两条 qualify 断言也没有覆盖这两处行为；且 `qualify-accounts.mjs` 没有被 `package.json` 或 CI 引用，是纯手工 root 脚本。
- 证据：
  - `exec-accounts.mjs:327-329` 新增 `wasActive` 判断，`exec-accounts.mjs:335` 只对本轮新启动的 slot 执行 `disable --now`。
  - `exec-accounts.mjs:394` 新增“内容仍是自己 pid 才删锁”。
  - `package.json:40`：`"check:multi-user-exec": "node scripts/check-multi-user-exec.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/multi-user-exec.test.mjs"`。
  - 我通读了 `test/tooling/multi-user-exec.test.mjs`，其中没有 `exec-accounts` 的 converge/回滚/锁删除测试。
- 建议：为这两处补可注入 `systemctl`/`run` 的自动化用例，至少验证反向条件：(a) apply 前已运行的 socket 在失败回滚后仍 active；(b) finally 不删除内容已非本进程 pid 的锁。否则“反向用例会失败”无法被自动证明。

### 2. 低：回滚只记录“之前是否 active”，没有记录/恢复 enabled 状态

- 文件:行：`scripts/operations/multi-user-exec/exec-accounts.mjs:327-329`、`exec-accounts.mjs:335`
- 问题：`enable --now` 对“已运行但未 enable”的 socket 会新建 `*.wants` 符号链接。由于 `wasActive` 为真，该 slot 不会进入 `enabled`，失败回滚时不会 `disable`，于是失败后系统比 apply 前多了一个 enabled 单元。回滚并没有精确恢复到 apply 前状态。
- 证据：
  ```js
  const wasActive = quiet("systemctl", ["is-active", "--quiet", socketName(entry.slot)]);
  run("systemctl", ["enable", "--now", socketName(entry.slot)]);
  if (!wasActive) enabled.push(entry.slot);
  ...
  for (const slot of enabled) quiet("systemctl", ["disable", "--now", socketName(slot)]);
  ```
  注意 `enable --now` 在 socket 已 active 时仍会创建 enable 链接，而回滚列表只按 active 判断。
- 建议：同时记录 `is-enabled` 状态，失败时把 enabled 位恢复到 apply 前；或在文档中明确“失败后 allowed 的残留是 enable 位”，并让下一次 apply 幂等收敛。

### 3. 低（机制确定、触发条件为推测）：finally 里的 `readFileSync(lock)` 可能覆盖原始错误

- 文件:行：`scripts/operations/multi-user-exec/exec-accounts.mjs:393-395`
- 问题：旧代码 `rmSync(lock,{force:true})` 不会抛错；新代码先 `readFileSync`。如果锁文件在 finally 执行时不存在或不可读（例如外部清理、或锁接管路径 `rmSync(lock)` 后尚未重新 `openSync` 的窗口），`readFileSync` 会抛 `ENOENT`/`EACCES`，从而覆盖 `converge` 抛出的真实错误，并且跳过 `closeSync(held)`。
- 证据：
  ```js
  } finally {
    if (readFileSync(lock, "utf8") === `${process.pid}\n`) rmSync(lock, { force: true });
    closeSync(held);
  }
  ```
- 建议：把读锁包进 `try/catch`（读失败就不删），并把 `closeSync(held)` 放进独立的 `finally`，避免清理动作掩盖主错误。

---

## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 文档一致）

- 锁路径：读了 `acquireLock`（`exec-accounts.mjs:103-127`）与 finally（`394-395`）。内容为数字且进程存活 → 拒绝；空/乱码且 10 秒内 → 拒绝；死 pid / 过期空锁 → 接管。本轮“只删自己的锁”逻辑本身正确。**遗留（非本轮引入）**：`acquireLock` 在判定持有者已死后执行 `rmSync(lock)` 与下一轮 `openSync(lock,"wx")` 之间存在 TOCTOU，两个进程可能同时接管；这不是本 diff 引入的，未作为本轮结论。
- 退休目录/属主/权限：`retire` 先 `setOwnerAndMode(directory,0,0,0o700)` 再 `renameSync`，`setOwnerAndMode` 用 `O_NOFOLLOW`（`exec-accounts.mjs:166-175`、`269-288`）。qualify 新断言 `uid===0 && gid===0 && mode===0700`（`qualify-accounts.mjs:248-255`）与实现一致。断言用 `statSync` 会跟随符号链接，但该目录是本工具 rename 出来的真实目录，当前路径不构成问题。
- 符号链接/目录竞争：`ensureDirectory` 用 `lstatSync` + `O_NOFOLLOW`；本轮未改动这些路径，未发现新问题。
- 失败回滚：只 `disable --now` 本轮新启动的 socket；`restoreUnits` 仍只处理 `known` 集合内的单元，不会误删外部单元（`exec-accounts.mjs:315-338`）。未发现本轮引入的误删。
- 不可信输入：slot/uid/path/limits 的校验在 `plan.mjs`；本轮 `retire` 和测试使用的 slot 均来自已校验账本。
- 文档/说法一致性：作者对“回滚只停本轮之前没在运行的 socket”“锁只在内容仍是自己的 pid 时才删”“qualify 新增两条断言”的描述与代码一致。未发现本轮改动改动规则文件或文档。
- 未核实：我没有运行任何测试或 qualify 脚本，无法确认“40 条测试通过”“真实账号脚本通过”的实际结果。

---

## 必答问题

**Q1：会不会改变模型已经见过的请求开头？**
不会。该 diff 只涉及 `scripts/operations/multi-user-exec/*`、`test/tooling/multi-user-exec.test.mjs`、`package.json` 和评审记录，没有触碰系统提示、工具定义、历史消息或遮盖逻辑；发给模型的内容仍只在末尾追加，且本轮没有任何进入模型请求路径的改动。依据：[prompt-prefix.md](../../.claude/rules/prompt-prefix.md#rules) 与本轮文件清单。

**Q2：会不会让同一段文字在不同请求里变成不同字节？**
不会影响模型请求。工具内部确实产生非确定名字：`backupUnits` 用 `new Date().toISOString()+pid`，`retire` 用时间戳生成 `.removed-<stamp>`（`exec-accounts.mjs:236-243`、`274`），但这些只在本地目录/备份命名中使用，不进入模型请求；给定同一账本，`renderUnits`/`renderTmpfiles` 的输出顺序和内容是确定的。

**Q3：有没有对应的自动检查，反向用例是否真的会失败？**
部分有。配置/账本/单元渲染/硬编码上限扫描有单元测试；但本轮改动的“失败回滚不停已有 socket”和“finally 只删自己的锁”**没有自动化用例**，qualify 新增断言是手工 root 脚本且未接入 CI。因此这两处的反向用例目前不会自动失败。见上文问题 1。

**Q4：改动产生/修改的每个值，两端能否接受？**
逐个核对（本轮增量）：
- `enabled.push(entry.slot)` 产生 slot，消费端 `socketName(slot)`；slot 已由 `parseLedger` 的 `SLOT_PATTERN` 校验，两端一致。
- 锁内容 `${process.pid}\n` 产生于 `exec-accounts.mjs:107`；消费端有两处：`acquireLock` 的 `Number.parseInt(...,10)`（`111`）能接受换行，finally 的精确字符串比较（`394`）与写入格式一致，两端可接受。
- `retire` 产生 `<dir>.removed-<stamp>`；qualify 用 `${b}.removed-` 前缀匹配（`qualify-accounts.mjs:248-250`），与生产名一致。
- `EXEC_INIT_LEDGER_NOT_EMPTY` 产生于 `exec-accounts.mjs:381`；qualify 在 stderr 中匹配该串（`qualify-accounts.mjs:262`），两端一致；且非空账本检查在残留检查之前，断言语义正确。
- 唯一不是“两端校验不一致”、而是“状态未覆盖”的，是上文问题 2 的 enabled 位：写入端 `enable --now` 会改变 enabled，回滚端只看 active，未覆盖该值。
