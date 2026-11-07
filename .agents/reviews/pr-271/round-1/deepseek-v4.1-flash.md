## 复核结论

未发现高严重度问题。改动主体（把 4 个 Python 测试接进 `check:steps`）方向正确，失败会正确传播为非 0。下面按严重度列出读代码证实的问题，再给出推测/未核实项。

### 读代码证实的问题

**1. 中 — “生成的回退批准能过包里的维护检查”说法只对了一半**
文件：`scripts/delivery-mode/test_rollback.py:140-152`；`scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:425-445, 608-631`

问题：测试只调用了 `verifyRollbackApproval` 这个纯内容校验函数，没有走生产实际使用的 `readRollbackApproval`/`loadBinding`。测试构造的包本身也不能通过完整维护入口。

证据：
- `test_rollback.py:147`：`common.verifyRollbackApproval(approval, common.rollbackApprovalExpectation(binding, approval.action));`
- `maintenance-common.mjs:608-620` 的 `verifyRollbackApproval` 只比较 approval 的字段。
- 生产入口 `maintenance-common.mjs:425-445` 的 `loadBinding` 要求：
  - `process.getuid() == fixed.uid`（999）；
  - `binding.status === "frozen-approved"`；
  - `binding.approvals.packageRef` 非空；
  - `binding.identity` 精确等于固定值，其中 `hostId` 是 `himawari-prod-host`（`s0-db/read-s0-db.mjs:17`）。
- 测试的 `bindings.json` 直接来自未冻结的 `bindings.draft.json`：`test_rollback.py:58-60`；该草稿的 `status` 是 `candidate-awaiting-s0-db-and-freeze`（`bindings.draft.json:3`），`approvals.packageRef` 是空串（`:132`），且 `test_rollback.py:35` 把 `identity.hostId` 写成 `host:rollback-test`。

建议：把测试名/作者说明改成“approval 内容能通过 `verifyRollbackApproval`”；若确实要验证“包里的维护检查”，需要构造 `frozen-approved`、合法 `identity`/`approvals` 的 bindings，并通过 `readRollbackApproval` 而不是绕过它。

---

**2. 低 — 接线断言只查名字，不查命令内容**
文件：`test/tooling/run-all-checks.test.mjs:55-60`；`package.json:42-45`

问题：新增断言只能防止步骤被删除，不能防止脚本被改成空操作。

证据：
- `test/tooling/run-all-checks.test.mjs:55-58` 仅 `expect(names).toContain("check:delivery-...")`；
- `:60` 仅断言 `manifest.scripts[name]` 是字符串。
- 因此把 `check:delivery-rollback` 改成 `"true"` 时，这些断言仍全部通过。

建议：断言每个脚本的精确命令，例如 `"python3 -I scripts/delivery-mode/test_rollback.py"`；或至少断言命令包含对应文件名。

---

**3. 低 — 只有“无迁移”一台 fixture，无法覆盖 current/target schema 混淆**
文件：`scripts/delivery-mode/fixtures/twelfth-parameters.json:14,43,44`；`scripts/delivery-mode/test_rollback.py:17,58`；`scripts/delivery-mode/rollback.py:43`

问题：`PlanTest` 只使用第十二次参数，其中 `CURRENT_SCHEMA` 与 `TARGET_SCHEMA` 都是 56，`MIGRATION_LEDGER` 为 `"[]"`。如果 `rollback.py` 把恢复点错误地绑定到 target schema 而不是 current schema，这套测试发现不了；而 I-02 关注的恰恰是“恢复点/步骤名绑定错”。

证据：
- fixture：`"CURRENT_SCHEMA": 56`、`"TARGET_SCHEMA": 56`、`"MIGRATION_LEDGER": "[]"`。
- `test_rollback.py:17` 只加载这一份 fixture，`:58` 只渲染这一份参数。
- `rollback.py:43`：`'recoveryId': binding['maintenance']['recovery' + str(schema) + 'Id']`，其中 `schema` 是 `expectedInitialSchema`。

