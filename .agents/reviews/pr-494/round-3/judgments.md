# PR 494 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 中：现行 ADR 0064 和 ADR 0189 仍在教人运行已删除的 `--check coverage`，规则文档与代码不一致。ADR 0267 决定里写明本地入口改成 tests 和 tooling，并点名 ADR 0189 决定 4 和 ADR 0064 示例里的 coverage 换成 tests；不改旧 ADR 的正文；触发：有人照 ADR 0064 的示例或 ADR 0189 决定 4 运行 local.mjs --check coverage；后果：local.mjs 立刻以 CI_LOCAL_CHECK_UNSUPPORTED 拒绝，不会跑错东西，只是要换成 tests；判低理由：只影响照旧文档手打命令的人，并且立刻明确报错、不产生错误结果；npm test 和 test:tooling 这两个实际入口已经改对
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 低：新增的防回归用例只对齐 `ci/policy.json`，没有校验 `local.mjs` 自己的支持列表。local.mjs 的支持列表和策略检查名是两份表，用例只对齐了策略；要改需从 local.mjs 导出常量，属于加固，列给 Andy
