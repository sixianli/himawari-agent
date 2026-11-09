# PR 318 材料：草稿 PR 只跑快速检查

目标：草稿（draft）PR 只跑 policy/static/build/security，browser 和 coverage 用 `if` 跳过；PR 转为 ready 后跑完整 CI。同时让 `edited` 事件不再取消正在跑的 CI（并发组后缀用 run_id）。
改动：`.github/workflows/ci.yml`、`scripts/ci/check-policy.mjs`（精确断言 `if` 条件和并发表达式）、`test/tooling/policy.test.mjs`（夹具加 3 个反向用例）、新 ADR 0190、设计文档第 264 行。
已知设计取舍：草稿 PR 的 `ci/required` 会因跳过而显示失败，这是有意为之（聚合脚本只接受上游 success）；`main-evidence.mjs` 只接受成功的 PR 运行，所以草稿运行不会被当作合并证据。
作者说法：Hermes 上 822 个测试通过，真实 ci.yml 通过 policy 检查。
重点请查：ready_for_review、synchronize、edited 事件下 if 条件是否正确；并发组表达式是否会让不同事件互相取消或永不取消；check-policy 是否真的能拦住改动 if。
这个改动不会改变模型已经见过的请求开头（只改 CI 配置、脚本和文档）。
