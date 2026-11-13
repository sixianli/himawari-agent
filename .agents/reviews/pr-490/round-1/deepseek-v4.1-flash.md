## 读代码证实的

### 1. 高 — 账本文件缺失会被当成“零人”，`apply` 会删掉所有人的单元并覆盖账本

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:73-75`、`:184-185`、`:197`

问题：`readLedger` 在账本不存在时直接返回空账本；随后 `apply` 按空账本渲染单元，并把 `units` 目录里所有不在渲染结果中的 `himawari-exec*` 文件删除，最后把空账本写回。误删、恢复不完整或 `--ledger` 写错时，一条命令就会把其他活跃用户的单元全部移除并丢失 slot/uid 映射（账号和 uid 实际仍被占用）。

证据：
```js
function readLedger(file) {
  return existsSync(file) ? parseLedger(readJson(file)) : emptyLedger();
}
...
for (const name of ownedUnits(options.units))
  if (!units.has(name)) rmSync(path.join(options.units, name));
...
atomicWrite(options.ledger, `${JSON.stringify(ledger, null, 2)}\n`, 0o600);
```

建议：账本缺失但 `units` 目录已有 `himawari-exec*`、或目录里已有 `hx-*` 账号时拒绝 `apply/add`；删除单元只允许删账本中已知 slot 对应的文件；如需初始化新账本要求显式 `--init`。

### 2. 高 — 失败回滚只恢复单元和账本，已建账号/目录不回滚；`remove` 的改名和锁号又发生在 `apply` 之前

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:177-202`、`:116-136`、`:205-220`、`:248-249`

问题：
- `apply` 在 `try` 里依次建组、建账号、建目录、写单元，失败时只调用 `restoreUnits` 并写回旧账本，不删除本次新建的账号和目录。
- `add` 的 uid 来自旧账本计算；若账号已建但账本没写成功，下次 `add` 仍会算出同一个 uid，`useradd --uid` 因 uid 已占用失败，工具会一直卡住，需手工清理。
- `remove` 先改名目录、锁账号，再调用 `apply`；如果 `apply`（甚至 `backupUnits`）失败，账本仍是 `active`，但目录已改名、账号已锁，重试 `apply` 会为这个人重新建空目录。

证据：
```js
const backup = backupUnits(options);
try {
  ensureGroup(config);
  for (const entry of ledger.slots) if (entry.state === "active") ensureAccount(entry);
  for (const entry of directoryPlan(config, ledger)) ensureDirectory(entry);
  ...
} catch (error) {
  restoreUnits(options, backup);
  if (previous) atomicWrite(options.ledger, `${JSON.stringify(previous, null, 2)}\n`, 0o600);
  throw error;
}
...
run("useradd", ["--uid", String(entry.uid), ...]);
...
renameSync(directory, `${directory}.removed-${stamp}`);
...
quiet("usermod", ["--lock", "--expiredate", "1", accountName(slot)]);
apply(options, config, next, ledger);
```

建议：用“待提交日志”记录本次将创建的账号/目录/改名，失败时按日志逆序清理；或先做全部只读预检，把账号和目录的创建放到单元验证之后。`remove` 应先写 journal 再改目录，或把改名后的新路径记录进账本，保证失败重试可恢复。

### 3. 中 — `idleExitMs` 两端校验范围不一致，配置能通过工具但网关拒绝启动

文件：`scripts/operations/multi-user-exec/plan.mjs:116`、`:287`；`packages/runtime-sandbox/src/job-host-gateway.ts:216`

问题：配置端只要求 `Number.isSafeInteger` 且大于 0；网关参数解析只接受 `^[1-9][0-9]{0,8}$`（最多 9 位）。例如 `idleExitMs: 10000000000` 能通过 `parseExecConfig`、写进 `ExecStart`，但网关启动时抛 `JOB_HOST_GATEWAY_IDLE_EXIT_INVALID`。`systemctl enable --now socket` 只启动 socket，不会立刻暴露服务启动失败，`apply` 仍会写入账本并报成功。

证据：
```js
if (!Number.isSafeInteger(gateway.idleExitMs) || gateway.idleExitMs <= 0)
  fail("EXEC_CONFIG_LIMIT_INVALID", "$.gateway.idleExitMs");
...
`ExecStart=... --idle-exit-ms ${config.gateway.idleExitMs} ...`
```
```ts
if (idle === undefined || !/^[1-9][0-9]{0,8}$/.test(idle))
  throw new Error("JOB_HOST_GATEWAY_IDLE_EXIT_INVALID");
```

