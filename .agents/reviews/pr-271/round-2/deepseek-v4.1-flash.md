## 结论

本轮增量（91776732..831db506）只改了两个测试文件的断言，**没有发现会改变生产行为的高严重度缺陷**；D2、G2 两条修复的方向和代码一致，互换常量确实会被新断言挡住。剩下的是测试健壮性与覆盖缺口（中/低），以及一个不在本轮增量、但被 `check:steps` 接线放大的 macOS 可移植性问题。

---

## 问题（按严重度）

### 中：新断言只核对了 `run-step.py`，没有核对同一动作的另外两个使用点

- 文件:行：`scripts/delivery-mode/test_rollback.py:135-138`；使用点 `scripts/delivery-mode/packet-template/maintenance/run-maintenance.mjs:20`、`.../maintenance/run-user-maintenance.sh:6`
- 问题：`S9_RAW_RESTORE51` 这个值除了 `run-step.py` 的 `MAINTENANCE_ACTIONS` 和 `command_for`，还被 `run-maintenance.mjs` 的 `actions` 集合和 `run-user-maintenance.sh` 的白名单接受。新测试只要求“恢复动作在 `run-step.py` 的 `MAINTENANCE_ACTIONS` 里、控制动作不在”，没有核对后两处。若有人只改 `run-maintenance.mjs` 或 `run-user-maintenance.sh` 而漏改 `run-step.py`，新测试仍通过，但真实回退会在运行时被 `run-maintenance.mjs` 拒绝（`MAINTENANCE_ARGUMENT_INVALID`）。
- 证据（我读到的代码）：
  - `test_rollback.py:135` 只解析 `step_table`（即渲染后的 `steps/run-step.py`）：
    `maintenance = set(re.findall(r"'(S[0-9]+_[A-Z0-9_]+)'", re.search(r'^MAINTENANCE_ACTIONS = \{([^}]*)\}', step_table, re.M).group(1)))`
  - `run-maintenance.mjs:20` 有一份独立集合：
    `const actions = new Set(["S3_COPY51", "S7_DB_STATUS", "S7_CONFIG_APPLY", "S7_CATALOG_UPGRADE", "S8_READBACK", "S9_SIDECAR_TIDY", "S9_RAW_RESTORE51"]);`
  - `run-user-maintenance.sh:6` 又有第三份白名单：
    `S3_COPY51|S7_DB_STATUS|S7_CONFIG_APPLY|S7_CATALOG_UPGRADE|S8_READBACK|S9_SIDECAR_TIDY|S9_RAW_RESTORE51) ;;`
  - 另外 `S9-control-files.py:296` 硬编码要求参数是 `S9_RAW_RESTORE51`：`require(len(sys.argv) == 2 and sys.argv[1] == 'S9_RAW_RESTORE51' ...)`，新测试没有把控制动作的命令和目标脚本的硬编码要求关联起来。
- 建议：在 `PlanTest` 里同时读取 `maintenance/run-maintenance.mjs` 的 `actions` 集合和 `run-user-maintenance.sh` 的 case 分支，断言恢复动作在三处都存在；或抽出模板里唯一的一份动作表，让 `run-step.py`、`run-maintenance.mjs`、`run-user-maintenance.sh` 都引用它。另可断言 `command_for('S9_RAW_CONTROL51')` 指向 `S9-control-files.py` 且参数是恢复动作。

### 低：`re.search(...).group(1)` 未检查 `None`，模板格式变化时是 `AttributeError` 而不是清楚的断言失败

- 文件:行：`scripts/delivery-mode/test_rollback.py:135`
- 问题：作者担心“模板格式稍有变化就 `AttributeError`”是成立的，但例子需要更正：
  - **改成多行 `{ ... }` 不会失败**：`[^}]*` 是否定字符类，默认能跨行，仍然匹配。
  - **换成元组 `('S3_COPY51', ...)`、`set([...])`、加类型注解 `MAINTENANCE_ACTIONS: set[str] = {...}`、改名、或把赋值缩进到类/函数里**，`re.search` 返回 `None`，`.group(1)` 直接抛 `AttributeError`，失败信息不指向“动作表格式变了”。
