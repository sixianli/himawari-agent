## 说明

- 已按 `git diff 07e621787fde3fbacddf3c7bb309aaa366fecb52..efd011dfa8c5fafab100aa4d1f87cbb6262251f8` 逐条核对增量：`exec-accounts.mjs`、`plan.mjs`、`qualify-accounts.mjs`、测试和 `package.json`。
- `round-1..3/judgments.md` 在当前稀疏检出中不存在，`git show HEAD:...judgments.md` 对记录路径被拒绝，**未能核对前几轮已判定/已延后的条目**；以下按当前代码独立判断，主要针对 07e621787 之后新增的问题。

---

# 读代码证实的问题

## 1. [中] 空锁文件或损坏锁文件会永久卡死所有 add/apply/remove

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:102-124`

问题：新锁逻辑只接管“内容能解析成正整数且进程已死”的锁。空文件、`0`、负数、任意文本都会把 `alive` 保持为 `true`，之后每次运行都报 `EXEC_LOCKED ... held by pid NaN`（或 `pid 0`），只能人工删锁。

证据：

```js
// 105-107：先创建文件，再写 pid，中间崩溃/断电就是空文件
const descriptor = openSync(lock, "wx", 0o600);
writeFileSync(descriptor, `${process.pid}\n`);
...
// 110-119：解析不出正整数时不做任何失效判断
const owner = Number.parseInt(readFileSync(lock, "utf8"), 10);
let alive = true;
if (Number.isSafeInteger(owner) && owner > 0) {
  ...
}
if (alive) throw new Error(`EXEC_LOCKED ${lock} held by pid ${owner}`);
```

另外 `writeFileSync` 自身失败（如 ENOSPC）时文件已经创建，异常直接抛出，也会留下空锁。

建议：用“临时文件 + `linkSync`”原子发布带 pid 的锁；写失败时 unlink；对无法解析或非正的 owner 按“残留锁”处理（可结合 mtime 阈值），或者明确报“需要人工删除”。补一条“空锁/乱码锁”的反向测试。

## 2. [中] `serviceAccount` 可以是 `hx-xxxxxx`，与执行账号命名空间冲突

文件：`scripts/operations/multi-user-exec/plan.mjs:161-162`、`scripts/operations/multi-user-exec/exec-accounts.mjs:94-97`

问题：本轮只禁止了 `peopleGroup` 命中 `^hx-[a-z][a-z0-9]{5}$` 或等于 `serviceAccount`，但 `serviceAccount` 本身没有同样限制。`accountName(slot)` 正是 `hx-<slot>`，所以配置可以接受一个永远无法首次 `--init` 的服务账号：`refuseInitOverResidue` 会把该服务账号当成残留账号拒绝。

证据：

```js
// plan.mjs:161-162
if (/^hx-[a-z][a-z0-9]{5}$/.test(raw.peopleGroup) || raw.peopleGroup === raw.serviceAccount)
  fail("EXEC_CONFIG_ACCOUNT_INVALID", "$.peopleGroup");
```

```js
// exec-accounts.mjs:94-97
...run("getent", ["passwd"])
  .split("\n")
  .map((line) => line.split(":")[0])
  .filter((name) => /^hx-[a-z][a-z0-9]{5}$/.test(name)),
```

后果：`parseExecConfig` 返回成功，`plan` 也能打印，但生产上 `add ... --init` 会被 `EXEC_INIT_OVER_EXISTING` 拒绝；如果服务账号还没建，则会在 `ensureGroup` 阶段以 `EXEC_SERVICE_GROUP_MISSING` 失败。两端校验不一致（I-73 的同类问题）。

建议：对 `serviceAccount` 应用同一份 `hx-` 正则，或让残留检查排除 `config.serviceAccount`；同时拒绝 `serviceAccount === accountName(任意 slot)`。补配置测试。

## 3. [中] `peopleGroup` 的成员没有被校验，且允许复用特权组

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:176-184`、`scripts/operations/multi-user-exec/plan.mjs:353-355`

问题：代码只保证组存在，并把服务账号加进去；从不检查组里是否已有别的成员，也允许配置任意已存在的组名。工作区是 `2770`、组为 `peopleGroup`，任何预先在这个组里的账号都会自动获得所有人工作区的读写权限。这与“只有主服务账号在 `himawari-people` 组里”的说法不一致。

证据：

