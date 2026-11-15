# PR 536 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 低：找不到 `scripts/ci/run.mjs` 时 Chromium 顺序校验直接放行，static/tooling 的执行入口又没有别的断言固定。scripts/ci/check-policy.mjs 已改为只有 tests 找不到执行步骤时放行（tests 由 706-715 的固定命令断言兜住）；policy.test.mjs 加“没有执行步骤”的反向用例；触发：以后把 static 或 tooling 的执行步骤换成不含 scripts/ci/run.mjs 的包装命令；后果：顺序校验不再生效，Chromium 装在检查之后也不报
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：Chromium 步骤显式写 `continue-on-error: false` 会被误判成“有条件”。已改成 !== true，与通用检查一致；policy.test.mjs 加显式 false 通过的用例，952 条通过；触发：Chromium 安装步骤显式写 continue-on-error: false；后果：策略检查误报拒绝
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 低（推测）：Runbook 把“缺系统库”的失败位置指向 Chromium 安装步骤，可能与实际失败阶段不符。模型自己标了未核实；缺库在哪一步报是 static 那句原有说法，本 PR 只把 tooling 补进同一句，没有改它的判断。要核实得在 ARM 机器上真删库跑一次，不在这次范围
