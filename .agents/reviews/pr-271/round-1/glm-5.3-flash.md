## 复核结论

先说总评：改动本身（4 个 npm 步骤 + test_rollback.py 自渲染上线包 + 防偷删断言）方向正确、与我读到的代码一致，作者给出的事实绝大多数都被代码证实。发现的问题按严重度排列如下。

---

### 发现（按严重度从高到低）

**1. 中｜`scripts/delivery-mode/test_deploy.py:146-149`｜宿主绑定的用例进入全局门槛后，`npm run check` 在非 Hermes Linux 宿主上可能假失败**

- 问题：`test_real_seal_template_roots_let_every_command_link_resolve_on_this_host` 硬读本机 `/etc/alternatives` 和 `/usr/bin` 的软链接。接进 `check:steps` 后，任何跑 `npm run check` 的机器都必须长得像生产机，否则这个用例失败并拦下整条 check。
- 证据（读代码证实）：
  - `test_deploy.py:148-149`：`self.assertIn('/etc/alternatives', roots)` 和 `sandbox_links.unreachable_commands(roots)`——`/etc/alternatives` 是 Debian 系特有的目录。
  - `test-and-production-hosts.md:8` 明令 MacBook 不跑 `npm run check`。
  - `README.md:39`：GitHub Actions 已于 2026-10-26 关闭，门槛 = 快速模式本地检查。
  - 但 `docs/engineering-casebook.md` 多处记录云端容器跑过 `npm run check`（如 casebook:2426、2950「`npm run check`、`npm run build` 通过（云端容器）」）。
- 说法核对：作者写「`npm run check` 只在 Hermes 和 Hermes 上的 CI runner 上跑」——**推测，未核实**。历史证据（云端容器跑过全程 check）与之相斥；若今后云线程仍按第 1 层规则跑 check（delivery-mode.md:9「每次提交之前运行」），此用例会在容器里报错。
- 建议：给这个用例加宿主开关（仓库已有先例 `ROLLBACK_TEST_NODE`），或像已犯过的 I-42 那类「本地门槛跑在他处」事故一样，在文档里写死该套件允许的宿主。

**2. 低｜`scripts/delivery-mode/test_rollback.py:130-138` 配合 `rollback.py:11`、`rollback-remote.py:111`、`maintenance-common.mjs:605-610`｜把 `RESTORE_ACTION` 改成包内另一个合法步骤名（如 `S9_RAW_CONTROL51`）时，PlanTest 三条全绿**

- 问题：作者问「改回 `S9_RAW_RESTORE56` 是否仍失败」——**会失败**（证实）：步骤名取自 `run-step.py` 文本的正则（`test_rollback.py:131`），`S9_RAW_RESTORE56` 只在历史 README 的叙述里出现（`packet-template/steps/README.md:84`），不在 `run-step.py:19` 的 `MAINTENANCE_ACTIONS={'S9_RAW_RESTORE51', …}` 也不在 `run-step.py:36` 的命令表里，`assertIn` 必败；lessons.md:690 记录的历史失败机制与此一致。
- 但同类改错的另一种形态测不到：`approval_document` 的 `action` 直接取自 `plan['restoreAction']`（`rollback-remote.py:111`），校验函数拿 `approval.action` 反推期望（`maintenance-common.mjs:605` `rollbackApprovalExpectation(binding, action)`、:610 `assert.equal(approval.action, expected.action)`）——批准文件和期望同源，恢复动作与控制动作互换（51 在步骤表里）时三条用例都不红。第 138 行对 `recoveryReport` 做了「与 deploy.sh 实跑名比对」，同样的比对没有施加给 `restoreAction`。
- 建议：`test_plan_runs_only_steps…` 里再断言 `plan['restoreAction']` 等于包内维护入口的默认动作（`maintenance-common.mjs:628` 的 `readRollbackApproval(binding, action = "S9_RAW_RESTORE51")`），或断言恢复动作 ≠ 控制动作且二者都在维护集里。

**3. 低｜`.agents/instructions/delivery-mode.md:18`｜`npm run check` 内容的列举未更新**