建议：`parseExecConfig` 使用与网关完全相同的正则，或把上界常量共享到两端；补一条上界反向用例。

### 4. 中 — 账本里的 uid 没有按配置范围和最低值校验，产生处与使用处不一致

文件：`scripts/operations/multi-user-exec/plan.mjs:151-167`、`:54-57`、`:175-181`；`scripts/operations/multi-user-exec/exec-accounts.mjs:118-131`

问题：配置里的 `uids.first/last` 校验了 `1000..2^31-2`，`addSlot` 也只从该范围分配；但 `parseLedger` 只检查 `Number.isSafeInteger`，没有检查 `>= 1000`，也没有检查是否落在当前 `uids.first..uids.last` 内。账本被手工编辑或旧配置范围改变后，`uid: 0`、`uid: 700`、超出范围的 uid 都能通过解析，随后直接传给 `useradd --uid` 或用于与已有账号比较。这就是 I-73 那类“一个值只在一端认”的问题。

证据：
```js
function uid(value, where) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 2 ** 31 - 2)
    fail("EXEC_CONFIG_UID_INVALID", where);
...
!SLOT_PATTERN.test(item.slot) ||
!Number.isSafeInteger(item.uid) ||
!["active", "removed"].includes(item.state) ||
```
```js
run("useradd", ["--uid", String(entry.uid), ...]);
```

建议：`parseLedger` 增加 `uid >= 1000` 和 `uids.first <= uid <= uids.last`（或显式允许历史 uid 但单独校验），`ensureAccount` 再核对一次；补 `uid: 0` 和越界 uid 的反向用例。

### 5. 中 — `--control-root` 只做字面路径校验，网关要求 `realpath` 完全相同

文件：`scripts/operations/multi-user-exec/plan.mjs:37-47`、`:287`；`packages/runtime-sandbox/src/job-host-gateway-main.ts:9-11`

问题：工具只要求绝对、`path.resolve(value) === value`、无特殊字符；网关启动时还要求 `realpathSync(controlRoot) === controlRoot`。如果私有根路径的任一祖先目录是符号链接（工具只在 `ensureDirectory` 检查最终组件，不检查中间组件），`plan/apply` 会成功、账本也会写入，但网关第一次启动就退出。