```js
// 176-184
function ensureGroup(config) {
  if (!quiet("getent", ["group", config.serviceAccount]))
    throw new Error(`EXEC_SERVICE_GROUP_MISSING ${config.serviceAccount}`);
  if (!quiet("getent", ["group", config.peopleGroup]))
    run("groupadd", ["--system", config.peopleGroup]);
  const members = run("id", ["-nG", config.serviceAccount]).trim().split(/\s+/);
  if (!members.includes(config.peopleGroup))
    run("usermod", ["--append", "--groups", config.peopleGroup, config.serviceAccount]);
}
```

```js
// plan.mjs:353-355
plan.push({ path: paths.workspace, owner: user, group: config.peopleGroup, mode: "2770" });
```

另外 `RESERVED_ACCOUNTS`（`plan.mjs:9-18`）没有包含 `docker`、`lxd`、`disk` 等系统组；如果配置 `peopleGroup: "docker"`，服务账号会被追加进 `docker` 组，等价于给主服务账号很大的主机权限。

建议：要求 `peopleGroup` 是本工具专用的组（例如强制前缀/独立 GID 范围），创建后校验成员集合恰好是 `{serviceAccount}`（或为空再加），拒绝已有其他成员的组；扩充敏感组拒绝列表。补覆盖这些情况的测试。

## 4. [中低] 失败回滚不撤销 systemd 的 enable/start，失败后可能留下正在运行的 socket

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:235-240, 314-315`

问题：`restoreUnits` 只删除/复制单元文件并 `daemon-reload`，不停止或禁用已经被 `enable --now` 的 socket；`sockets.target.wants` 下的 enable 符号链接也不在 `known` 集合里，不会被清理。若在启用第二个槽时失败，第一个槽的 socket 仍在运行，而其单元文件可能已被回滚删除。

证据：

```js
// 235-240
function restoreUnits(options, known, backup) {
  for (const name of presentUnits(options.units, known)) rmSync(path.join(options.units, name));
  for (const name of readdirSync(backup))
    copyFileSync(path.join(backup, name), path.join(options.units, name));
  if (options.systemd) quiet("systemctl", ["daemon-reload"]);
}
```

```js
// 314-315
for (const entry of ledger.slots)
  if (entry.state === "active") run("systemctl", ["enable", "--now", socketName(entry.slot)]);
```

建议：在 catch 中记录并撤销本轮新 enable 的单元（`disable --now`），或明确声明 systemd 状态不回滚并让重跑负责收敛；同时清理 enable 符号链接。补“启用到一半失败”的反向用例。

## 5. [低中] “工具里写死上限数字就失败”的检查可被对象字面量绕过

文件：`scripts/check-multi-user-exec.mjs:5-6`、`scripts/operations/multi-user-exec/qualify-accounts.mjs:128-135`、`test/tooling/multi-user-exec.test.mjs:328-335`

问题：检查只匹配 `MemoryMax=数字` / `CPUQuota=数字` 这类 systemd 文本，不匹配 `{ MemoryMax: "2G" }`。同一被扫描目录里的 `qualify-accounts.mjs` 就写了硬编码上限，但检查照样通过，说明“写死数字就失败”的门槛比声称的弱。

证据：

```js
// check-multi-user-exec.mjs:5-6
export const LIMIT_DIRECTIVE =
  /\b(?:MemoryMax|MemoryHigh|MemoryMin|MemoryLow|MemorySwapMax|CPUQuota|CPUWeight|TasksMax|LimitNOFILE|IOWeight)\s*=\s*(?:[0-9]|infinity)/g;
```

```js
// qualify-accounts.mjs:128-135（不会触发上面的正则）
allPeople: { MemoryMax: "2G", MemoryHigh: "1G", CPUQuota: "100%", TasksMax: "10" },
person: {
  MemoryMax: "1G",
  MemoryHigh: "1G",
  CPUQuota: "50%",
  TasksMax: "5",
  LimitNOFILE: "64",
},
```

测试反向用例也只覆盖 `MemoryMax=2G` 和 `CPUQuota = 150%`（`test:328-335`）。

建议：增加 `"MemoryMax"\s*:\s*"[0-9]` / 对象字面量形式的匹配，或改为扫描渲染函数的输入常量；补一条对象字面量反向测试。若 `qualify` 的数字属于允许的测试配置，应在检查里显式排除该文件并说明理由。

