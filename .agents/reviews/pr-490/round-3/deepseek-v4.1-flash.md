我先查看本次改动的范围，再逐一核对。
## 复核范围与资料限制

- 已看增量 `0343912af..07e621787`（round-3）和全量 `3cab570..07e621787`；只读代码，未运行测试，未改任何文件。
- `.agents/reviews/pr-490/round-1|round-2/judgments.md` 不在工作树里，`git show` 被环境拒绝（`REVIEW_GIT_REFUSED records-path`），因此「第 1/2 轮意见已处理」这一部分**未核实**。
- 作者说法逐条对照过，不一致处写在下面「作者说法核对」。

---

## 一、读代码证实的问题（按严重度）

### 1. 中高：锁文件残留后，add/apply/remove 永久失败，且没有恢复办法

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:319-342`

```js
const lock = `${options.ledger}.lock`;
try {
  held = openSync(lock, "wx", 0o600);
} catch {
  throw new Error(`EXEC_LOCKED ${lock}`);
}
...
} finally {
  closeSync(held);
  rmSync(lock, { force: true });
}
```

问题：这是纯 `O_EXCL` 锁文件，没有 PID、启动时间或 `flock`。进程被 SIGKILL、断电、或同步执行期间收到 SIGINT（`finally` 不会跑完）后，锁文件永远留着；之后所有 `add/apply/remove` 都只报 `EXEC_LOCKED /etc/himawari/exec-slots.json.lock`，没有 `--break-lock`、没有 stale 检测、没有文档说明要手工 `rm`。而 `converge` 的失败提示恰好是“修好后重跑 apply”，形成自相矛盾。另有次要问题：`/etc/himawari` 不存在时 `openSync` 的 ENOENT 也被伪装成 `EXEC_LOCKED`；`closeSync` 若抛错，`rmSync` 不会执行。

建议：改用 `flock`/`fcntl` 锁在 fd 上（进程退出自动释放），或锁文件写 PID+启动时间并支持 stale 接管；至少增加 `--break-lock` 和 runbook 恢复步骤，并把“目录不存在/无权限”与“已被锁”区分开。

### 2. 中高：账本先落盘，但多处校验在回滚 `try` 之外；失败看起来像“add 没成功”，且 `remove` 会被无关故障卡死

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:250-257`、`:330-337`

```js
function converge(options, config, ledger) {
  checkGatewayFiles(config);                       // 在 try 之外
  for (const entry of ledger.slots)
    if (entry.state === "active" && (entry.uid < config.uids.first || entry.uid > config.uids.last))
      throw new Error(`EXEC_LEDGER_UID_OUTSIDE_RANGE ${entry.slot}`);  // 在 try 之外
  const known = knownUnitNames(ledger);
  const backup = backupUnits(options, known);      // 在 try 之外
  try {
...
if (next !== current) atomicWrite(options.ledger, ...);  // 先写账本
converge(options, config, next);
```

问题一：`add` 先把 slot 写进账本，然后 `checkGatewayFiles`/uid 范围/`backupUnits` 在 `try` 之前抛错，调用者只看到裸 `EXEC_GATEWAY_FILE_UNSAFE`/`ENOENT`，没有 `EXEC_APPLY_INCOMPLETE ... run apply again` 提示。运维会以为 `add` 失败并重试，得到 `EXEC_SLOT_USED`，slot 已被永久占用（只能 `remove` 再换名）。

问题二：`remove` 的目的就是停单元、锁账号、改名目录，但 `converge` 先跑 `checkGatewayFiles` 和所有 active 槽的 uid 范围、`ensureAccount`。网关文件暂时缺失、别的槽 extra groups、或配置 uid 范围缩小，都会让 **无法移除某人**，也就是“撤权”操作被无关故障卡住。