- 证据：`scripts/delivery-mode/packet-template/steps/run-step.py:19` 当前是单行：
  `MAINTENANCE_ACTIONS = {'S3_COPY51', 'S7_DB_STATUS', 'S7_CONFIG_APPLY', 'S7_CATALOG_UPGRADE', 'S8_READBACK', 'S9_SIDECAR_TIDY', 'S9_RAW_RESTORE51'}`
  测试却直接 `.group(1)`，没有 `assertIsNotNone`。
- 建议：先 `match = re.search(...)`，再 `self.assertIsNotNone(match, "MAINTENANCE_ACTIONS 未找到或格式已变")`；更稳的做法是用 `ast.parse` 找到 `MAINTENANCE_ACTIONS` 赋值并用 `ast.literal_eval` 取值（可接受 set/tuple/list），或直接 `importlib` 加载渲染后的 `run-step.py` 读属性（该模块顶层只定义常量和函数，不执行 `main()`）。

### 低：控制动作命令的正则过严，恢复动作必须恰好在列表最后一个元素

- 文件:行：`scripts/delivery-mode/test_rollback.py:138`
- 问题：当前断言要求 `'S9_RAW_CONTROL51': [ ... 'S9_RAW_RESTORE51']`，即恢复动作是命令列表的**最后一个元素**。如果以后给这条命令加一个尾部参数（例如 `'S9_RAW_RESTORE51', '--some-flag'`），恢复动作仍然“作为参数”传入，但测试会失败。作者说的“控制动作那一行命令把恢复动作作为参数”比代码实际断言的范围略宽。
- 证据：`scripts/delivery-mode/packet-template/steps/run-step.py:36` 当前是：
  `'S9_RAW_CONTROL51': ['/usr/bin/python3', '-I', str(operations / 'maintenance/S9-control-files.py'), 'S9_RAW_RESTORE51'],`
  测试的正则以 `'S9_RAW_RESTORE51'\]` 结尾，强制它是最后一项。
- 建议：改成“包含该参数”而不是“最后一项”，例如只断言 `'S9_RAW_CONTROL51'` 的列表里出现 `'S9_RAW_RESTORE51'`，并把“指向 `S9-control-files.py`”单独断言；或者用 `ast` 解析 `commands` 字典后按列表包含关系断言。

### 低（不在本轮增量，第 1 轮引入）：`check:delivery-cleanup` 把 Linux 专用测试接进了通用的 `npm run check`

- 文件:行：`package.json:41-45`（第 1 轮加入）、`scripts/delivery-mode/test_release_cleanup.py:403`
- 问题：`test_release_cleanup.py` 的 `StaleTransportTest` 无条件读 `/proc/<pid>/cmdline`，macOS 上没有 `/proc`，会以 `FileNotFoundError` 失败。现在它被 `check:steps` 接进 `npm run check`，在 Mac 上本地跑整条 check 会失败。作者只在 Hermes（Linux）上验证，未验证 macOS。
- 证据：
  - `package.json:44`：`"check:delivery-cleanup": "python3 -I scripts/delivery-mode/test_release_cleanup.py"`
  - `test_release_cleanup.py:403`：`while time.monotonic() < deadline and flag.encode() not in Path('/proc/%d/cmdline' % process.pid).read_bytes():`
  - `AGENTS.md:7` 说明 CI 在 Hermes 自托管 runner 上跑、macOS 检查暂停；但这不等于 Mac 开发者跑本地 `npm run check` 不会踩到。
- 建议：若 `npm run check` 需要在 macOS 上可跑，给 `StaleTransportTest` 加 `@unittest.skipUnless(sys.platform == 'linux', ...)`，或在 `npm run check` 里按平台跳过该步骤；若团队明确只在 Hermes/Linux 跑整条 check，应在文档里写清，避免 Mac 本地误跑。

---

## 侧重检查

