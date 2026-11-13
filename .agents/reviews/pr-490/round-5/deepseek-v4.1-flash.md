## 结论（按严重度）

### 1. 中：失败回滚会把「本轮之前就已启用」的 socket 一起停掉，且不会恢复
- 位置：`scripts/operations/multi-user-exec/exec-accounts.mjs:325-334`
- 问题：`enabled` 只记录「本次 `enable --now` 调用过」的槽位，无法区分该 socket 在本次 apply 之前是否已经启用并正在服务。任何后续失败都会执行 `disable --now`，把之前正常工作的个人网关也停掉；而 `restoreUnits` 只恢复单元文件并 `daemon-reload`，不重建 `sockets.target.wants` 下的 enable 链接，也不重新启动。
- 证据（亲自读到）：
  ```js
  for (const entry of ledger.slots)
    if (entry.state === "active") {
      run("systemctl", ["enable", "--now", socketName(entry.slot)]);
      enabled.push(entry.slot);
    }
  ...
  if (options.systemd)
    for (const slot of enabled) quiet("systemctl", ["disable", "--now", socketName(slot)]);
  ```
  `restoreUnits`（同文件 245-250）只做：
  ```js
  for (const name of presentUnits(options.units, known)) rmSync(...);
  for (const name of readdirSync(backup)) copyFileSync(...);
  if (options.systemd) quiet("systemctl", ["daemon-reload"]);
  ```
- 影响：一次瞬时失败（例如第 N 个槽位 `enable --now` 出错）会让前 N-1 个原本早已在服务的个人网关停摆，直到下一次成功 apply。这是本轮改动新引入的行为（改动前失败时这些 socket 保持运行）。
- 建议：启用前先用 `systemctl is-enabled/is-active` 记录原始状态，只停「本调用从 disabled 变为 enabled」或「本调用新启动」的单元；回滚时对原本 enabled 的槽位执行 `enable --now`。或者失败时只停本次新写入账本、此前不存在的槽位。

### 2. 中/低：陈旧锁接管存在 TOCTOU，删除锁时不核对「删的还是不是同一把锁」
- 位置：`scripts/operations/multi-user-exec/exec-accounts.mjs:103-126`（本轮新增 119-121 的空锁分支），以及 `392-394` 的 finally。
- 问题：读到锁内容后，`rmSync(lock, { force: true })` 直接按路径删除，没有校验删除时的文件仍是刚才判定为陈旧的那一个。两个并发的 root 进程可以交错为：A 读到旧锁→B 删旧锁并创建新锁→A 删掉 B 的新锁→A 又创建成功，双方都以为自己持锁。`finally` 里也是无条件 `rmSync`。
- 证据：
  ```js
  const owner = Number.parseInt(readFileSync(lock, "utf8"), 10);
  ...
  } else {
    alive = Date.now() - statSync(lock).mtimeMs < 10_000;
  }
  if (alive) throw new Error(`EXEC_LOCKED ${lock} held by pid ${owner}`);
  rmSync(lock, { force: true });
  ```
  ```js
  } finally {
    rmSync(lock, { force: true });
    closeSync(held);
  }
  ```
- 说明：这段的竞态时序是推断（未实际并发复现）；「删除前不校验 lock 身份」「finally 无条件删锁」是读代码确认的。另外 `readFileSync`/`statSync` 在 EEXIST 与读取之间若锁被并发删除会抛 ENOENT，绕过 `EXEC_LOCKED` 语义、以原始错误上抛。
- 建议：接管陈旧锁时做原子替换/校验（例如先 rename 到一个临时名再确认 inode/内容仍匹配，或持锁后写自己的 pid 并校验），finally 只在锁内容仍是自己的 pid 时删除。

### 3. 低：本轮新增的多条分支没有任何自动检查，反向用例无法证明会失败
- 位置与证据：全仓 grep 只命中定义处，没有测试引用：
  - `EXEC_INIT_LEDGER_NOT_EMPTY`（`exec-accounts.mjs:380`）
  - `EXEC_PEOPLE_GROUP_SHARED`（`exec-accounts.mjs:190`）
  - `EXEC_GATEWAY_FILE_UNSAFE`（`exec-accounts.mjs:265`）
  - socket 回滚（`exec-accounts.mjs:333-334`）
  test 里只有 `peopleGroup: "docker"` 与 `serviceAccount: "hx-andyaa"` 两条（`test/tooling/multi-user-exec.test.mjs:99-100`）。