- 证据（读代码证实）：第 18 行括号里举了「格式、lint、类型检查、模块边界、覆盖率和不变量、机密扫描、instruction-links、layout」。本批加入的 4 个 Python 步骤以及此前已有的 `check:prompt-prefix`、`check:incident-gates` 等都不在列举中。列举式写法先例如此（非新引入的不一致），但本批特意把交付测试变成第 1 层门槛，值得在此补一句「含交付模式 Python 测试」。
- 建议：在第 18 行补一句，并注明这两条门槛只在 Hermes 上有效（与发现 1 联动）。

**4. 低｜`scripts/delivery-mode/test_rollback.py:59-60`｜测试生成的 `bindings.json` 不是「冻结」语义**

- 证据（读代码证实）：真实回滚走 `rollback.py` 的 `main()`，先跑 `check-packet-consistency.py`，包内 `packet-common.py:63` 要求 `inputs/bindings.json` 在冻结清单成员里；测试直接调 `rollback_plan()`（`test_rollback.py:121`），跳过了冻结清单、一致性脚本和远端两条路径（`main()` at rollback.py:70-87）。
- 建议：可以接受（PlanTest 的承诺就是三者一致性），但建议在测试注释/作者说明里明示这条边界，防止误读为「回滚全文已测」。

---

### 读代码证实的（作者说法核对）

- 4 个文件此前不在 `check:steps` 里（diff + package.json:27 现状一致）✓；步骤顺序「packet 之后、check-runner 之前」✓。
- 旧版 `test_rollback.py` 模块加载即 `os.environ['ROLLBACK_TEST_PACKET']` → `KeyError`（diff -7 行证实）✓；仓库内再无 `ROLLBACK_TEST_PACKET`（grep 仅剩 `ROLLBACK_TEST_NODE`，test_rollback.py:16）✓。
- `make-packet.py:316` `render(target, parameters, only=None)` 与测试调用签名一致 ✓；`fixtures/twelfth-parameters.json` 含模板所需的键（COMMIT/LABEL/DATE/DATE_COMPACT/HOSTNAME/OLD_PREFIX/OLD_OPERATIONS/CURRENT_SCHEMA:14/TARGET_SCHEMA:43/ADDRESS）✓。
- 模板草稿 `bindings.draft.json` 恰有 12 个 `S0_DB:` 占位（97-144 行），与 `S0_READBACK`（test_rollback.py:31-44）12 个键一一对应；新键未补值时 `with_s0_readback` 抛 `KeyError` 使测试报错 ✓。
- 在作者问的 `S9_RAW_RESTORE56` 场景下测试确实失败（见发现 2）✓；`deploy.sh:78,80` 的 `actions=(S1_TRANSPORT … S8_READBACK)` 使第 136-138 行的 `recoveryReport='s3_copy51-result.json'` 断言成立 ✓；批准文档字段满足 `verifyRollbackApproval` 全部断言（approvalRef 非空 :618、preservedCurrentRecoveryId :619 来自 `rollback-remote.py:120-121`）✓。
- 62/44/13 的用例数与 `def test_` 计数一致 ✓。
- 步骤失败时 `npm run check` 整体退出非 0：`run-all-checks.mjs:14-26, 34-37`（失败累计、`.status ?? 1`、`process.exit(main())`），且一步失败不吞后续步骤 ✓；`run-all-checks.test.mjs:8-36` 覆盖这些语义 ✓。
- 防偷删断言（run-all-checks.test.mjs:55-58）：从 `check:steps` 删除任一名字，`toContain` 必失败 ✓。
- I-02 的门槛一栏列了 `test_rollback.py`（incidents-and-gates.md:41），而 `check-incident-gates.mjs:68-70` 只检查「文件存在」，确实从来不保证它会运行——本 PR 之前作者的诊断成立 ✓。
- `test_deploy.py` 的 `pregated` 用例在 Hermes 通过、且 `check` 只在 Hermes 跑——**仅前半可证**，后半未核实（见发现 1）。

### 推测（未核实）