- **错误路径**：重点看了新测试的解析失败路径（`re.search` 的 `None`、`S0_READBACK` 的 `KeyError`）。前者见上；后者是 `test_rollback.py:53` 的 `return S0_READBACK[value.removeprefix('S0_DB:')]`，当前模板的 12 个 `S0_DB:` 键与 `S0_READBACK` 的 12 个键完全对应，但未来模板新增 `S0_DB:` 字段时会抛 `KeyError`，不是清楚的测试失败（第 1 轮引入，不在本轮增量）。
- **不合规范/不可信输入**：测试只读仓库内的模板和 `fixtures/twelfth-parameters.json`，不解析外部输入，不连网；`packet_from_template` 写在 `tempfile.TemporaryDirectory()` 下，未发现从不受信路径读取或写入的风险。
- **安全**：`check:delivery-*` 都是本地测试命令，`test_generated_approval_passes_the_packet_maintenance_check` 用 `subprocess.run([...])` 以参数数组传 Node 脚本和 JSON，没有 shell 拼接；`test_deploy.py` 用临时目录里的假 `ssh` 注入 PATH，不会连生产。未发现新增的注入面。
- **资源耗尽**：`test_release_cleanup.py` 每个用例会建多个 1 MiB / 11 MiB 的临时文件，清理脚本只保留若干份；`test_deploy.py` 用 `sleep 60` 的进程并在 cleanup 里 kill。都是临时目录、串行、可回收；未发现无限循环或无限增长。`assertRegex` 的 `[^\]]*` 是线性的，不存在 ReDoS。
- **不可撤销操作**：新增测试只操作临时目录和假服务；`make-packet.render` 也只写临时包。未发现会触碰生产路径、删除真实数据或执行真实 SSH 的改动。
- **规则/文档与代码一致性**：核对作者说法：5 个交付步骤“命令正好是 `python3 -I scripts/delivery-mode/<文件>`”与 `test/tooling/run-all-checks.test.mjs:54-62` 一致；G2 的两条新增断言与代码一致。`docs/lessons.md:690`、`docs/engineering-casebook.md:1274` 仍只描述旧版“步骤在步骤表里”，没有描述新增的 `MAINTENANCE_ACTIONS`/控制命令断言，但不算矛盾，属于文档未同步。作者的“多行会 `AttributeError`”不准确，见上。

### 读代码证实的

- 增量的两个文件只有断言变化：`test_rollback.py` 增加 `MAINTENANCE_ACTIONS` 断言和控制命令正则；`run-all-checks.test.mjs` 增加 5 个步骤的精确命令断言。
- 互换 `rollback.py:11-12` 的 `RESTORE_ACTION`/`CONTROL_ACTION` 后：旧测试只要求两者都在 `run-step.py` 的全部 S 字符串里，互换后仍成立，所以旧测试通过；新测试的 `assertIn(restore, maintenance)` 会失败，所以新测试能抓住。
- `check:delivery-rollback` 改成 `"true"` 时，`run-all-checks.test.mjs:62` 的 `toBe(...)` 会失败，`check:check-runner` 失败。
- `package.json` 新增的 5 个脚本名都被 `scripts/run-all-checks.mjs:32` 的 `stepNames` 和 `spawnSync` 正常消费；5 个 `.py` 文件都实际存在且都有 `unittest.main()` 入口。
- 本改动没有触碰任何模型请求组装代码；grep `check:steps` 只命中 `package.json`、`scripts/run-all-checks.mjs`、`test/tooling/run-all-checks.test.mjs`。

### 推测

