# PR 528 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1. 高：给定的比较基准不是本提交的祖先，这个 diff 不是 PR 528 的改动。复核开跑时 --base 是 origin/main，跑的途中 main 前进了；PR 自己的改动只有 git show 204ac20 的两个文件。合并前会照规则合最新 main 并 --assert-reviewed，不是代码缺陷
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 中：新增工作流没有接入 actionlint，CI 不会校验它的 GitHub Actions 语法。scripts/ci/run.mjs:270-276 只列了四个工作流；已加入 pr-closed.yml，本地 actionlint 1.7.11 跑出 if: false 是常量条件的报错，已改成 github.event.action != 'closed'，五个文件 actionlint 通过；触发：pr-closed.yml 写错 GitHub Actions 语法；后果：static 检查不报，工作流在 GitHub 上不运行，排队的 CI 照旧不取消；判低理由：后果只是这个新加的取消不生效，回到改动前的状态，不影响 CI 结果或合并
- 3（deepseek-v4.1-flash）成立，可以更好：### 3. 中：与 CI 设计规格“并发组包含 workflow、避免不同 workflow 相互取消”直接冲突，但没有更新文档或 ADR。docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:272 的规则讲的是避免无意的互相取消；这里是有意的例外，已在同一句后补写例外和原因。把 closed 并进 ci.yml 要改 check-policy 对事件类型和并发组的硬约束，范围更大，不做
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 中：草稿 PR 关闭时不会取消它的排队 CI，测试标题和 PR 目标描述比实现更宽。是刻意的取舍，PR 描述已写草稿不用管；测试标题已改成只说非草稿；触发：草稿 PR 关闭时还有排队的 CI；后果：那次运行仍排队，等 ci-vps-gate 拿到后第一步以 CI_DRAFT_UNVERIFIED 退出，只占几秒；判低理由：草稿运行只有 ci/required 一个作业且第一步就退出（ci.yml 第 365-370 行附近，本 PR 的草稿 CI 日志可见），不占测试机器
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 低：测试对“不碰 main”的断言是空洞的，且没有真正的反向用例。test/tooling/pr-closed-cancel.test.mjs 原断言只比前缀；已改成读 main.yml 的实际组名比较。组名写错时用例失败已手动验证（少一个 - 时 1 failed）；触发：以后 main.yml 的并发组改成和 CI 相同；后果：测试不报，关闭 PR 可能取消 main 的全量测试
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低：fast 模式提交说明缺少 `Fast-mode-checks:` 行。.agents/instructions/delivery-mode.md:32 要求这一行；已推送的提交不改写，后续提交补上；触发：看提交说明核对快速模式检查；后果：看不出跑过哪些检查
