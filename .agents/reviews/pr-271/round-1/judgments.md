# PR 271 第 1 轮代码复核：逐条判断

复核的提交：`91776732`（基点 `1f12c92f`）。两个模型都是 `ok`，共花 0.1501 美元。机器可读的判断在同目录 `verdicts.jsonl`。

## 会出错（已修改）

- D2（DeepSeek，模型给“低”，判中、高）：`test/tooling/run-all-checks.test.mjs` 只断言步骤名在 `check:steps` 里，把 `check:delivery-rollback` 改成 `"true"` 也全过，等于这道检查能被悄悄关掉。修改：5 个交付测试步骤逐个断言命令正好是 `python3 -I scripts/delivery-mode/<文件>`。反向（Hermes）：把 `check:delivery-rollback` 改成 `"true"`，`npm run check:check-runner` 退出 1，报 `expected 'true' to be 'python3 -I scripts/delivery-mode/test…'`。
- G2（GLM，模型给“低”，判中、高）：`PlanTest` 只查回退动作名“在步骤表里”，把 `rollback.py` 的 `RESTORE_ACTION` 和 `CONTROL_ACTION` 互换后两者都在表里，测试全过，而真实回退会先跑控制步骤、不恢复数据库。修改：`test_plan_runs_only_steps_the_packet_and_deploy_script_define` 另外要求恢复动作在 `run-step.py` 的 `MAINTENANCE_ACTIONS` 里、控制动作不在，并且控制动作那一行把恢复动作作为参数。反向（Hermes）：互换两个名字后，新测试退出 1（`'S9_RAW_CONTROL51' not found in {…MAINTENANCE_ACTIONS…}`）；同样的互换下 `91776732` 版本的 `PlanTest` 3 个用例全过，证明这是原来漏掉的。

## 可以更好（不修改，列给 Andy）

- D3（DeepSeek）：只用了第十二版一组参数（当前和目标数据库版本都是 56），建议再加一组“当前 55、目标 56”的参数。临时写了这个变体在 Hermes 上运行（`tmp_test_rollback_55.py`，不提交），用现在的代码 14 个用例全过。建议不采纳：`rollback.py` 只读 `expectedInitialSchema`，`PlanTest` 已经用它对出恢复点编号；多一组参数主要是多跑一次渲染。
- G3（GLM）：`.agents/instructions/delivery-mode.md:18` 括号里列的 `npm run check` 内容没提交付测试。那是举例，本来就漏了二十多步，补上只改措辞。建议不采纳。
- G4（GLM）：测试生成的 `bindings.json` 没有经过冻结，`PlanTest` 不代表整条回退路径都测过。提交说明已写明它只查三者一致性；代码里不能写注释。建议不采纳。

## 不成立

- D1（DeepSeek）：说“生成的回退批准能过包里的维护检查”只对一半。这句话只在给复核模型的作者说明里，没进仓库；这个用例的名字和内容本 PR 没改，改动前用真实上线包时调用的也是同一个 `verifyRollbackApproval`。
- D4（DeepSeek）、G1（GLM）：`test_deploy.py` 里检查本机 `/usr/bin` 链接的用例让 `npm run check` 依赖主机。`delivery-mode.md:21` 只允许在 Hermes 和云服务器的 `himawari-ci` 账号上跑；Hermes 本 PR 实测通过；`himawari-ci` 和生产在同一台机器上，每次上线前 `deploy-preflight.py` 在那台机器上做同样的扫描（`SANDBOX_COMMAND_LINKS_REACHABLE`）；引入这个用例的 `20bc663a` 在 Ubuntu 24.04 云端容器里也跑过并通过。某台主机上失败，说明封装脚本放行的目录在那台主机上不够，正是它要报的问题。
- D5（DeepSeek）：`docs/lessons.md:690` 和 I-55 的说法与现在不一致。两处都是带日期的历史记录，记的是当时的情况，不描述现在的行为。