建议：再加一个 current < target 的参数变体（例如 current=55、target=56、非空 ledger），至少让 `PlanTest` 在迁移包形状下跑一遍。

---

**4. 低 — 把宿主机 `/usr/bin` 布局变成必过检查的输入**
文件：`scripts/delivery-mode/test_deploy.py:146-149`；`scripts/delivery-mode/sandbox-command-links.py:31-37`

问题：`test_real_seal_template_roots_let_every_command_link_resolve_on_this_host` 断言的是“运行机器的 `/usr/bin` 中每个符号链接都可到达”，不是仓库内容。它被接进 `npm run check` 后，检查结果依赖运行主机。

证据：
- `test_deploy.py:146-149`：读取模板 roots 后调用 `sandbox_links.unreachable_commands(roots)`，默认目录 `/usr/bin`。
- `sandbox-command-links.py:31-37` 遍历本机 `/usr/bin` 的符号链接。

作者说法“`npm run check` 只在 Hermes 和 Hermes 上的 CI runner 上跑”与规则不完全一致：`.agents/instructions/delivery-mode.md:21` 写的是“在云服务器上以 `himawari-ci` 身份或在 Hermes 上运行”。这条规则禁止 Mac，所以风险有限；但仍建议在非指定主机上跳过该用例，或把它明确标成 Hermes-only。

---

**5. 低 — 文档与代码出现轻微不一致**
文件：`docs/lessons.md:690`；`docs/incidents-and-gates.md:92`

问题：
- `docs/lessons.md:690` 仍说 `PlanTest` “拿第十二次的操作包跑”，而现在代码是用模板 + `fixtures/twelfth-parameters.json` 现场渲染（`test_rollback.py:57-60`）。
- `docs/incidents-and-gates.md:92` 的 I-55 说 `npm run check` “把 21 步全跑完”，当前 `check:steps` 已是 39 步；这是既有陈旧描述，本次又增加了 4 步。

建议：顺手更新 `docs/lessons.md` 的这句历史描述；I-55 的步数如果能改成“按 `check:steps` 清单全部跑完”更好。

### 推测 / 未核实

- **未核实**：作者所述“Hermes 上 4 个步骤正向/反向及 `npm run check` 39 步全过”无法在本次复核环境中运行确认；我只能从代码确认失败传播逻辑正确。
- **推测**：`test_deploy.py` 在作者指定的 Hermes 上通过；在其它 Linux 主机（例如符号链接布局不同的云容器）上是否一定通过，取决于该主机的 `/usr/bin`，未验证。
- **未核实**：模板未来若新增 `__PKT_*` 占位符而 `fixtures/twelfth-parameters.json` 未同步，`test_rollback` 会报 `PACKET_PARAMETER_MISSING`；不过现有 `check:delivery-packet` 也用同一 fixture，因此不是本次新增的独立风险。

---

## 侧重检查

- **错误路径**：fixture 缺失会在导入时报错；模板占位符缺失由 `make-packet.py:316-328` 的 `substitute` 拒绝；新的 `S0_DB:` 键缺失会在 `test_rollback.py:52-53` 触发 `KeyError`；Node 子进程失败由 `test_rollback.py:150-152` 断言退出码；`run-all-checks.mjs:14-26` 会把任一步非 0 汇总为整体 1，`main()` 以该值退出。结论：错误路径会正确失败。
- **不合规范/不可信输入**：新测试的输入全部来自仓库内模板和 fixture，不接受外部输入。`test_rollback.py:16` 仍允许 `ROLLBACK_TEST_NODE` 环境变量指定任意可执行文件，这是既有的本地环境信任边界，不是本次新增。
- **安全**：测试不读取生产机密；fixture 里的生产 IP/哈希本来就在仓库中；临时目录默认 0700；`rollback.py`/`rollback-remote.py` 的 `main()` 有 `__main__` 保护，测试不会触发 SSH/systemctl。
- **资源耗尽**：`TemporaryDirectory` 均有 cleanup；本地 HTTP 服务器有 shutdown；`test_deploy` 的 `sleep 60` 进程带 cleanup。`test_rollback.py:150` 的 Node 子进程没有 timeout，若 Node 卡住会影响 `npm run check`，但这是既有模式，严重度低。
- **不可撤销操作**：`test_deploy.py` 在临时包上运行 `deploy.sh`，并把 `release-cleanup.py` 替换成只写临时文件的桩（`test_deploy.py:241-243`）；`test_rollback` 只调用计划/批准纯函数，不执行真实回退。未发现不可撤销操作。
- **规则/文档一致性**：I-02 现在确实有自动运行点；`.agents/instructions/delivery-mode.md:21` 规定检查在云服务器或 Hermes 跑、禁止 Mac，与新增的宿主相关测试相容；`docs/lessons.md:690` 和 I-55 的步数描述略陈旧。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只在末尾追加？**

