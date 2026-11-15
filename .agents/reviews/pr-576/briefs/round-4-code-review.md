# PR 576 第 4 轮复核材料

第 3 轮第 1 条（中）已改：恢复（`RunExecutionInputService.#freeze`）和到期结算（`production-run-expiry.ts`）比对冻结快照和数据库来源之前，先用 `frozenRunSourceIdentity` 去掉 `ownerApprovedTask`，这样部署前冻结、快照里没有这个字段的 `task.run` 运行仍能恢复和收尾；授权层每次重新读来源、不读快照，所以不放宽授权。新增 `test/integration/thread-run-lifecycle.test.ts` 的旧快照恢复用例和 `packages/application/test/frozen-run-source-identity.unit.test.ts` 的反向用例（其他字段不同仍判为不同）。第 2 条：ADR 0257 的事实代码清单补上 `run_source_owner_approved_task`。ADR 0278 新增决定 5 讲快照比对，前提 5 改为引仓库里的方案原文。请核对这些增量，重点看去掉字段后会不会让本该判为“来源变了”的情况漏过。