- 问题：`qualify-accounts.mjs` 是 root 手动脚本，且其退休目录用例只断言目录存在/不可达（`qualify-accounts.mjs:229-236`），没有断言改名后的属主与权限（`root:root 0700`），因此「先改属主再改名」这一本轮改动没有被任何检查守住。
- 建议：为上述四个错误码补单元/集成用例（至少覆盖非空账本拒绝 init、people 组有外人时失败、网关文件权限不足时失败、失败回滚后原有 socket 仍 active）；qualify 里补 `stat` 属主/权限断言。

### 4. 低：硬编码上限检查只认 `Key=value`，漏掉配置对象里的硬编码上限
- 位置：`scripts/check-multi-user-exec.mjs:5-7`
  ```js
  export const LIMIT_DIRECTIVE =
    /\b(?:MemoryMax|MemoryHigh|...)\s*=\s*(?:[0-9]|infinity)/g;
  ```
- 问题：作者称「工具里写死上限数字就失败」，但 `qualify-accounts.mjs:129-136` 明确写着 `MemoryMax: "2G"`、`CPUQuota: "100%"`、`TasksMax: "10"` 等 JSON 形式上限，因是冒号不是等号，`scan()` 不会报。工具目录内的这些数字不会触发失败。
- 建议：若目标是「工具目录不得出现上限字面量」，正则同时覆盖 `Key\s*:\s*["']?数字`；若 qualify 的测试数据属于豁免，应显式排除并写明，避免声明与实现不一致。

### 5. 低：`--init` 残留检查会把根目录下任何无关条目当作残留，可能误拒合法首次初始化
- 位置：`scripts/operations/multi-user-exec/exec-accounts.mjs:85-101`
  ```js
  ...(config.privateRoots, config.workspaceRoots].flatMap((root) =>
    existsSync(root) ? readdirSync(root).map((name) => path.join(root, name)) : [],
  )
  ```
- 问题：只按「目录非空」判定残留，没有按 slot 名/工具命名空间过滤。若私有根或工作区根所在文件系统带有 `lost+found`，或运维预建了无关文件，首次 `add --init` 会永久报 `EXEC_INIT_OVER_EXISTING`。这是读代码确认的行为；是否算缺陷取决于对「根必须全新」的约定。
- 建议：只把符合 slot 命名（或能对应 hx- 账号/单元名）的条目算残留，无关条目忽略或单独提示。

### 6. 低/推测：网关文件检查是「world 可读/可执行」，不等于执行账号真的能执行
- 位置：`scripts/operations/multi-user-exec/exec-accounts.mjs:252-266`
  ```js
  (metadata.mode & 0o004) === 0 ||
  (executable && (metadata.mode & 0o001) === 0)
  ```
- 问题：只检查文件自身的 other 位，不检查路径上各级目录是否可被执行账号穿越，也不接受 ACL/组授权。结果可能两种都不对：ACL 授权但 other 位不满足时误拒；other 位满足但父目录不可穿越时通过检查、服务仍起不来。这是推断，未在真实账号下验证。
- 建议：以实际执行账号做一次 `access()` 等价探测，或至少校验父目录可穿越并说明 ACL 不受支持。

---

## 侧重检查

