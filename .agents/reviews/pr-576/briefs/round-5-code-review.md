# PR 576 第 5 轮复核材料

第 4 轮第 2、3 条（低）已改：`frozenRunSourceIdentity` 收 `unknown`，入参不是非空对象时原样返回，坏快照（缺失、null、非对象）仍走原来的受控错误（`Run execution snapshot source changed` / `RUN_EXPIRY_INPUT_INVALID`），单元测试加了三种坏输入；`test/integration/thread-run-lifecycle.test.ts` 新增到期结算路径的旧快照用例（正向照常结算，反向 `sourceId` 不同时报 `RUN_EXPIRY_INPUT_INVALID`）。ADR 0278 前提 3 写得更精确。第 1 条（`amends`）不改。请核对这些增量。
