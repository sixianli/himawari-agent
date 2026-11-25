# PR 632 复核材料

## 问题和目标

ADR 0285 决定 7，规格 docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md “权限和审批”第 3 条：同意卡片可选“只这一次”“这件事里都行”“几天内都行”“以后都行”；花钱只给“只这一次”；“几天内”“以后都行”读过外来内容后不算数；给过的同意在设置里能看、能收回。

## 约束

- 管权限的是模型之外的程序，模型改不了；这个 PR 不改工具定义和系统提示。
- 规则从严：内置规则拒绝的，范围不能放行；只在“会问主人”的时候查范围。
- 收回要立刻生效，包括已经发出、还没用掉的授权（数据库在用掉授权前复核 product_state_records 那条记录 enabled 为 true 且 revision 没变）。
- 不写代码注释；不用词表猜意思。

## 作者的说法（请核对）

1. 只有主人亲手同意过的审批（status 为 approved，且不是规则预先放行的 policyAuthorization）能存成范围。
2. “这件事里”只对同一个 threadId 生效，读过外来内容也算；“几天内”“以后都行”在动作带 context_external_content 事实时不算。
3. 花钱（estimatedCostMicros > 0 或 PURCHASE_OR_FUNDS）、credentialOrAccessChange、owner_presence_required 的动作，服务端拒绝存范围，查范围也不命中；网页也不显示范围选项。
4. “同样的动作”的判定不含这一次的参数（input-digest），含工具、操作、动作种类、外发范围、副作用、收件人、其余目标；不同收件人、不同设备、不同设备动作不会互相放行。
5. 收回后 match 不再命中，已经发出、还没用掉的授权在用掉时被数据库拒绝。
6. 到期的“几天内”不命中，也不出现在设置列表里。
7. 新命令 approval.allowance.set 和快照里新增的 allowances 字段，在契约、服务端、网页、测试夹具、生成的 iPhone 能力清单里一致。