建议：把 `checkGatewayFiles` 只放在“需要为 active 槽渲染单元”的分支；`remove` 先处理 retire，再做其余收敛；所有落账本后的异常统一附加 `EXEC_APPLY_INCOMPLETE ... run apply again`；或先校验再写账本。

### 3. 中：ADR 0234 要求的“每目录磁盘硬配额 + 总盘余量”完全没有实现，也没有配置项或检查

文件：`scripts/operations/multi-user-exec/plan.mjs:23-30`

```js
const PERSON_LIMITS = {
  MemoryMax: SIZE,
  MemoryHigh: SIZE,
  CPUQuota: PERCENT,
  TasksMax: COUNT,
  LimitNOFILE: COUNT,
};
const ALL_PEOPLE_LIMITS = { MemoryMax: SIZE, MemoryHigh: SIZE, CPUQuota: PERCENT, TasksMax: COUNT };
```

`docs/adr/0234-one-program-per-person-database-file.md:66` 明确写：“每人的目录有磁盘配额……磁盘配额必须做成硬上限，生产机文件系统做不到时不给别人开通……所有在用账号的配额之和（含恢复点、缓存、日志）必须低于可用磁盘并留安全余量”。本 PR 的配置、目录计划、slice、`qualify-accounts.mjs` 里都没有任何 quota/xfs project quota/总盘计算；grep 工具目录无 `quota|磁盘` 命中。作者“资源有硬上限”的说法只对 memory/CPU/tasks 成立，对 ADR 的磁盘硬上限不成立。

建议：要么在本 PR 明确标注“仅 cgroup 上限，磁盘配额留给后续 PR 且禁止上生产”，要么补上配额键、落地命令（`xfs_quota`/project quota）、每人和合计的只读测量与拒绝路径。

