# PR 291：去掉 node-floor 作业，把 test 作业并进 coverage 作业

## 问题
VPS 上的 CI 每个 PR 跑 9 个作业，其中 node-floor（Node 22.19.0）、test、coverage 三个作业把同一批测试跑了三遍，分别用了 39.9、33.0、32.6 分钟（运行 42362797124）。生产和上线包只接受 Node v22.22.3（`scripts/delivery-mode/packet-template/acceptance/cloud/prepare-runtime-tools.py`）。

## 目标（Andy 2026-11-08 同意的方案）
- `engines.node` 改成 `>=22.22.3`，删掉 node-floor 作业和工具链锁文件里的 22.19.0。
- 删掉 test 作业（含暂停的 macOS 成员）。coverage 作业的 projects 改成 unit、contracts、tooling、integration、e2e、pi-compat 六个：前四个照旧在一次带覆盖率的 Vitest 调用里跑；之后用 `scripts/ci/test.mjs` 的 `runTests` 接着跑 e2e、pi-compat（核对文件集合、`--retry 0`、跑完核对构建包摘要），覆盖率失败也照样跑，两边失败一起报告。
- `ci/required` 的 needs、`aggregate.mjs`、`local.mjs` 跟着改；`npm test` 改成 `local.mjs --check coverage`。
- `check-policy.mjs` 新增 `upgradeRetiredTestChecks`：PR 的策略检查会拿目标分支（base）上的旧策略经升级函数链升级后去校验 ci.yml；只有旧策略和 2026-11-08 的 main 逐字段相同时才升级成 7 个作业，否则原样返回交给校验拒绝。
- `ci/policy.schema.json` 作业数下限 9→7，`ci/evidence.schema.json` 结果条数上下限 10/12→8/9。
- 新 ADR 0181，并更新 CI 设计文档、README、架构文档。

## 约束
- coverage 作业时限保持 60 分钟，不调高任何测试超时。
- 覆盖率范围（`ci/coverage-policy.json`）和基线不变。
- 丢掉 unit、contracts、integration 的单独 JUnit 报告，这是已接受的后果。

## 作者的说法（请核对，不要当成事实）
- 去掉 test 作业后，没有哪道只在 test 作业里存在的检查被漏掉（文件集合核对由 `check-coverage.mjs` 对前四个项目做；e2e、pi-compat 仍走 `runTests`）。
- 升级函数不会让一个削弱检查的 PR 混过去。
- 所有引用 test、node-floor 作业名的地方（脚本、schema、测试、文档、main 合并后的确认运行 `scripts/ci/main-confirm.mjs`）都已同步。
- Hermes 上 tooling 项目 1984 通过、1 个失败在改动前也失败；第 3 层 npm test 的 7 个失败经单独重跑或在 base 上复现，和本改动无关。

## 第 2 轮：336ff040 之后的修改（请先看增量，再按需读任何文件）
- `scripts/ci/run.mjs`：覆盖率部分通过、只有 e2e 或 pi-compat 失败时，记 `failed` 和它的真实退出码；覆盖率也失败时保留覆盖率进程的退出码。
- `scripts/ci/check-policy.mjs`：`upgradeRetiredTestChecks` 现在把 test、node-floor、coverage、required 四项都和 2026-11-08 main 的原样逐字段比对；报错文字 nine 改为 seven。
- 新增测试：e2e/pi-compat 失败两条；升级守卫 3 条反向用例；用 5daedc92（覆盖率基线所在提交）的托管九作业策略走完整条升级链。
- `test/tooling/environment.test.mjs`：main 的 4be522b3 给 tooling 项目环境加了 `HIMAWARI_REVIEW_GATEWAY: ""`，这条测试没跟上，main 上一直失败；改成接受并核对它被清空。