- 发现 1 中「当前实际仍会有云线程跑 `npm run check`」：历史证据存在，当前惯例未核实。
- 4 个 Python 套件在 Hermes 上全绿（62/44/13、PlanTest 3 例）：只有作者陈述，本复核环境不能运行验证。
- `.github/workflows/` 是否存在及其内容：工具限制（glob 不进隐藏目录、bash 受限），未核实；但 `scripts/ci/` 全目录 grep 无 `npm run check` 引用，即便 Actions 恢复，CI 作业也不跑这 4 步，只在 CI 的 tooling 项目里跑 run-all-checks.test.mjs 的接线断言。

---

### 侧重检查

流程走查（最普通流程：在 Hermes 上改一笔 Python/交付相关的代码 → 提交 → `npm run check`（第 1 层，delivery-mode.md:9）→ 36 步（package.json:27）→ `check:delivery-rollback` → `python3 -I` 载入 test_rollback.py → 模块级加载 remote/orchestrator/make-packet.py → `PlanTest.setUpClass` 渲染包并写 bindings.json → 三条用例读 `rollback_plan()` → 退出码交回 `runAllChecks` 汇总并决定整体退出码（run-all-checks.mjs:18-26）→ 合并进 main 不等 CI（AGENTS.md:7、README.md:39））。

走过的路径中**没有测试覆盖**的点：
1. `run-all-checks.mjs:36` 的 `spawnSync(status ?? 1)`——命令不存在（如某宿主没有 `python3`）时 status 为 null 的真实运行路径只有间接覆盖（测试只注入 run() 返回值）。
2. 发现 1 的宿主绑定用例：接进门槛前无自动运行点，接进后只在 Hermes 验证过，其他宿主行为未知。
3. 发现 2 的 `restoreAction` 与包内合法步骤名混淆的情形。
4. `test_rollback.py` 未触达的回滚真实路径：`rollback.py:70-87` 的 `main()`（包一致性、SSH、`rollback-remote` 的 prepare/start）不在测试内——既有缺口，本 PR 未扩大也未堵上。
5. 本批 4 步与 CI 的关系：接线断言可在 CI tooling 项目守住「没被偷删」，但 Python 本体永远只依赖有人手敲 `npm run check`；这与 I-61 的教训（「这个测试不在 `npm run check` 里（…重跑时发现）」）一致，本 PR 正是补这个洞，方向对。

---

### 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。diff 只动了 `package.json`、`scripts/delivery-mode/test_rollback.py`、`test/tooling/run-all-checks.test.mjs`（git diff --stat 证实），不触系统提示、工具定义、历史、遮盖；发给模型的内容逐字节不变，不存在末尾追加与否的问题。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。改动不产生任何模型可见序列化输出。测试内部写入的 `bindings.json`（json.dumps，键序继承模板插入序）每次运行确定，且不出仓库、不进模型请求。
3. **有没有对应的自动检查、反向用例会失败吗？** 有且成立：①接线由 `run-all-checks.test.mjs:55-58` 守，删除即红；②`PlanTest` 反向用例 `RESTORE_ACTION → S9_RAW_RESTORE56` 必失败（步骤名正则取自 run-step.py 文本，见 test_rollback.py:131 与 run-step.py:19/36），与 lessons.md:690 记录的历史失败机制相互印证；③每步非 0 会使整体退出 1 且各失败都上报。缺口是发现 2 的另一种改错形态和发现 1 的宿主问题。
4. **每个新产生/修改的值两端都核过吗？** 核过：4 个 npm 脚本名（生产端 package.json:41-45；消费端 run-all-checks.mjs:32 的正则 + 断言，无 ci-policy 约束，check-ci-policy.mjs 不校验 check:steps）；`twelfth-parameters.json`（仅 test_make_packet.py:20 和 test_rollback.py:17 两个消费方，键集覆盖模板全部 `__PKT_*__`）；`S0_READBACK` 12 键 ↔ 草稿 12 个 `S0_DB:` 占位逐一对应，且 `rollback_plan`、`rollbackApprovalExpectation`、`verifyRollbackApproval` 读到的每个字段（schemaVersion、recovery56Id、oldPrefix、stateRoot 等）都有合法来源。未发现 I-73 那类「生产端给的值过不了消费端校验」的问题；遗留盲区即发现 2（动作名仅在「在不在表里」这一层核对）。