## 6. [低中] `checkGatewayFiles` 不检查服务账号是否可读/可执行

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:242-256`、`scripts/operations/multi-user-exec/plan.mjs:321`

问题：检查只要求 root 所有、组/其他不可写；`gateway.entry` 只要求是普通文件，`gateway.node` 只要有任意执行位。root 所有、`0600` 的 entry，或 `0700` 的 node 都能通过，但服务以 `User=hx-slot` 运行，实际读不到/执行不了。

证据：

```js
// 242-254
const metadata = lstatSync(file);
if (
  !metadata.isFile() ||
  metadata.uid !== 0 ||
  (metadata.mode & 0o022) !== 0 ||
  (executable && (metadata.mode & 0o111) === 0)
)
  throw new Error(`EXEC_GATEWAY_FILE_UNSAFE ${file}`);
```

```js
// plan.mjs:321
`User=${user}`,
```

建议：要求 entry 至少对服务账号可读（如 `(mode & 0o444) !== 0`），node 至少对服务账号可执行（如对应权限位，或用 `access(2)` 以目标 UID 检查），并补测试。

## 7. [低] `--init` 残留检查只在账本文件不存在时执行

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:362-364`

问题：如果已存在一个空账本（或手工创建的空 `exec-slots.json`），`--init` 会跳过残留检查，直接走普通 `add`；同时 `--init` 在账本非空时也只是悄悄等同于 `add`。另外残留检查没有查 `hx-` 组、socket 文件或 enable 符号链接。

证据：

```js
const current = readLedger(options.ledger, options.command === "add" && options.init);
if (options.command === "add" && options.init && !existsSync(options.ledger))
  refuseInitOverResidue(options, config);
```

建议：`--init` 且账本槽位为空时也执行残留检查；账本非空时拒绝 `--init`（避免误用）；把 `hx-` 组纳入残留检查。补对应测试。

## 8. [低] `atomicWrite` 留下的临时单元文件不会被清理，也不会被残留检查发现

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:145-150, 220-222, 82`

问题：`atomicWrite` 用 `${file}.tmp-${pid}` + `wx`；进程在 rename 前崩溃会留下临时文件。`presentUnits` 只匹配 `known` 中的精确单元名，`OWN_UNIT` 也只匹配精确单元名，临时文件既不会被清理，也不会阻止 `--init`。如果之后 PID 复用，`wx` 还会因同名临时文件失败。

证据：

```js
// 145-150
const temporary = `${file}.tmp-${process.pid}`;
writeFileSync(temporary, content, { mode, flag: "wx" });
chmodSync(temporary, mode);
renameSync(temporary, file);
```

```js
// 220-222
function presentUnits(directory, known) {
  return existsSync(directory) ? readdirSync(directory).filter((name) => known.has(name)) : [];
}
```

建议：使用随机后缀；在 `converge` 入口清理本工具的 `*.tmp-*`；把 `himawari-exec-*.tmp-*` 纳入残留检查和 `presentUnits` 的清理范围。

## 9. [低] `retire` 在 rename 后 chown 失败时不可重入

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:266-275`

问题：先 `renameSync` 再 `setOwnerAndMode`。若 chown/chmod 失败，原路径已经不存在，下一次 `apply` 会因为 `existsSync(directory)` 为 false 而跳过，已改名的目录会保留执行账号属主，之后再也没有代码会修正它。

证据：

```js
const retired = `${directory}.removed-${stamp}`;
renameSync(directory, retired);
setOwnerAndMode(retired, 0, 0, 0o700);
```

建议：在 `apply` 开始时扫描根目录下的 `*.removed-*`，强制 `root:root 0700`；或改成可重入的“先记录、后修正”流程，并补 chown 失败的反向测试。

---

# 推测 / 需并发或环境条件

## 10. [中低] 失效锁接管存在 TOCTOU，可能删掉另一个进程刚建立的有效锁

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:110-120`

问题（推测，需要并发时序）：A 读到“旧锁 owner 已死”，在 A 执行 `rmSync(lock)` 之前，B 也可能删掉旧锁并创建自己的锁；A 随后按路径删除，会把 B 的锁删掉，于是 A、B 都进入临界区。`finally` 里无条件按路径删除也会放大这个问题。

证据：

```js
const owner = Number.parseInt(readFileSync(lock, "utf8"), 10);
...
if (alive) throw new Error(`EXEC_LOCKED ${lock} held by pid ${owner}`);
rmSync(lock, { force: true });
```

建议：使用内核文件锁（如 `flock`）或至少用 `fstat(held)` 与 `lstat(lock)` 比对 inode 后再删除；接管失效锁时先 `rename` 到唯一临时名并核对内容/ inode，再删除，避免按路径盲删。加并发测试较难，可至少做逻辑单测。

## 11. [低] 祖先目录是符号链接时，`realpath` 检查发生在修改之后

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:208-217, 298-301`