### 4. 中：`--init` 残留检查的前缀漏掉 `himawari-exec.slice`，又会把外来同前缀单元当成自己的

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:82-94`、`plan.mjs:5`

```js
...(existsSync(options.units)
  ? readdirSync(options.units)
      .filter((name) => name.startsWith("himawari-exec-"))
...
// plan.mjs:5
export const SLICE = "himawari-exec.slice";
```

`"himawari-exec.slice".startsWith("himawari-exec-")` 是 **false**（`exec` 后面是 `.`，不是 `-`）。所以这个工具每次 apply 都会写的共享 slice 不会被残留检查看到；反过来，`himawari-executor.service` 之类的外来单元会被误判成残留并拒绝 init。检查也没覆盖 socket 目录、tmpfiles 文件、已存在的执行账号/组。

建议：用 `knownUnitNames(emptyLedger())` 加精确的 `himawari-exec-<slot>.*` 组合，而不是裸前缀；同时检查 tmpfiles 路径、socketDirectory、`hx-*` 账号和 peopleGroup；外来单元不要当成残留。

### 5. 中：`--init` 残留检查会误拒合法的首次初始化，且账本丢失后没有恢复路径

文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:82-94`、`:238-245`

```js
const residue = [
  ...[config.privateRoots, config.workspaceRoots].flatMap((root) =>
    existsSync(root) ? readdirSync(root).map((name) => path.join(root, name)) : [],
  ),
...
if (residue.length > 0) throw new Error(`EXEC_INIT_OVER_EXISTING ${residue[0]}`);
```

只要配置的两个根下有任何条目就拒绝。以下几种都是合法或可恢复场景：迁移/接管已有部署时根目录已有内容；正常 `remove` 留下的 `<slot>.removed-<stamp>` 会永久存在（`:238-245` 只改名不删除），一旦账本损坏或丢失，`--init` 永远被退休目录挡住；没有 `--force`、没有“哪些是本人的/哪些是外来的”分类报告。再加上账本本身没有备份（只备份单元），账本丢失后只能手工删目录数据。

建议：区分本工具拥有的残留（`hx-` 账号、已知 unit 名、含标记文件的目录）与无关文件；提供 `--force` 或明确的 `--adopt` 流程；ledger 每次修改前留一份备份；把 `.removed-*` 排除在残留判定外。

### 6. 中：网关路径可以落在 `PrivateTmp`/`ProtectHome` 屏蔽的位置；`checkGatewayFiles` 也不检查父目录和可读性

文件：`plan.mjs:149-155`、`:320-327`；`exec-accounts.mjs:212-226`

```js
for (const [where, file] of [["$.gateway.node", node], ["$.gateway.entry", entry]])
  if (roots.some((root) => inside(file, root))) fail("EXEC_CONFIG_GATEWAY_IN_PERSON_PATH", where);
...
"PrivateTmp=yes",
"ProtectSystem=strict",
"ProtectHome=yes",
...
ReadWritePaths=${paths.privateRoot} ${paths.workspace}
```

配置只禁止网关文件落在三个根内，仍允许 `/tmp/...`、`/home/...`、`/root/...`。而单元启用 `PrivateTmp=yes`（服务看到新的 `/tmp`）和 `ProtectHome=yes`（`/home`、`/root`、`/run/user` 不可见），此时 `systemd-analyze verify` 仍会通过，但服务启动时找不到 node/entry 而失败。`checkGatewayFiles` 只 `lstat` 文件本身（root 所有、非组/其他可写、node 可执行），不检查父目录是否可被非特权用户替换，也不要求 `entry` 对执行账号可读（`0600 root` 也会通过）。另外这是 apply 时检查，文件之后仍可被换掉（TOCTOU）；`plan` 命令完全不检查。

建议：配置阶段拒绝 `/tmp`、`/home`、`/root`、`/run/user`、`/proc`、`/sys`，或为它们加 `BindReadOnlyPaths=`；检查每一级父目录 root 所有且不可被组/其他写；检查 entry 至少对 `User=` 可读；最好对网关文件做 hash/`open`+`fstat` 校验或由 root 只读目录托管。

### 7. 中：新增运行时逻辑没有自动检查；反向用例只覆盖旧逻辑；`qualify` 的 init 反向用例接受任何错误

文件：`test/tooling/multi-user-exec.test.mjs:93-97,156-160`（本轮只加了保留名和 uid 上限）、`qualify-accounts.mjs:139-168`、`package.json:40`

```js
// test 本轮新增的全部内容
[{ serviceAccount: "root" }, "EXEC_CONFIG_ACCOUNT_INVALID $.serviceAccount"],
[{ peopleGroup: "sudo" }, "EXEC_CONFIG_ACCOUNT_INVALID $.peopleGroup"],
...
it("refuses a ledger uid above the system range", ...)
```

```js
// qualify-accounts.mjs
let reinit = false;
try { exec("add", slots[0], "--init"); } catch { reinit = true; }
expectTrue(reinit && !existsSync(files.ledger), "INIT_OVER_EXISTING_ACCEPTED");
```

本轮新增的锁、`refuseInitOverResidue`、`O_NOFOLLOW`/目录 fd 改属主、`retire` 的 `is-active` 复核、`ensureGroup` 服务组检查，在 `test/tooling` 里 **没有一条自动用例**。唯一覆盖它们的是 `qualify-accounts.mjs`，而它：全仓仅被自身引用，不在 `check:steps`；用 `--without-systemd` 跑，所以 `retire` 的 `systemctl is-active` 分支完全没跑到；init 反向用例 `catch {}` 接受任何异常，如果失败原因是 `EXEC_SERVICE_GROUP_MISSING` 或 `EXEC_LOCKED` 也会“通过”。

另外扫描器只认 `Key=value`：

```js
// scripts/check-multi-user-exec.mjs:5-6
/\b(?:MemoryMax|...|IOWeight)\s*=\s*(?:[0-9]|infinity)/g
```

`qualify-accounts.mjs:128-135` 自己就用 `MemoryMax: "2G"`、`TasksMax: "5"` 这种对象字面量写死上限，扫描器看不到。也就是说“工具里写死上限数字就失败”对 `:` 形式不成立。

建议：导出 `refuseInitOverResidue`/锁辅助函数做非 root 单测；给 `retire` 用可注入的 systemctl 假命令单测；反向用例断言具体错误码；把扫描器扩展到 `MemoryMax: "2G"`/带引号键的形式；qualify 至少接入 CI 的 root job，或把关键分支抽成可测函数。

### 8. 中低：`socketDirectory` 没有长度校验，AF_UNIX 路径可能超过 108 字节

文件：`plan.mjs:122-124`、`:239-240`、`:286`

```js
const socketDirectory = absolute(raw.socketDirectory, "$.socketDirectory");
if (Buffer.byteLength(path.join(privateRoots, "a".repeat(6))) > PRIVATE_ROOT_MAX_BYTES)
  fail("EXEC_CONFIG_PRIVATE_ROOT_TOO_LONG", "$.privateRoots");
...
socket: path.join(config.socketDirectory, `${slot}.sock`),
...
`ListenStream=${paths.socket}`,
```

私有根有 27 字节上限，socket 路径却完全没有上限。配置可以合法通过 `parseExecConfig`，但 systemd 绑定 unix socket 时受 `sun_path` 约 108 字节限制，服务在启动时才失败；`plan` 和单元生成都会显示“成功”。这是典型的一端的值另一端不接受。

建议：按 `socketDirectory + "/" + slot + ".sock"` 计算字节数并拒绝超限（≤107 或 108，按平台），测试补一条边界用例。

### 9. 中低：备份目录每次 apply 新建且永不清理；退休目录也永久累积，和 ADR 的总盘余量要求冲突

文件：`exec-accounts.mjs:194-203`、`:238-245`

```js
function backupUnits(options, known) {
  const target = path.join(options.backups, `${new Date().toISOString()...}-${process.pid}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of presentUnits(options.units, known))
    copyFileSync(...);
  return target;
}
```

每次 `add/apply/remove` 都会在 `/var/backups/himawari-exec` 下留一个新目录，包含全部已知单元，没有保留期/上限；`apply` 因可重复执行而被鼓励反复跑，增长是线性的。退休目录按设计也不删。ADR 0234 明确要求“恢复点、缓存、日志”都算进总盘。没有测量，也没有拒绝路径。

建议：备份保留 N 份或按天轮转；退休目录归档策略（压缩/离线/统计）；在 `status` 或单独 `doctor` 里输出占用，并和磁盘警戒线比较。

### 10. 中低：回滚只覆盖单元文件；started socket/enable 链接、tmpfiles、目录、账号、账本都不回滚，`restoreUnits` 还可能掩盖原始错误

文件：`exec-accounts.mjs:205-210`、`:283-289`

```js
function restoreUnits(options, known, backup) {
  for (const name of presentUnits(options.units, known)) rmSync(...);
  for (const name of readdirSync(backup)) copyFileSync(...);
  if (options.systemd) quiet("systemctl", ["daemon-reload"]);
}
...
} catch (error) {
  restoreUnits(options, known, backup);
  ...
}
```

`systemctl enable --now` 会写 `sockets.target.wants/*` 并启动 socket/service；`presentUnits` 只看 `/etc/systemd/system` 顶层、只认已知单元文件名，回滚不会停已启动的 socket，也不会删 `.wants` 链接。若 `restoreUnits` 自己抛错（例如 `options.units` 目录不存在），原始错误和 `EXEC_APPLY_INCOMPLETE` 提示都会被替换掉。

建议：回滚时 `disable --now` 本轮启动过的槽、清理 `.wants`；对 `restoreUnits` 包 try/catch 并保留原始错误；明确文档化“只有单元文件会回滚，目录/账号/tmpfiles/账本是收敛式重试”。

### 11. 低：对配置根和 `<root>/<slot>` 无条件 chown/chmod/rename，不验证归属或专用性

文件：`exec-accounts.mjs:178-188`、`:238-245`；`plan.mjs:336-349`

```js
const uid = entry.owner === "root" ? 0 : ids(entry.owner).uid;
const gid = entry.group === "root" ? 0 : groupId(entry.group);
setOwnerAndMode(entry.path, uid, gid, Number.parseInt(entry.mode, 8));
...
renameSync(directory, retired);
setOwnerAndMode(retired, 0, 0, 0o700);
```

`absolute()` 只拒绝 `/`，不拒绝 `/etc`、`/usr`、`/var/lib` 等。配置写错（例如把 `privateRoots` 写成 `/etc`）时，工具会把整个目录 chown root:root、chmod 0755；`retire` 会把任意位于 `<root>/<slot>` 的目录改名并 root 所有。没有任何“这是专用目录/这是本工具创建的目录”的标记或属主校验。对于“误删不属于本工具的目录”的复查要求，这里只有单元名过滤，目录侧没有等价保护。

建议：要求根目录在允许前缀内（如 `/var/lib/himawari`、`/run/himawari`）；首次接管时要求根为空或只有 root 所有的预期条目；在每位目录里放一个含 slot/uid 的标记文件，`retire`/`ensureDirectory` 先校验标记和当前属主，再动手。

### 12. 低：`serviceAccount` 只查组不查用户；`peopleGroup` 未和 `accountName(slot)` 比对；保留名列表不完整

文件：`exec-accounts.mjs:146-154`、`plan.mjs:9-18`、`:288-289`

```js
if (!quiet("getent", ["group", config.serviceAccount]))
  throw new Error(`EXEC_SERVICE_GROUP_MISSING ${config.serviceAccount}`);
...
`SocketUser=${config.serviceAccount}`,
`SocketGroup=${config.serviceAccount}`,
```

`ensureGroup` 只保证组存在，单元还需要同名用户存在；只建了组没建用户时配置能通过、`plan` 能通过，服务启动才失败。`peopleGroup` 可以是任意合法名，包括某个执行账号自己的名字（`hx-<slot>`），那样该执行账号的主组就是 people 组，能读别人的工作区，违反“执行账号之间互相读不到”。`RESERVED_ACCOUNTS` 只排除了 root/sudo/wheel/adm/daemon/bin/sys/nobody，没有 docker/lxd/disk 等。

建议：校验 `id -u <serviceAccount>` 存在；校验 `peopleGroup` 和 `serviceAccount` 不等于任何 `accountName(slot)`；把保留名改成可维护的配置或至少覆盖常见的特权组；在 `plan` 阶段也做这些检查。

### 13. 低：`status` 报告的是账本意图，不是实际状态；`remove` 不可撤销且无预览

文件：`exec-accounts.mjs:292-302`、`plan.mjs:204-228`

```js
return ledger.slots.map((entry) => ({
  slot: entry.slot,
  uid: entry.uid,
  state: entry.state,
  ...
}));
```

`converge` 失败后账本里仍是 `removed`，但目录可能还没改名、账号可能还没锁；`status` 只显示 `removed`，不显示 `retire` 是否完成（源码里也没有这样的状态）。同时 `removeSlot` 一旦写入就永久 `removed`，`addSlot` 拒绝复用 slot/uid，没有 `unremove`/`--dry-run`/确认步骤；误删一个人是不可逆的。

建议：`status` 对 `removed` 槽额外输出目录是否存在、账号是否已锁；`remove` 增加 `plan`/`--dry-run` 或确认；文档写明不可逆及手工恢复步骤。

### 14. 低：没有 runbook/示例配置/错误码恢复说明

全仓除工具和测试外没有 `exec.json`/`exec-slots.json`/`EXEC_LOCKED` 的文档命中。这是一个 root 运行、会改 `/etc/systemd/system`、`/etc/tmpfiles.d`、用户目录和系统账号的工具，却没有任何操作说明；`--init`、锁、`remove` 的不可逆性、`EXEC_APPLY_INCOMPLETE` 的重试方式都只能读源码得知。

建议：在 `docs/runbooks/` 增加一页，包含示例配置、首次开通、日常 add/remove、锁恢复、失败重试、账本/备份位置和磁盘配额待办。

---

## 二、推测 / 未核实

- [推测] `NoNewPrivileges=yes`、`ProtectSystem=strict`、`PrivateTmp=yes` 可能影响 bwrap/SRT 子进程。代码里 bwrap 是以 PATH 中的 `bwrap` 启动、没有看到 setuid 包装，理论上用户命名空间仍可用；但没有在真实主机跑过，未核实。
- [推测] `systemd-tmpfiles --create` 会为 `socketDirectory` 自动补父目录；若不会，首次 apply 在 `/run/himawari` 不存在时会失败。未在主机验证。
- [推测] `systemd-analyze verify` 通过不代表运行期路径可见性、用户存在性、AF_UNIX 长度都满足；作者“verify 通过”的说法未核实（不能运行）。
- 作者说“40 条测试通过”“root 真实账号脚本通过”，未运行，**未核实**。
- 作者说“放宽工作区或私有根时脚本失败”：提交的 `qualify-accounts.mjs` 里没有找到任何“放宽后再检查应失败”的步骤；它只在正常 0700/2770 模式下断言跨账号访问被拒（`:170-198`）。这个反向验证**未体现在代码里**。
- 第 1/2 轮 judgments 未读到，所以无法确认上一轮意见是否真的都被处理。

---

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）

已检查并给出结论的路径：

- 错误路径：账本缺失 → 拒绝（`apply`/`remove`/`add` 无 `--init`），有测试（`multi-user-exec.test.mjs:287-299`）；账本 JSON 损坏 → 直接抛 `JSON.parse`/`EXEC_LEDGER_INVALID`，没有恢复命令；mid-converge 失败 → 只回滚单元文件；锁残留 → 无法恢复（发现 1）；pre-`try` 失败 → 账本已改但提示误导（发现 2）。
- 不可信/不合规输入：config 的路径/账号/限额校验整体扎实（拒绝 `/`、空白、引号、`$``%`、非规范路径，`ExecStart` 注入面小）；ledger 校验 slot/uid/state/唯一性，且写入 0600；但 `--ledger/--units/--backups/--tmpfiles` 的 CLI 路径未校验绝对性；socket 路径长度未校验（发现 8）；配置根可指向系统目录（发现 11）。
- 安全：最终目录用 `O_NOFOLLOW|O_DIRECTORY` 的 fd 做 `fchown`/`fchmod`，修复了 `lstat` 与 `chown` 之间的跟随窗口；`rename` 本身不跟随末级符号链接，末级替换会报 ELOOP；父目录均为 root 所有的前提成立时，执行账号不能替换槽目录项。未覆盖的是祖先符号链接、非专用根目录、网关文件父目录/可读性（发现 6、11）。
- 资源耗尽：备份无轮转（发现 9）；退休目录永久累积；锁文件残留（发现 1）；`atomicWrite` 崩溃残留未清理；账本本身很小。
- 不可逆操作：`remove` 永久标记 slot/uid、改名目录、锁账号，无撤销/预览（发现 13）；`--init` 在账本丢失时可能永久被残留挡住（发现 5）。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 与本次改动无关（未触碰提示词）；ADR 0234 的磁盘硬配额缺失（发现 3）；仓库里没有本工具的 runbook（发现 14）；`check:multi-user-exec` 已加入 `check:steps`，但 `qualify-accounts.mjs` 不在任何自动检查里（发现 7）。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（读代码证实）。** 本次 diff 只涉及 `scripts/operations/multi-user-exec/*`、`scripts/check-multi-user-exec.mjs`、`test/tooling/multi-user-exec.test.mjs`、`package.json` 和 `.agents/reviews/*`；没有碰系统提示、工具定义、历史消息、出口遮盖或请求组装代码。发给模型的内容仍然只由运行期（runtime-pi 等）组装，本工具产出的是 systemd 单元、目录、账号和账本，不在请求路径上。每轮会变的值（slot、uid、idleExitMs、控制根）只出现在单元文件和账本里，没有进入系统提示/工具定义。依据：`.claude/rules/prompt-prefix.md:4,28,35`。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**对模型请求：不会。** 本改动不参与压缩、遮盖或消息序列化。**对新产生的文件：几乎全部确定。** 账本用固定对象字面量键顺序 `{version, slots:{slot,uid,state}}` 序列化（`exec-accounts.mjs:336`），单元按 `Map`/对象插入顺序渲染，相同 config+ledger 会产生相同字节（`qualify-accounts.mjs:155-158` 也断言了两次 apply 单元文本一致）。不确定的值只有备份目录名和退休目录名里的 `new Date()`/pid（`exec-accounts.mjs:197,236`），它们不进入模型请求，也不影响单元内容。唯一需要留意的是：若 `exec.json` 的键顺序改变，`lines(config.allPeople)` 的输出顺序会变，单元字节会变——这也不是模型侧问题。

### 3. 有没有对应的自动检查，反向用例真的会失败？

**部分有，且新逻辑覆盖不足。**

- 有：`check:multi-user-exec` 已在 `check:steps`（`package.json:40`），跑扫描器 + `test/tooling/multi-user-exec.test.mjs`。反向用例确实会失败：写死上限的临时模板、低于/高于范围的 ledger uid、重复 uid、保留账号名、缺账本，都会让对应断言失败。
- 不足：本轮新增的锁、`--init` 残留、`O_NOFOLLOW`/目录句柄改属主、`retire` 的 `is-active` 复核、`ensureGroup` 服务组检查，**没有任何非 root 自动用例**；唯一覆盖它们的 `qualify-accounts.mjs` 不在 `check:steps`，且用 `--without-systemd` 跑，`retire` 分支不会执行。`qualify` 的 init 反向用例 `catch {}` 接受任何错误，不能证明是残留检查在起作用。扫描器只匹配 `Key=value`，`qualify-accounts.mjs:128-135` 用 `MemoryMax: "2G"` 就绕过了“禁止写死上限”的门槛。
- 作者“40 条测试通过”“root 脚本通过”未运行，**未核实**。

### 4. 每个新值两端是否都能接受？

逐个核对（产生处 → 使用处 → 两端校验）：

| 值 | 产生 | 使用 | 结论 |
|---|---|---|---|
| `slot` | CLI / `config.people` 键 | `accountName`/`sliceName`/`personPaths`/unit | 一致：`SLOT_PATTERN` 在三处（`plan.mjs:3,144,188,205`）都要求 6 位且无 `-`，正好保证 slice 父级 `himawari-exec.slice` 的命名推导 |
| `uid` | `addSlot`（`plan.mjs:204-215`） | `parseLedger`、`converge` 范围检查、`ensureAccount` | 一致：`MIN_UID`/`MAX_UID` 两端都用（`plan.mjs:68-72,188-196`；`exec-accounts.mjs:252-254`）；**缺口**：分配时没查 `/etc/passwd`，`useradd --uid` 可能因系统里已有该 uid 而失败 |
| `accountName(slot)` | `plan.mjs:230` | `ensureAccount`、目录 owner/group、unit `User/Group`、`usermod` | 一致（合法用户名）；**缺口**：`peopleGroup` 未与 `accountName` 比对 |
| 单元名 | `plan.mjs:231-233,352-361` | `presentUnits`/`backupUnits`/`retire`/`status` | 相互一致；**缺口**：残留检查用裸前缀 `himawari-exec-`，与 `himawari-exec.slice` 不一致（发现 4） |
| `privateRoot` | config（`plan.mjs:120`，27 字节检查 `:123`） | `personPaths`（`:237`）、`--control-root`（`:316`）、`ReadWritePaths`（`:327`）、gateway `realpath`（`job-host-gateway-main.ts:9`） | 一致；工具侧 `realpathSync` 检查在 `setOwnerAndMode` 之后（先改后查，低风险） |
| `socket` 路径 | `personPaths`（`:239`） | `ListenStream`（`:286`） | **不一致**：没有 AF_UNIX 108 字节校验（发现 8） |
| `gateway.node/entry` | config（`:149-150`） | `checkGatewayFiles`（`exec-accounts.mjs:212-226`）、`ExecStart`（`plan.mjs:316`） | **不一致**：允许 `/tmp`、`/home`、`/root`，但单元有 `PrivateTmp`/`ProtectHome`；不检查父目录和 entry 可读性（发现 6） |
| `serviceAccount` | `account()`（`:160`） | `ensureGroup`、`SocketUser/Group`、socket 目录 group、tmpfiles | **不一致**：只校验组存在，不校验用户存在 |
| `peopleGroup` | `account()`（`:161`） | `groupadd`、workspace group、qualify | 基本一致；**缺口**：不检查已有组内容、可与执行账号同名、保留名列表不全 |
| 限额 | `limits()`（`:74-85`） | slice/service 渲染、`memoryOrdered` | 一致；**缺口**：只做了 `MemoryMax` 跨层，`MemoryHigh` 允许高于 `allPeople.MemoryHigh`（父层先限流，子层设置不生效） |
| 账本 JSON | `atomicWrite`（`exec-accounts.mjs:336`） | `parseLedger`（`plan.mjs:178-202`） | 一致：`exactKeys` 只认 `version/slots/slot/uid/state`，顺序固定 |
| tmpfiles | `renderTmpfiles`（`plan.mjs:363-365`） | `atomicWrite` + `systemd-tmpfiles --create`（`exec-accounts.mjs:262-263`） | 语法一致；父目录是否由 tmpfiles 自动创建未核实 |
| `status` JSON | `exec-accounts.mjs:292-302` | 仅 `qualify`（`:221-226`） | 一致；`removed` 时 `socketActive` 从 `null` 变成 false，目前无其他消费者 |
| 错误码 | 各 `throw` 处 | CLI stderr、测试字符串、qualify | 测试有字符串断言；**qualify 的 init 反向用例不校验错误码**，无法区分残留拒绝和其他失败 |
| `--ledger/--units/--backups/--tmpfiles` | CLI | root 文件操作 | **两端不一致**：未要求绝对路径；相对路径按 cwd 解析，配置/运维错误时可能操作错误的目录 |

---

## 五、作者说法核对（不一致项汇总）

- “资源有硬上限”：只对 memory/CPU/tasks 成立，**没有 ADR 0234 要求的每目录磁盘硬配额和总盘余量**（发现 3）。
- “工具里写死上限数字就失败”：只匹配 `Key=value`，`MemoryMax: "2G"` 形式不失败（发现 7）。
- “root 真实账号脚本通过，放宽工作区或私有根时脚本失败”：提交的 `qualify-accounts.mjs` 没有“放宽后再断言失败”的步骤；它只验证正常权限下的拒绝（`:170-198`）。**未证实**。
- “--init 残留检查”：漏掉 `himawari-exec.slice`，并会误判外来 `himawari-exec-*`（发现 4）；会误拒含历史残留/退休目录的合法首启（发现 5）。
- “锁账号/remove 只改名不删除/不改发给模型的内容”：与代码一致。
- “40 条测试通过 / qualify 通过 / systemd-analyze verify 通过”：未运行，**未核实**。
- “第 1/2 轮意见处理见 judgments”：文件不可读，**未核实**。