不会。本次 diff 只改了 `package.json`、`test/tooling/run-all-checks.test.mjs`、`scripts/delivery-mode/test_rollback.py`，不涉及系统提示、工具定义、历史消息或遮盖结果的生产路径。按 `.claude/rules/prompt-prefix.md` 的规则 1/2/4，固定内容在前、每轮变化值只在最后一条用户消息、已发内容只能追加；本改动没有触碰这些机制。可以回答：模型请求内容不变，仍只在末尾追加。超出 diff 的全局提示组装代码未逐一复核（未核实），但本改动不在其路径上。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会。这里唯一新增的序列化是测试内的 `json.dumps(with_s0_readback(draft))`（`test_rollback.py:60`），不会进入模型请求；其输入是固定 fixture，字典顺序固定，不含时间字段。没有新增依赖前后文的遮盖、时间戳或无序集合进入请求内容。

**3. 有没有对应的自动检查？反向用例是否真的会失败？**

有对应自动检查：4 个步骤已加入 `check:steps`，`run-all-checks.test.mjs` 断言其存在。失败传播已确认：`run-all-checks.mjs:14-26` 汇总失败并返回 1。

反向用例中，作者重点提到的 `RESTORE_ACTION` 改回 `S9_RAW_RESTORE56` 会失败：`run-step.py:19` 的步骤集合只含 `S9_RAW_RESTORE51`，而 `test_rollback.py:132-133` 要求 `restoreAction` 必须在步骤集合中，因此 `S9_RAW_RESTORE56` 会 `assertIn` 失败。

但反向覆盖仍有缺口：如果只是把 `check:delivery-rollback` 脚本改成空操作，`run-all-checks.test.mjs:55-60` 仍会通过；新增 S0 键触发 `KeyError` 也只是代码固有行为，没有独立反向测试。

**4. 每个新值/字段/配置键，两端的校验都能接受吗？**

逐项核对结果：
- `package.json:42-45` 的 4 个脚本名：消费端 `run-all-checks.mjs:7-11` 只接受 `npm run <name>`，名字合法；`test/tooling/run-all-checks.test.mjs:52-60` 也接受。**通过**。
- `check:steps` 中的 4 个新条目：同上，`stepNames` 能解析。**通过**。
- `fixtures/twelfth-parameters.json`：消费端 `make-packet.py:316-328` 的 `render` 要求所有 `__PKT_*` 都有值；同一 fixture 已被 `test_make_packet.py:20,115` 使用，当前模板能渲染。**通过（当前模板）**。
- `S0_READBACK`（`test_rollback.py:31-44`）→ `with_s0_readback`（`:47-54`）→ `bindings.json` → `rollback.py:19-46` / `maintenance-common.mjs:604-620`：类型和字段对这条窄路径可接受；未知键会 `KeyError`，行为正确。
- 但是，同一个 `bindings.json` 若交给完整维护入口 `loadBinding`（`maintenance-common.mjs:425-445`），会因为 `status` 不是 `frozen-approved`、`approvals.packageRef` 为空、`identity.hostId` 不同、文件属主不是 999 而被拒绝。**两端不完全一致：测试实际使用的校验端接受，生产完整校验端不接受**；这不是运行时 bug，但作者“能过包里的维护检查”的说法应修正。