问题（推测/条件成立）：`O_NOFOLLOW` 只保护最后一级，父级符号链接会被跟随；而 `realpathSync(entry.path) !== entry.path` 的检查是在 `ensureDirectory`（可能已经 mkdir/chown/chmod）之后。因此配置写成带符号链接祖先的路径时，apply 会先改掉解析目标的属主/权限，再报 `EXEC_DIRECTORY_NOT_CANONICAL`。

证据：

```js
// 208-217
if (existsSync(entry.path)) {
  if (lstatSync(entry.path).isSymbolicLink() || !lstatSync(entry.path).isDirectory())
    throw new Error(`EXEC_DIRECTORY_NOT_PLAIN ${entry.path}`);
} else {
  mkdirSync(entry.path, { mode: 0o700 });
}
const uid = entry.owner === "root" ? 0 : ids(entry.owner).uid;
...
setOwnerAndMode(entry.path, uid, gid, Number.parseInt(entry.mode, 8));
```

```js
// 299-301
ensureDirectory(entry);
if (realpathSync(entry.path) !== entry.path)
  throw new Error(`EXEC_DIRECTORY_NOT_CANONICAL ${entry.path}`);
```

建议：在创建/改属主之前先对整条路径做 canonical 检查，或在 `parseExecConfig`/`plan` 阶段就拒绝含符号链接祖先的路径。只能配置root 信任的路径时风险较低，但“检查在修改之后”仍应调整顺序。

---

# 侧重检查

查过的路径与结论：

- **符号链接**：`ensureDirectory` 用 `lstatSync` + `openSync(O_NOFOLLOW|O_DIRECTORY)`（`exec-accounts.mjs:163-174, 208-218`），`retire` 先 `lstat` 再 `rename`（`258-275`），最后一级不可被用户换成符号链接。按设计父目录是 root:root `0755`（`plan.mjs:345-346`），执行账号不能替换自己的目录项。**最后一级安全；祖先符号链接见推测 11。**
- **目录竞争**：per-person 目录的父目录归 root、`0755`，执行账号无写权限，无法在 `mkdirSync`/`openSync` 之间插入目录项。**未发现可利用的目录竞争**；若配置把根目录放到可写目录则前提不成立。
- **`chown` 跟随**：`setOwnerAndMode` 用 `O_NOFOLLOW` 打开目录 fd 后 `fchown`/`fchmod`，不会跟随最后一级符号链接。**符合“不跟随用户可控符号链接”的要求。**
- **改名后的目录权限**：`retire` 改名后立即 `root:root 0700`；正常路径正确。chown 失败时不可重入，见证实 9。
- **失败回滚**：账本先落盘再收敛，失败后提示重跑；单元文件有备份/恢复。但账号、目录改名、tmpfiles、systemd enable/start 不在回滚范围内，见证实 4；这属于“部分收敛 + 重跑”设计，不是完整事务。
- **资源耗尽 / 不可撤销**：删除只做 rename，没有 `rm -rf` 用户目录；retired 目录和备份会持续增长（按计划留给后续 PR，不再展开）。空锁会卡死重跑，见证实 1。`useradd`、`usermod --lock`、目录 rename 都不可逆。
- **规则/说明与代码一致性**：
  - “锁文件记进程号并接管已死持有者”只对可解析的正整数 pid 成立；空/损坏锁不成立（证实 1）。
  - “只有主服务账号在 `himawari-people` 组里”没有校验（证实 3）。
  - “工具里写死上限数字就失败”只对 `Key=数字` 文本成立（证实 5）。
  - “init 残留检查改用精确单元名并查 `hx-` 账号”已实现（`exec-accounts.mjs:82, 89-97`），但漏了 `hx-` 组、socket 和 enable 符号链接（证实 7）。
  - “网关文件检查”已检查 root 属主和他人不可写，但未检查服务账号可读/可执行（证实 6）。

---

# 必答问题

## 1. 会不会改变模型已经见过的请求开头？

**不会。** 本改动的所有生产文件都在 `scripts/operations/multi-user-exec/`、`scripts/check-multi-user-exec.mjs`、测试和 `package.json`；`git diff --name-only` 中没有提示词组装、工具定义、历史或遮盖相关文件。`plan.mjs`/`exec-accounts.mjs` 只被工具测试、`qualify-accounts.mjs` 和检查脚本引用（grep 结果只有这些）。本工具不生成模型请求，因此不存在把每轮变化值放进系统提示或最后一条消息的问题。