证据：
```js
!path.isAbsolute(value) ||
path.resolve(value) !== value ||
value === "/" ||
/[\s"'\\$`%]/.test(value)
```
```ts
return (
  realpathSync(args.controlRoot) === args.controlRoot &&
  statSync(args.controlRoot).isDirectory()
);
```

建议：在 `apply` 建完目录后用 `realpathSync` 回读并与配置值比较，不一致就失败；`plan` 也应有同样的检查或明确说明只做字面计划。补一个“祖先为符号链接”的反向用例。

### 6. 中 — `/run` 下的 socket 目录只在 `apply` 时创建，单元里没有 tmpfiles/RuntimeDirectory

文件：`scripts/operations/multi-user-exec/plan.mjs:311`、`:257-267`；`test/tooling/multi-user-exec.test.mjs:26`

问题：`directoryPlan` 只把 `/run/himawari/exec` 作为一次性目录创建，生成的 socket 单元没有 `RuntimeDirectory=`、`DirectoryMode=` 或配套 tmpfiles.d。测试和常见配置使用 `/run`，重启后 tmpfs 清空；若 systemd 不会自动重建父目录，socket 单元启动失败；即使 systemd 自动重建，目录属主/权限也会回到默认值，而不是目录计划里的 `root:serviceAccount 0750`。两种结果都没有自动检查覆盖。

证据：
```js
files.set(socketName(slot), unit([
  ["Unit", [`Description=Job Host gateway socket for ${slot}`]],
  ["Socket", [
    `ListenStream=${paths.socket}`,
    "Accept=no",
    ...
```
```js
{ path: config.socketDirectory, owner: "root", group: config.serviceAccount, mode: "0750" },
```

建议：为 socket 目录提供 tmpfiles.d 条目（`d /run/himawari/exec 0750 root <serviceAccount> -`），或在单元里使用 systemd 的目录创建机制并验证重启后的属主/权限；加一条“目录不存在时启动 socket”的测试。

### 7. 中 — 反向检查没有覆盖 `scan()` 本身，且扫描不递归

文件：`scripts/check-multi-user-exec.mjs:15-24`；`test/tooling/multi-user-exec.test.mjs:230-244`

问题：反向用例只调用 `hardcodedLimits()` 测正则，没有构造临时仓库让 `scan()` 实际发现硬编码并返回问题；`scan()` 只对 `scripts/operations/multi-user-exec` 第一层文件调用 `readFileSync`，新增子目录或把模板放到别处不会被检查。因此“工具里写死上限数字就失败”只证明了正则，不证明实际文件扫描链路。

证据：
```js
for (const directory of SCANNED)
  for (const name of readdirSync(path.join(repository, directory)).sort()) {
    const file = path.join(directory, name);
    for (const found of hardcodedLimits(readFileSync(path.join(repository, file), "utf8")))
```
```js
it("catches a limit written into a unit template", () => {
  expect(hardcodedLimits('"MemoryMax=2G",\nTasksMax=@TASKS@\nMemorySwapMax=0')).toEqual([
    "MemoryMax=2",
  ]);
```

建议：测试里用 `mkdtempSync` 建临时仓库，写入带 `MemoryMax=2G` 的文件，断言 `scan()` 返回问题；扫描改为递归或显式文件清单。

### 8. 低 — `gateway.node` / `gateway.entry` 不验证存在、可执行和所有权

文件：`scripts/operations/multi-user-exec/plan.mjs:136-139`、`:287`

问题：两者只经过 `absolute()`，不检查文件是否存在、是否可执行、是否被执行账号可写。`systemd-analyze verify` 不会真正执行命令；`apply` 写账本成功、socket 也启用，但第一次连接时服务才因 `ExecStart` 失败。若把 entry 指到 `workspaceRoots` 这类本人可写目录，本人还能替换网关代码。

证据：
```js
gateway: Object.freeze({
  node: absolute(gateway.node, "$.gateway.node"),
  entry: absolute(gateway.entry, "$.gateway.entry"),
  idleExitMs: gateway.idleExitMs,
}),
```

建议：`apply` 前 `stat` 检查 node/entry 是普通文件且可执行，并拒绝位于 `privateRoots`/`workspaceRoots` 等本人可写路径下的入口。

### 9. 低 — `remove` 只改名和锁号，不删除目录/账号，与 ADR 0234 第 10 条不一致，且没有后续清理命令

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:205-220`；`docs/adr/0234-one-program-per-person-database-file.md:82`

问题：ADR 第 10 条要求“删目录和执行账号”；当前 `remove` 把目录改名为 `.removed-<时间>` 并锁账号，不做删除。作者在说法里也明确“remove 只改名不删除”。这可能是刻意的安全阶段，但工具没有提供后续彻底删除路径，`.removed-*` 目录会无限累积，已锁账号永久占用 uid，而账本又规定 uid 永不复用，长期会耗尽 uid 范围并占磁盘。

证据：
```js
renameSync(directory, `${directory}.removed-${stamp}`);
chownSync(`${directory}.removed-${stamp}`, 0, 0);
chmodSync(`${directory}.removed-${stamp}`, 0o700);
...
quiet("usermod", ["--lock", "--expiredate", "1", accountName(slot)]);
```

建议：明确这是“软删除”，另加受保护的 `purge` 步骤（校验 `.removed-*`、保留期、幂等、逐项核对），并在 ADR/运行手册里写清与第 10 条的对应关系。

### 10. 低 — `MemoryHigh ≤ MemoryMax` 只在同一层比较，跨层没有校验

文件：`scripts/operations/multi-user-exec/plan.mjs:77-80`、`:118-128`

问题：`memoryOrdered` 只比较同一个 `person` 或 `allPeople` 对象内部的值；没有检查 `person.MemoryHigh` 是否小于等于父 slice 的 `allPeople.MemoryMax`。例如 `person.MemoryHigh=1G`、`allPeople.MemoryMax=512M` 能通过校验，但该 `MemoryHigh` 在父层硬上限下没有实际意义。这不是安全漏洞，但和作者“MemoryHigh ≤ MemoryMax”的说法不完全一致。

证据：
```js
function memoryOrdered(set, where) {
  if (bytes(set.MemoryHigh) > bytes(set.MemoryMax))
    fail("EXEC_CONFIG_LIMIT_INVALID", `${where}.MemoryHigh`);
}
```

建议：增加跨层校验，或在文档里说明只保证同层有序。

## 推测 / 未核实

- 作者说“40 条工具测试通过”“root 真实账号脚本通过”“`systemd-analyze verify` 通过”，我都没有运行，**未核实**。从测试文件能数出 40 个用例，但执行结果未知。
- `/run` 目录在重启后 systemd 是否自动重建、重建后的属主/权限，**未核实**；需要实际重启或查本机 systemd 版本行为。
- `systemctl daemon-reload` 是否会把修改后的 slice 资源限制应用到已运行单元，**未核实**；但服务单元里的 `ExecStart`/`LimitNOFILE` 一定只在网关重新启动时生效，`apply` 不会重启已有网关。
- `NoNewPrivileges=yes`、`ProtectSystem=strict` 与 bwrap/SRT 的实际兼容性，**未核实**；代码里没有自动用例真正启动 systemd 单元。
- 生产实际 `exec.json` 的 `privateRoots`/`socketDirectory` 是否在 `/var`、`/run` 下，**未核实**；测试配置把 socket 放在 `/run/himawari/exec`。
- 若管理员把 `gateway.node`/`entry` 指向执行账号可写的位置，是否存在实际提权或伪造控制证据，**未核实**；这依赖主服务对网关帧的信任边界。

## 侧重检查

我查了这些错误路径、不可信输入、安全和不可逆操作：

- **符号链接**：`ensureDirectory` 用 `lstat` 拒绝最终组件是符号链接（`exec-accounts.mjs:138-144`）；`remove` 改名时也检查不是符号链接（`:213-214`）。但都是“先 lstat 再 chown/rename”，如果父目录可被不可信账号写，存在 TOCTOU；按当前 `directoryPlan`，父目录由 root 拥有且 0755，正常配置下不可利用。
- **`chown` 跟随**：`chownSync(entry.path, ...)` 会跟随最终组件；最终组件由 `lstat` 检查，但检查与 `chown` 之间有窗口。正常配置下父目录不可写，风险低；没有测试覆盖。
- **目录竞争**：`mkdirSync` 与 `chown/chmod` 之间只有 root 可访问，正常配置下没有可利用的竞争。
- **`rm -rf` 用户目录**：`exec-accounts.mjs` 只 `rmSync` 单元文件；`qualify-accounts.mjs` 的 `rmSync(base, { recursive: true })` 删的是自己生成的 `/tmp/hxq<random>`，不是用户目录。没有发现直接 `rm -rf` 用户工作区。
- **改名后的权限**：`.removed-*` 顶层目录被改为 `root:root 0700`（`:216-217`）；内部文件仍可能保留 `peopleGroup` 可读的旧权限，但顶层 0700 阻止按路径访问。已在 `qualify-accounts.mjs` 里验证不可达。
- **不可逆操作**：`apply` 删除未渲染单元（`:184-185`）和覆盖账本（`:197`）是不可逆的；账本缺失时尤其危险，见问题 1。`remove` 改名不删数据，但改名后没有清理命令，见问题 9。
- **不可信输入/注入**：slot/account 有严格正则；`ExecStart` 的路径拒绝空白、引号、反斜杠、`$`、反引号、`%`（`plan.mjs:37-45`），数值字段不拼接用户文本；没有发现 shell 注入。配置本身是 root 文件，但 `absolute()` 不做 realpath，见问题 5。
- **资源耗尽**：uid 永不复用 + 已锁账号永久占 uid + `.removed-*` 目录不删除，长期会耗尽 uid 和磁盘；`qualify-accounts.mjs` 有 60 秒超时，但生产工具没有资源用量/保留期检查。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 要求“只追加、会变的值放最后”，本次改动不涉及模型请求；ADR 0234 第 10 条与 `remove` 的“只改名不删除”存在差异，见问题 9。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本次 diff 只改了 `package.json`、`scripts/operations/multi-user-exec/*`、`scripts/check-multi-user-exec.mjs` 和 `test/tooling/multi-user-exec.test.mjs`，没有改系统提示、工具定义、历史消息、遮盖或任何模型请求组装代码。发给模型的内容没有新的追加逻辑，也不涉及“每轮变化的值”。按 `prompt-prefix.md#append-only` 的“只追加”规则，这次改动不需要触发换新。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会影响模型文本。工具内部生成的单元和账本有序列化问题：账本按插入顺序渲染，配置里的 `allPeople`/`person` 按 JSON 键顺序渲染，但这些不是发给模型的内容，不涉及 KV 缓存。若要求工具输出字节确定，建议对配置键和 slot 排序；目前不影响 prompt。

3. **有没有对应的自动检查？反向用例真的会失败吗？**
   有部分自动检查：`check:multi-user-exec` 已加入 `check:steps`，测试覆盖配置缺项/未知项/路径重叠/私有根过长/slot 非法/uid 重复/限制值非法，以及 `hardcodedLimits()` 的正反例。但关键反向用例不足：
   - `scan()` 本身没有“临时文件里写死上限则失败”的测试，只测了正则函数；
   - `exec-accounts.mjs` 的 `add/apply/remove` 没有自动测试，符号链接、回滚、账本缺失、`/run` 重启等路径都没有反向用例；
   - `idleExitMs` 只测了 0，没有测超网关正则上界；
   - `parseLedger` 没有测 uid 为 0/越界；
   - 没有测试 systemd 单元真正启动网关。
   因此“反向用例真的会失败”目前只能确认解析类字段，不能确认 root 工具和 systemd 路径。

4. **每个产生/修改的值，使用它的地方都能接受吗？**
   不全是。逐项核对如下：

   | 值 | 产生处 | 使用处 | 结论 |
   |---|---|---|---|
   | slot | `parseExecConfig`/`addSlot`/`parseLedger` 都用 `SLOT_PATTERN` | `accountName`、`personPaths`、单元名 | 两端一致，安全 |
   | uid | `config.uids` 校验 `1000..2^31-2`；`addSlot` 在范围内分配 | `parseLedger` 只校验 safe integer；`ensureAccount` 传给 `useradd` | **不一致，见问题 4** |
   | accountName | `hx-${slot}` | `useradd/usermod/User=/Group=` | 生成的名称合法；未禁止 `serviceAccount` 等于某个 `hx-*`，属配置信任问题 |
   | serviceAccount / peopleGroup | `ACCOUNT` 正则 | `groupadd/usermod/getent/SocketUser/SocketGroup` | 名称合法；serviceAccount 对应组是否存在未提前校验 |
   | privateRoot | `absolute()` + 长度 ≤27 | `mkdir/chown/chmod`、`--control-root`、`ReadWritePaths` | 字面校验通过；网关还要求 realpath，见问题 5 |
   | workspace | `absolute()` | `mkdir/chown/chmod`、`ReadWritePaths` | 字面校验通过；无额外长度校验 |
   | socket path | `personPaths` 拼接 | `ListenStream` | 没有 Unix socket 路径长度校验；`/run` 重启问题见问题 6 |
   | gateway.node / entry | `absolute()` | `ExecStart` | 不校验存在/可执行/所有权，见问题 8 |
   | idleExitMs | `parseExecConfig` safe integer >0 | 网关解析正则最多 9 位 | **不一致，见问题 3** |
   | Memory/CPU/Tasks 限制 | 配置正则 + `MemorySwapMax=0` 固定策略 | slice 单元 | 生成格式正确；跨层 MemoryHigh/Max 未校验，见问题 10 |
   | LimitNOFILE | 配置正则 | service 单元（不在 slice） | 位置正确；数值上界未与 systemd 实际能力核对 |
   | 单元名 | slot 派生 | systemd | 长度和字符安全 |
   | 账本 JSON | `JSON.stringify` 写 version/slots/slot/uid/state | `parseLedger` 的 `exactKeys` 和字段校验 | 读写格式一致；缺失账本的处理危险，见问题 1 |

总体结论：本次改动不触碰模型请求，prompt-prefix 方面没有风险；但 root 开通工具存在两个高危运维问题（账本缺失导致误删单元、失败回滚不完整），以及 uid、idleExitMs、control-root、`/run` 目录等两端校验/生命周期缺口，建议至少先修问题 1–5 再合入生产接线。