- 作者在 Hermes 上“正向全过、`npm run check` 39 步全过”我无法实际运行，**未核实**。
- 若允许 Mac 开发者本地跑 `npm run check`，`test_release_cleanup.py` 的 `/proc` 依赖会导致失败；若团队约定只在 Hermes/Linux 跑，则只是文档未写清，风险较低。**未核实**团队的本地运行约定。
- 若未来有人把 `MAINTENANCE_ACTIONS`、控制命令、`run-maintenance.mjs` 的 `actions` 集合**一起**改成“控制动作走维护入口”，新测试仍可能通过，但运行时 `run-maintenance.mjs` 的独立集合若没同步就会失败；这是“多使用点未逐一核对”的推测场景，当前代码三处一致。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 本次 diff 只涉及 `.agents/reviews/*`（评审记录）、`package.json` 的 check 脚本、`scripts/delivery-mode/test_rollback.py`、`test/tooling/run-all-checks.test.mjs`。没有改系统提示、工具定义、历史消息、遮盖实现或任何请求组装代码。`check:steps` 只被 `scripts/run-all-checks.mjs:32` 读取并用于 `npm run`，不会进入模型请求。因此“发给模型的内容只在末尾追加、每轮变化的值都在最后一条消息里”这一性质没有被触碰。至于整个模型请求组装是否正确，我只确认了本次改动不在那条路径上；其余代码**未核实**。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 没有生产序列化/遮盖/时间字段改动。测试里新增的 `json.dumps(with_s0_readback(draft))` 只写临时 `bindings.json`，不发给模型；其键顺序来自模板解析顺序，本身也是确定的。`tempfile` 路径每次不同，但只存在于测试本地，不进入模型内容。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，且方向正确。** `check:delivery-rollback` 会运行 `test_rollback.py` 的新断言；`check:check-runner` 会运行 `run-all-checks.test.mjs` 的精确命令断言。反向用例：
- 互换 `rollback.py` 的两个常量：新测试的 `assertIn(restore, maintenance)` 必然失败；旧测试仍通过——这一点由代码逻辑可证实，作者在 Hermes 的实际运行**未核实**。
- 把 `check:delivery-rollback` 改成 `"true"`：`toBe` 断言失败，`check:check-runner` 失败——代码可证实。
- 不足：这两个反向用例是**手工验证**，仓库里没有把它们固化成自动反向测试；另外第 1 条覆盖缺口（`run-maintenance.mjs`/`run-user-maintenance.sh`）没有自动检查。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐项核对：

- **新增脚本名/命令**（`check:delivery-deploy`、`check:delivery-rollback`、`check:delivery-cleanup`、`check:untested-claims`）：产生于 `package.json:41-45`；使用于 `scripts/run-all-checks.mjs:32` 的 `stepNames` + `spawnSync`，以及 `test/tooling/run-all-checks.test.mjs:54-65`。两端的校验都接受：名字匹配 `npm run <name>`，脚本存在且命令字符串正确，5 个目标 `.py` 文件都存在。**已核实。**
- **`restoreAction = S9_RAW_RESTORE51` / `controlAction = S9_RAW_CONTROL51`**：产生于 `rollback.py:11-12`，写入计划 `rollback.py:41-42`，使用于 `rollback.py:83-84` 的 `step()`；在包内使用于 `run-step.py:19` 的 `MAINTENANCE_ACTIONS`、`run-step.py:36` 的控制命令、`run-maintenance.mjs:20` 的 `actions`、`run-user-maintenance.sh:6` 的白名单、`S9-control-files.py:296` 的硬编码断言。当前这些地方全部一致；但新测试只核对了 `run-step.py` 的集合和控制命令，未核对 `run-maintenance.mjs`、`run-user-maintenance.sh` 和 `S9-control-files.py` 的硬编码。**当前代码可接受，覆盖不完整。**
- **`bindings.json` 里的 `S0_DB:` 字段**：产生于 `test_rollback.py:47-60` 的替换；使用于 `rollback_plan` 读取的 `maintenance.expectedInitialSchema`、`identity.deploymentId`、`service.*Sha256` 等。当前模板的 12 个 `S0_DB:` 键与 `S0_READBACK` 完全对应，能通过；若模板新增键，`S0_READBACK[...]` 会 `KeyError`。**当前可接受，扩展时有脆弱点。**
- **`recovery<schema>Id` / `recoveryId`**：测试 `test_plan_matches_the_packet_rollback_route` 用 `binding['maintenance']['expectedInitialSchema']` 拼 `recovery56Id`，两端一致，**已核实**。

总体：本轮两个断言修复有效，但建议补上“动作表的另外两个使用点”的自动核对，并给正则解析加显式失败分支；`run-all-checks.test.mjs` 的精确命令断言虽然严，但它顺带固定了 `-I`（隔离模式），我认为可以保留。