结论：发给模型的内容与改动前一致，仍然只追加；本改动没有触碰这个不变量。整个请求组装链的其他部分本轮未审查，标“未核实”。

## 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会（就本改动而言）。** 这里没有模型请求文本。单元渲染依赖配置和账本数组顺序；`addSlot` 只追加、不重排，`Map` 的插入顺序固定，同一配置和账本会得到相同字节。备份目录名和 retired 目录名含时间戳/PID，但这些不进入模型请求。未发现依赖前后文的遮盖、时间字段或无序集合进入模型输入。

## 3. 有没有对应的自动检查，反向用例是否真的会失败？

**部分有。**

- 已覆盖：`parseExecConfig` 的缺项/未知项/路径/UID/上限/`peopleGroup: hx-`/socket 路径过长；账本缺失拒绝；slot/uid 不复用；单元内容。这些反向用例在 `test/tooling/multi-user-exec.test.mjs` 中，并且 `check:multi-user-exec` 已加入 `package.json:40` 和 `check:steps`（`package.json:27`）。
- 未自动覆盖：锁的接管、空/损坏锁、retire 顺序、`--init` 残留检查、`hx-` 账号、root 真实账号边界，只由 root 手工运行的 `qualify-accounts.mjs` 覆盖，不在 `npm run check` 中。因此上述“空锁卡死”“回滚不撤销 enable”“对象字面量绕过硬编码检查”都没有会失败的反向用例。
- 反向用例本身：新增的 socket 路径和 `peopleGroup: hx-andyaa` 用例确实会失败（值分别超过 107 字节 / 命中禁止正则），但对象字面量形式的硬编码上限不会失败。

## 4. 每个值，产生处和使用处两端都能接受吗？

逐个核对（只列本轮相关的）：

- **slot**：`SLOT_PATTERN`（`plan.mjs:3`）用于 `addSlot`、`parseLedger`、配置 `people` 键；`accountName` 生成 `hx-<slot>`；`OWN_UNIT` 用 `-[a-z][a-z0-9]{5}` 匹配单元名。三处一致。**通过。**
- **uid**：配置 `uid()` 限 `1000..2^31-2`；`parseLedger` 同范围且拒绝重复；`addSlot` 从 `uids.first` 找空位、不复用 removed；`converge` 只对 active 检查是否落在当前配置范围。removed 的 uid 即使超出当前配置也不会被使用。**通过。**
- **路径**：`absolute()` 拒绝相对路径、未规范化路径、空白/引号/反引号/`$`/`%`；private root 长度、socket 路径长度、根目录互不重叠、网关文件不得在个人路径；apply 再做 `realpath`。两端基本一致。**缺口**：`serviceAccount` 的 `hx-` 前缀未校验（证实 2）；祖先符号链接检查时机（推测 11）。
- **上限值**：配置正则校验 `SIZE/PERCENT/COUNT`、`MemoryHigh <= MemoryMax`、每人 `MemoryMax <= allPeople.MemoryMax`；slice 嵌套由 systemd 的 `himawari-exec-<slot>.slice` 命名自动成为 `himawari-exec.slice` 的子层；`LimitNOFILE` 放在 service 而不是 slice。**通过。**
- **`peopleGroup`**：`hx-` 前缀和等于 `serviceAccount` 已拒绝；但成员集合和既有特权组没有校验（证实 3）。**部分通过。**
- **网关文件**：root 属主、他人不可写；但没校验服务账号可读/可执行（证实 6）。**部分通过。**
- **tmpfiles.d**：`renderTmpfiles` 的路径/`0750 root <serviceAccount>` 与 `directoryPlan` 的 socket 目录一致；`systemd-tmpfiles --create` 使用同一个 `options.tmpfiles` 路径。**通过。**
- **单元名清单**：`knownUnitNames`、`renderUnits`、`OWN_UNIT`、`presentUnits` 对精确单元名一致；但 `*.tmp-*` 和 enable 符号链接不在清单内（证实 8、4）。**部分通过。**
- **锁文件**：写入 pid，使用处是 `acquireLock`；可解析且已死的 pid 能接管，空/损坏/写失败不能（证实 1）。**不通过。**

这就是 I-73 的教训：不能只看改动本身，要逐个找“谁产生、谁使用、两端接受什么”。本轮最明显的两端不一致是 `serviceAccount` 与 `hx-` 账号命名空间，以及锁文件格式与锁接管逻辑。
