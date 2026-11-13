# PR③a 第 2 轮复核（0343912 vs fc39208）

只读代码与 git 历史，未运行测试、未上机验证 systemd。以下按严重度排列。

## 读代码证实的发现

### 高 1｜`add --init` 绕过“账本缺失就拒绝”，会破坏“slot/uid 永不复用”，并可复活已删除账号
文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:274-277`、`scripts/operations/multi-user-exec/plan.mjs:191-202`

证据：
```js
const ledger = readLedger(
  options.ledger,
  ["plan", "status"].includes(options.command) || (options.command === "add" && options.init),
);
```
```js
export function addSlot(ledger, config, slot) {
  if (ledger.slots.some((entry) => entry.slot === slot)) fail("EXEC_SLOT_USED", slot);
  const used = new Set(ledger.slots.map((entry) => entry.uid));
  let next = config.uids.first;
```
`add --init` 在账本丢失时从空账本开始，于是：
- 可以重新 `add` 一个早已 `removed` 的 slot（空账本看不到墓碑）；
- 会从 `uids.first` 重新分配 uid，可能和仍存在的 `hx-<旧slot>` 账号同 uid；
- 若同名账号仍在（`remove` 只 `usermod --lock --expiredate 1`，不删账号），`ensureAccount` 只比对 uid 与附加组（`exec-accounts.mjs:123-143`），能通过；随后目录按原名重建、单元重写、`enable --now` 启动，**已“删除”的人被复活**。systemd 的 `User=` 不检查账号过期，锁账号不会阻止服务运行。

这直接和作者“slot 和 uid 永不复用”“账本缺失时拒绝”两条说法冲突：`plan`/`status` 也静默接受缺失账本（同 274-277 行），运维看到空 status 后更容易走 `--init`。

建议：`--init` 前确认不存在任何 `hx-*` 账号、`himawari-exec-*` 单元、私有根/工作区残留或备份；否则拒绝并要求人工恢复账本。`status`/`plan` 至少对缺账本给出明确警告或错误。

### 高 2｜改了配置后 `apply` 不会让新上限作用于正在运行的网关/slice
文件：`scripts/operations/multi-user-exec/exec-accounts.mjs:235-248`、`plan.mjs:252-265, 300-306`

证据：
```js
for (const [name, content] of units)
  atomicWrite(path.join(options.units, name), content, 0o644);
if (options.systemd) {
  run("systemd-analyze", [...]);
  run("systemctl", ["daemon-reload"]);
  for (const entry of ledger.slots)
    if (entry.state === "active") run("systemctl", ["enable", "--now", socketName(entry.slot)]);
}
```
代码事实：只重写单元、`daemon-reload`、`enable --now`，**没有 restart**。按 systemd 的已知行为（本机未实测，属推断），`daemon-reload` 不会给运行中的 unit/cgroup 重新应用 `MemoryMax`、`CPUQuota`、`LimitNOFILE`。因此调低某人上限后，只要该人的网关/Job Host 仍在跑（abususer 一直有任务时正是如此），旧上限继续生效；共享的 `himawari-exec.slice` 只要还有进程就不会重建，也不会拿到新值。网关空闲退出后才会偶然生效，这不能当作硬上限的收敛保证。

建议：对比新旧渲染结果，对变化的 service/slice 明确 `systemctl restart`（或 `systemctl stop` 后重建 slice），并在 `status` 中核对实际 cgroup 值与配置一致；至少把这个限制写进操作说明，不能声称“apply 可重复执行”就等于“上限已生效”。

### 中 3｜`retire` 吞掉停止失败，`status` 又对 removed 恒报 `socketActive: null`，删除可能静默失效
文件：`exec-accounts.mjs:196-200, 258-268`

证据：
```js
if (options.systemd) {
  quiet("systemctl", ["disable", "--now", socketName(slot)]);
  quiet("systemctl", ["stop", serviceName(slot)]);
}
```
```js
socketActive:
  entry.state === "active" && options.systemd
    ? quiet("systemctl", ["is-active", "--quiet", socketName(entry.slot)])
    : null,
```
`quiet` 把 disable/stop 的所有失败都当成功继续：随后改名目录、锁账号、`remove` 返回成功。若 stop 因 D-Bus/超时等真实原因失败，已删除的人的网关和监听 socket 可能仍在，而 `status` 对 removed 永远显示 `null`，运维看不出异常。这是删除/不可逆操作上不该静默的错误路径。

建议：stop 后查 `is-active`，仍活动就抛错并停止收敛；`status` 对 removed 也显示实际 active 状态。

### 中 4｜`chown`/`chmod` 跟随符号链接，`realpath` 检查在危险操作之后
文件：`exec-accounts.mjs:145-156, 203-210, 230-233`

证据：
```js
if (existsSync(entry.path)) {
  if (lstatSync(entry.path).isSymbolicLink() || !lstatSync(entry.path).isDirectory())
    throw new Error(`EXEC_DIRECTORY_NOT_PLAIN ${entry.path}`);
} else {
  mkdirSync(entry.path, { mode: 0o700 });
}
...
chownSync(entry.path, uid, gid);
chmodSync(entry.path, Number.parseInt(entry.mode, 8));
```
`lstat` 与 `chownSync`/`chmodSync` 之间有 TOCTOU 窗口，后两者跟随符号链接；`retire` 的 `chownSync(retired, 0, 0)`、`chmodSync(retired, 0o700)` 一样。新增的 `realpathSync(entry.path) !== entry.path` 在 `ensureDirectory` 之后才跑，只能“事后发现”，破坏已经发生。

可被利用性（推断）：默认布局中 `privateRoots`/`workspaceRoots` 由本工具建为 `root:root 0755`，执行账号不能替换其中的 `<slot>` 目录项，因此默认配置下难以利用；但只要配置把根放在某个非 root 可写的父目录下，就能用该 uid 把目录换成指向 `/etc/shadow` 的符号链接，让 root 把目标 chown 给执行账号。无论是否可立即利用，这违反作者“root 工具不得跟随用户可控的符号链接”的约束。

建议：以 `O_DIRECTORY|O_NOFOLLOW` 打开目录，用 `fchownSync`/`fchmodSync` 作用在 fd 上（或 `lchownSync`），并在任何变更前先做 canonical 校验。

### 中 5｜账本先落盘且无锁：失败或并发时账本与系统状态不一致，可能留下孤儿账号/单元
文件：`exec-accounts.mjs:286-293`

证据：
```js
const next = options.command === "add" ? addSlot(...) : options.command === "remove" ? removeSlot(...) : ledger;
if (next !== ledger) atomicWrite(options.ledger, `${JSON.stringify(next, null, 2)}\n`, 0o600);
converge(options, config, next);
```
- 失败的 `add`：账本已是 active，但账号/目录/单元可能没建成；失败的 `remove`：账本是 removed，但账号目录可能仍活动（依赖后续 `apply` 才修）。
- 两个 `add` 并发时都从同一账本读、都从 `uids.first` 分配，后写覆盖先写；落选方的账号和单元已建，却不在账本里，`knownUnitNames` 也不会覆盖它们，之后永不清理，形成孤儿账号/已启用单元。

建议：对“读账本—改账本—收敛”加 `flock`；把账本当作意图日志并在 `status` 里按实际系统核对；或先按系统实际状态生成/校验账本再收敛。

### 中 6｜第二轮的核心行为（重复 apply、剪枝边界）没有自动回归
文件：`test/tooling/multi-user-exec.test.mjs`、`scripts/operations/multi-user-exec/qualify-accounts.mjs:100-189`

现有自动测试只覆盖纯函数和“账本缺失即拒绝”。`converge`/`retire`/`presentUnits` 没有任何自动化用例；`qualify-accounts.mjs` 需要 root，且只跑 `add/add/remove/status`，**没有连续两次 `apply`，也没有旧 removed slot 再 apply 的场景**。因此“apply 可重复执行”“不会误删不属于本工具的单元”这两条本轮结论没有会失败的反向用例守着。反向用例方面，已读到的已有用例是有效的：递归扫描、跨层 MemoryMax、uid 下限、gateway 位于个人路径、idleExitMs 上限，去掉对应修复都会失败。

建议：把 `execFileSync` 注入成假 runner，在临时目录跑两次 `converge`，断言不产生第二个备份以外的任何变更；另建一个不在账本里的 `himawari-exec-*` 单元，断言不被删；再跑一次 `remove` 后的 `apply`。

### 低 7｜`parseLedger` 只校验 uid 下限，没有上限
文件：`plan.mjs:56-59` vs `plan.mjs:175-183`；`exec-accounts.mjs:218-220`

证据：配置 `uid()` 要求 `>= MIN_UID && <= 2**31-2`，账本只要求 `Number.isSafeInteger(item.uid) && item.uid >= MIN_UID`。active 条目会在 `converge` 再被 config 范围拦住，但 `plan`/`status` 会接受 `removed` 的超大 uid。两端校验不一致，属于作者声称“账本 uid 下限和范围”中的“范围”未补齐。

建议：`parseLedger` 也限制 `<= 2**31-2`（或统一导出 `MAX_UID` 两处共用）。

### 低 8｜备份与 `.removed-*` 目录无界增长
文件：`exec-accounts.mjs:162-171, 201-210`

每次 `apply/add/remove` 都新建一个 `backups/<时间>-<pid>`；每个 `remove` 的目录永久改名保留，没有任何清理入口。正常运维反复 `apply` 或长期删人会把 `/var/backups` 和私有/工作区根撑大。`remove` 只改名是设计选择，但缺少保留策略/清理说明仍是资源耗尽风险。

建议：只在内容实际变化时备份；为备份和 retired 目录定义保留期与清理命令，并写进操作说明。

### 低 9｜`serviceAccount` 被当作组名使用但从未校验；`ACCOUNT` 允许 `root`
文件：`plan.mjs:149, 253-255, 276, 327`；`exec-accounts.mjs:111-113`

`socketDirectory` 的 group、`SocketGroup=`、tmpfiles 的 group 都直接用 `config.serviceAccount`，但 `ensureGroup` 只保证 `peopleGroup` 存在。若主服务账号的主组不叫同名，`groupId(serviceAccount)`/`systemd-tmpfiles` 会失败；错误信息只是 `getent` 失败。另外 `ACCOUNT` 接受 `root`/`sudo`，配置笔误可把 socket 交给 root 或把主服务加进特权组。

建议：增加显式 `serviceGroup` 配置或在启动时校验同名组存在；对 `peopleGroup`/`serviceAccount` 加 `root` 等保留名黑名单。

### 低 10｜“写死上限就失败”的检查只覆盖 `Key=value` 形式
文件：`scripts/check-multi-user-exec.mjs:5-13`；`qualify-accounts.mjs:118-126`

正则是 `MemoryMax\s*=\s*(?:[0-9]|infinity)`，只匹配 systemd 指令文本；`qualify-accounts.mjs` 里其实写了 `MemoryMax: "2G"`、`LimitNOFILE: "64"` 这类 JSON 冒号形式，`scan(repository)` 仍返回 `[]`。作者“工具里写死上限数字就失败”的说法范围偏宽。这些是测试夹具，未必是问题，但检查的漏网形式应说清或补上。

### 低 11｜root 验证脚本的清理按可猜路径/名字删除
文件：`qualify-accounts.mjs:21-25, 52-58, 193-195`

`base = /tmp/hxq<6位hex>`，`finally` 无条件 `rmSync(base, {recursive:true, force:true})`，并按名字 `userdel`/`groupdel`。6 位 hex 可猜，若事先存在同名目录/账号，脚本可能在清理阶段删掉不属于它的资源；`mkdirSync(base)` 因 EEXIST 失败时也会走到 `finally`。这是测试脚本，但以 root 运行，仍建议 `mkdtempSync` 并先校验属主/内容。

## 推测 / 未核实
- `daemon-reload` 不重新应用运行中 cgroup 资源限制：代码事实是只 reload/不 restart；“不生效”属 systemd 已知行为，本次未上机验证。
- `systemd-tmpfiles --create` 是否会创建 `/run/himawari` 父目录：未核实。仓库里没有其他创建 `/run/himawari` 的地方，若 tmpfiles 不建父目录，重启后 socket 单元会因目录不存在而启动失败。
- `NoNewPrivileges=yes` + `ProtectSystem=strict` + `PrivateTmp=yes` 下 bwrap/SRT 能否正常跑：从 `bwrap-read-only-tmpfs.ts` 看使用的是 `--unshare-user` 的非 setuid bwrap，理论上不受 NNP 阻挡；未运行验证。
- `systemd-analyze verify` 通过、40 条测试通过、真实账号脚本通过：本次无法运行，未核实。
- 主服务账号的主组是否与账号同名：代码没有保证，属部署前提，未核实。

## 侧重检查
- 符号链接/目录竞争：`ensureDirectory` 与 `retire` 都是 lstat 后 chown/chmod，存在 TOCTOU 且跟随链接；`realpath` 在变更之后（见中 4）。
- `chown` 跟随：是，两处。
- 改名后目录权限：`rename` 后 `chown 0:0`、`chmod 0700`，父目录 root 0755，执行账号无法再次进入；这一条我核对为正确。
- 失败回滚：只回滚单元；账号、目录、tmpfiles、retire 改名都不回滚，账本保留。设计上靠“再跑 apply”恢复，但失败后 `status` 与真实状态可能不符（见中 3、中 5）。
- 单元可运行性：socket activation 的 fd 3 与 `parseJobHostGatewayArgs` 的 `LISTEN_PID/LISTEN_FDS` 分支一致；`--idle-exit-ms` 两端正则完全一致（`plan.mjs:7` 与 `job-host-gateway.ts:216`）；`--control-root` 两端都要求 canonical（`exec-accounts.mjs:232-233`、`job-host-gateway-main.ts:9`）；`LimitNOFILE` 在 `[Service]` 位置正确；`OOMPolicy=kill` 合法；slice 命名层级正确。
- 上限生效：渲染层正确，运行中单元不重载（见高 2）。
- slot/uid/账号名/路径两端：slot→账号/单元/目录名一致；uid 下限一致、上限不一致（见低 7）；`serviceAccount` 组名假设未校验（低 9）。
- 不可逆操作：remove 只改名不删除、锁账号，本身符合设计；但 `--init` 可复活（高 1），retired/备份无清理（低 8）。
- 安全/资源：配置文件与账本没有校验属主/权限；若 `/etc/himawari` 被非 root 写，root 会按注入的路径 chown/chmod、按注入的 slot 建账号或标记 removed。默认 0600/root 下风险有限，未核实部署前提。
- 规则/文档一致性：本改动不碰模型请求；`exec.json` 的 schema 没有仓库内说明，只有 `plan.mjs` 的校验；`check:multi-user-exec` 的覆盖窄于作者表述（低 10）。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？是否只在末尾追加、每轮变的值都在最后一条消息？**
不会。改动只涉及 `scripts/operations/multi-user-exec/*`、`scripts/check-multi-user-exec.mjs`、测试和 `package.json`（`git diff --stat`），没有触碰系统提示、工具定义、历史、遮盖或请求组装。不存在向模型内容追加任何东西；因此也不涉及“每轮变的值放最后一条消息”。依据 `prompt-prefix.md` 第 4 条，本改动对缓存字节无影响。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
对模型请求不会，因为本改动不产生模型可见文本。工具自身产物有两种非确定性：单元文件里配置键的顺序取决于 `exec.json` 的键顺序（`Object.entries`），备份/retired 目录名含时间戳和 pid；但这些只落在文件系统，不进入请求，不违反字节确定性规则。若以后要对生成的单元做清单/哈希，需要先把键顺序固定。

**3. 有没有自动检查，反向用例真会失败吗？**
有：`check:multi-user-exec` 已接入 `check:steps`（`package.json:27,40`），包含单元测试和“写死上限”扫描。已读到的反向用例是有效的：递归扫描（不递归就找不到 templates/person.slice）、跨层 MemoryMax、uid 下限、gateway 位于个人路径、idleExitMs 上限、账本缺失拒绝——去掉对应修复都会失败。缺口是：重复 `apply`/`retire`/`presentUnits` 剪枝边界没有任何自动用例，`qualify-accounts.mjs` 是 root-only 且不重跑 apply；扫描也漏掉 JSON 冒号形式的写死数字（低 10）。所以本轮标题行为没有被门槛守住。

**4. 每个新值两端都能接受吗？**
逐个核对结果：
- `idleExitMs`：`plan.mjs:7,124` 与 `job-host-gateway.ts:216` 同一正则（1–9 位、非 0），一致。
- `controlRoot`：`exec-accounts.mjs:232-233` 与 `job-host-gateway-main.ts:9` 都要求 `realpath === 路径` 且是目录，一致。
- `gateway.node/entry`：配置层禁止落在个人可写根内（`plan.mjs:137-143`），运行时再查 root 属主/不可组写/可执行，`ExecStart` 使用同样路径，一致。
- slot→账号/单元/目录名：`hx-<slot>`、`himawari-exec-<slot>.*` 由同一映射生成；`addSlot` 拒绝已用 slot；剪枝用 `knownUnitNames` 精确匹配，不会按前缀误删无关单元（但不在账本里的孤儿单元也永远不会被清）。
- uid：配置 `1000..2^31-2`，账本只有下限，`plan/status` 可接受超上限的 removed uid（低 7）；active 在 `converge` 才补范围检查。
- `serviceAccount`：被 `SocketUser/SocketGroup`、tmpfiles、目录组共用，但从未验证同名组存在，也未禁止 `root`（低 9）。
- tmpfiles 与目录计划：`0750 root serviceAccount` 两边一致；目录实际由 `directoryPlan` 再校正。
- 工作区：`2770` + setgid + `UMask=0007` 与 `qualify-accounts.mjs` 对文件 0660/组 `himawari-people` 的断言一致；执行账号只在自己的组，读不到别人。
- 账本 schema：`version/slots/slot/uid/state` 的产出（`addSlot/removeSlot`）与 `parseLedger` 的校验一致。

总体：第一轮加的这些纯函数/两端校验大多对得上；仍有两处典型 I-73 式不一致——账本 uid 上限（低 7）和 `serviceAccount` 作为组名的隐式假设（低 9）；以及运行中上限不收敛（高 2）和 `--init` 复用（高 1）这两个会影响实际安全的收敛问题。
