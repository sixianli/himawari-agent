# 合并队列方案审核第 1 轮：逐条判断

| 意见 | 判断 | 落实 |
| --- | --- | --- |
| 1 高：相关测试的结果不能当全量用 | 成立，采纳实质 | 作业名仍叫 `ci/required`（规则和线程都按这个名字等），结果里记 `relatedProjects`、汇总标 `scope`；汇总只在 PR 上、只对 integration/e2e/pi-compat/tooling 接受相关范围和零计数；main 轻量确认拒绝 `related`（`MAIN_GATE_RELATED_SCOPE`） |
| 2 高：候选 CI 会执行 PR 改过的 CI 脚本 | 成立，采纳 | 改了 `.github`、`ci`、`scripts/ci` 的 PR 不进队列，按原流程手动合并 |
| 3 高：合并接口的 sha 不锁 main | 成立，采纳 | 每次合并前核对 main 等于预期，合并后核对两个父提交和树，不一致停下队列 |
| 4 中高：`pull_request_target` 和 fork | 成立，采纳 | 不用 `pull_request_target`；只认本仓库的 PR；工作流只检出 main，有测试核对 |
| 5 中高：`--assert-reviewed` 在队列里跑不起来 | 成立，采纳 | 在 PR 头的临时检出上跑 main 的脚本，`--main-ref` 用共同祖先 |
| 6 中高：二分不完整、状态放提交说明不可靠 | 成立，采纳 | 两半都测、先合过了的一半，后一半在新 main 上重测，单个失败才移出；状态放 `merge-queue-state` 分支的 JSON，带格式校验 |
| 7 中：标签触发和撤销 | 成立，采纳 | 不用标签触发；合并前重新确认标签还在 |
| 8 中：分支复用、运行绑定、排序依据 | 成立，采纳 | 分支 `mq/<运行号>-<尝试次数>`；按分支和提交找运行；按 timeline 里最近一次加标签的时间排序 |
| 9 中：工作流没进检查、文档矛盾 | 部分采纳 | 加进 actionlint；工作流形状由测试核对；设计说明、交付模式、长期规则已改；没有接进 check-policy（它只校验 ci.yml 一类和策略绑定的工作流） |
| 10 中：目标写过头、PR 仍跑重作业 | 部分采纳 | ADR 写清只省测试；tooling 也只跑相关测试；browser 暂不动；队列在 ARM 上跑，不占汇总作业的 runner |
| 11 中：vitest 细节 | 成立，采纳 | 不用 `forceRerunTriggers`，由自己的分类决定全量；基线用 PR 的 baseSha；零个相关测试由汇总在相关范围内接受；前提 4 改引 `vitest related` 一节 |