- **错误路径 / 回滚**：逐段读了 `converge` 的 try/catch、`restoreUnits`、`retire`。确认回滚只覆盖单元文件，不覆盖 socket 启停、group/usermod 副作用、已改属主/已改名目录；发现并报告了「停掉原本在跑的 socket」这一新问题。
- **不可信输入**：`parseExecConfig` 新增的 `serviceAccount` hx- 禁令与保留名扩充均在任何副作用之前执行，值类型/正则校验路径正确；`account()` 对两个字段共用，两端一致。
- **安全边界**：`setOwnerAndMode` 用 `O_NOFOLLOW|O_DIRECTORY`，`retire`/`ensureDirectory` 用 `lstat` 拒绝符号链接，根目录为 root:root 0755，执行账号无法替换自己的顶层目录，本轮「先改属主再改名」没有制造新的跟随符号链接问题。
- **锁与并发**：新空锁/乱码锁分支读代码确认有按路径删除的 TOCTOU 与无条件 finally 删锁；`parseInt("123junk")` 会被当作 pid，导致「乱码锁超过 10 秒接管」对这类内容不成立（作者说法只对纯乱码/空锁成立）。
- **资源耗尽**：锁、账本、passwd/组读取均为小文件/有限输出，未发现明显放大；`refuseInitOverResidue` 的 `readdir` 与全量 passwd 扫描开销可忽略。
- **规则/文档/代码一致性**：本 PR 未改 `.claude/rules/prompt-prefix.md`、`docs/incidents-and-gates.md` 或任何提示词/出口代码；文档声明与实现的差异集中在「写死上限就失败」这条检查覆盖面上（见第 4 条）。
- **未核实**：`.claude/rules/prompt-prefix.md` 与 `.agents/reviews/pr-490/round-*/judgments.md` 在当前稀疏检出中不可读（`git show` 对 records 路径被拒），因此前几轮「判定不改」的细节以本轮 prompt 描述为准，未逐条回读。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。基准到 HEAD 的 diff 只涉及 `package.json`、`scripts/...`、`test/tooling/...`（见 `git diff --stat`），没有系统提示、工具定义、历史消息或遮盖相关文件；新增的是写盘的 systemd 单元、账本 JSON、目录与账号操作，不进入发给模型的内容。因此仍满足「只在末尾追加」；本 PR 也没有任何「每轮会变的值」写进请求。规则原文因稀疏检出未读到，结论基于 diff 与代码路径，标为「规则文件未核实」。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。本 PR 唯一带时间/pid 的字段是备份目录名（`new Date().toISOString()` + pid，`exec-accounts.mjs:235-238`）和原子写临时文件名（`148-153`），二者都只落在文件系统，不进入任何模型请求；账本/单元序列化也是本地文件，且不依赖前后文。
3. **有没有对应自动检查、反向用例真的会失败？** 部分有：`serviceAccount: "hx-andyaa"`、`peopleGroup: "docker"` 有反向用例（`test/tooling/multi-user-exec.test.mjs:99-100`），空锁/僵尸 pid 锁在 root 手动 `qualify` 里有反向断言。但本轮新增的 `EXEC_INIT_LEDGER_NOT_EMPTY`、`EXEC_PEOPLE_GROUP_SHARED`、`EXEC_GATEWAY_FILE_UNSAFE`、socket 回滚、退休目录属主顺序均无自动用例，无法证明「去掉修复会失败」；且 `check:multi-user-exec` 的硬编码扫描漏掉 JSON 形式上限。结论：覆盖不完整。
4. **每个新产生/修改的值，两端都接受吗？** 逐项核对如下：
   - `RESERVED_ACCOUNTS` 新增项 → 唯一消费者是 `account()`，同时用于 `serviceAccount` 与 `peopleGroup`，两端一致（`plan.mjs:9-24,69-73,175-176`）。
   - `serviceAccount` 禁 `hx-` → 与 `accountName()`（`hx-<slot>`）、`refuseInitOverResidue` 的 `^hx-[a-z][a-z0-9]{5}$` 扫描一致，不会把执行账号误当服务账号或反之（`plan.mjs:169-170,245`；`exec-accounts.mjs:95-98`）。
   - `peopleGroup !== serviceAccount` 与成员校验 → `ensureGroup` 读取的 `getent group` 成员字段与 `ensureAccount` 的 `id -nG` 使用的是同一组名，语义一致（`exec-accounts.mjs:184-193,213-215`）。
   - 锁内容（`${pid}\n`）与 10 秒 mtime 阈值 → 产生与消费都在同一函数；但 `parseInt` 对「数字前缀+乱码」会被当成 pid，属于两端语义不完全一致（第 2 条）。
   - 网关文件 mode 位 → 仅该函数内部消费，无跨模块值。
   - `check:multi-user-exec` 脚本名 → `package.json` 中定义并已挂进 `check:steps`，两端一致。
   - 未发现「清单里的 id 过不了另一端校验」式的硬性不一致；主要缺口是测试覆盖与前述锁/回滚语义。
