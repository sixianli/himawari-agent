## 复核结论

### 1、中、编码/文件/网页审批上选“几天内/以后都行”会被存下但永远不生效
- 文件:行
  - `apps/control-center/src/components/run-approval-card.tsx:58-60`（除搜索外的所有 run 审批都显示范围选项）
  - `apps/control-center/src/components/run-approval-card.tsx:132-143`（对这些审批逐个发 `approval.allowance.set`）
  - `apps/control-center/src/run-approval.ts:143-156`（`approvalAllowanceChoices` 只排除花钱/凭证/本人在场）
  - `apps/agent-service/src/owner-scope-authorization.ts:357-370`（唯一调用 `allowances.match` 的地方）
  - `apps/agent-service/src/production-file-read-services.ts:312-321`、`apps/agent-service/src/production-coding-workflow.ts:413-415`（编码/文件授权走 `policy.evaluate`，不查 allowances）
- 问题：范围选项目前对“所有非搜索 run 审批”开放，服务端 `set` 也会接受任何 `status=approved` 且无 `policyAuthorization` 的审批并落库；但只有 `OwnerScopeAuthorization.decide` 会去 `match`。编码（bash/write/edit/…）和文件读取的审批实际由 `production-file-read-services.ts` 里的 `authorize` 直接 `policy.evaluate`，从不查 allowances。结果是主人选了“以后都行”，下次同样的动作仍会弹卡片；设置页还会把它列成一条有效授权，误导主人以为已授权/可收回。这与规格“同意卡片能选范围”“同样的动作不再问”不一致（也即作者说法 4/7 只覆盖了 owner-scope 和 device 两类）。
- 证据：
  - `const choices: readonly ApprovalAllowFor[] = snapshot && !isSearch ? approvalAllowanceChoices(snapshot) : ["once"];`
  - `await options.workspaceAuto?.authorize(intent); return policy.evaluate(intent, {...});`
  - `const allowance = standing === undefined ? await this.#options.allowances?.match(intent) : undefined;`
- 建议：在审批快照里暴露“是否走 owner-scope/设备授权”，只在能真正消费 allowance 的审批上显示范围；或为编码/文件路径实现单独、且不排除 input-digest 的精确范围（否则 bash 会被过度放行）。补一条“编码审批选以后都行后第二
