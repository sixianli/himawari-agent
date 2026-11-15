# PR 543 第 1 轮：设备动作的确认接入统一审批

## 问题和目标

PR 454 合并后，要主人确认的设备动作一律被拒绝（`ReadOnlyDeviceActionAuthorization`），首页“等你点头”的动作点不了。目标：设备动作的确认走统一审批（ADR 0257、`.agents/plans/owner-scope-approval.md` 第 4 步，Andy 已批准）。

## 约束

- 不另设设备确认状态：授权交给 `OwnerScopeAuthorization`，要问主人时建出审批，审批号记在动作上，`waiting_owner` 只是投影；批准后直接执行。
- `owner_presence_required` 要求近期身份验证；设备端用已有的 `/gateway` 的 `approval.list` / `approval.respond`，不新增路由。
- 不改模型看到的请求开头，不涉及模型调用。

## 作者的说法（请核对，不要直接采信）

1. 新文件 `apps/agent-service/src/production-device-action-authorization.ts`：读类动作走原来的只读授权；读过外来内容又不允许的动作拒绝；其余交给 `OwnerScopeAuthorization.authorize`（用设备动作的行，覆盖动作类别、可逆、是否要主人在场），返回 allow / approval / deny；`resolve` 把 `approvalOutcome` 映射成 pending / allow / deny。
2. `OwnerScopeAuthorization.approvalOutcome(approvalId)`：待办或已过期为 pending；已拒绝为 denied；已批准时用保存的意图重新 `decide`，返回 ALLOW 才算 allowed（这会消耗一次性授权）。
3. `DeviceActionService.reconcile()` 在 `settle()` 开头和每次审批回应后（`GovernanceGatewayV2ControlPlane` 新增的可选回调 `onApprovalResolved`，错误被吞掉）调用，把 `waiting_owner` 的动作按审批结果放行或拒绝。
4. `action-policy-service.ts`：`owner_presence_required` 事实使 `recentAuthenticationRequired` 为真。
5. 工具层不再对设备动作调用 `hooks.authorize()`，避免同一动作问两次。
6. 已知取舍：动作插入前崩溃、重放时意图的时间戳不同会得到 `approval_hash_mismatch`，结果是拒绝（偏安全）。

## 不必评的

撤销（下一个 PR）、推送唤醒（再下一个 PR）、PR 454 已审过并判过的各条。
