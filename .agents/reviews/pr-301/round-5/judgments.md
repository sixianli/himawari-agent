# PR 301 第 5 轮复核：线程判断（复核 676119ef，实质改动 b15f13db，增量自 6d13d446）
费用：本轮 0.1005，累计 0.8487 美元（<1 美元）。只跑 DeepSeek，经 Magpie，ok。原文同目录。判断是读代码得出，未运行测试；Hermes 86/967 条通过是作者的说法，未核实。

## 重点问题的回答：放行所有 unknown 后会不会收掉还在进行的调用
不会。模型引用并经我核对的依据：unknown 是适配器里的本地终止状态，写完 unknown 后立即返回，同一 permit 不会再结算（pi-runtime-adapter.ts:789-890、trusted-model-provider.ts:223-293）；还在进行的调用是 reserved 或 started，第三分支仍挡住它们。收尾后若有迟到结算，持久层接受并补记费用（settleWithinTransaction 只校验权限租约，不校验 run 租约和状态，sqlite-model-invocation-operations.ts:643-647、828-834），不是丢账也不是重复。

## 意见与判断
1. DS“中低”：started 仍可能因崩溃或 markUnknown 写库失败（pi-runtime-adapter.ts:1080-1081 吞掉错误）永久停在 started，同类运行又会卡死。判：成立，会出错·中高（拿不准按中高）。触发：模型调用已 markStarted，进程在 markUnknown 前崩溃（例如服务在流式输出中重启）或 markUnknown 写库失败，之后运行到执行截止时间且没有沙箱记录。后果：重现 I-88，运行永远非终态，上线被 NON_TERMINAL_RUNS 拦下回滚。我查了 started 不会被启动或巡检转成 unknown（sqlite-model-invocation-operations.ts 只在 markUnknown 一处转换）。但这不是本改动引入的，其他分支同样挡 started，修法（启动时把无主的 started 转 unknown）属于改模型调用恢复机制，按项目规则算大改动要先出方案。我的建议：本 PR 只在 I-88「未覆盖」写明「崩溃留下的 started 不在范围」，另开事项由 Andy 定要不要单独出方案；这样改动只在文档里，可按低记账。是否接受由 Andy 定。
2. DS“低”：第三分支的诊断码条件没有反向用例（诊断码是 RUNTIME_TOOL_RESULT_UNKNOWN、无沙箱记录、有 unknown 模型调用、未到截止时间）。判：成立，会出错·低（缺反向用例；我没有临时运行，按规则不能算“可以更好”）。触发：以后有人误删诊断码条件。后果：该组合在截止前被收尾，现有用例不失败。建议补这条反向场景。
3. DS“低”：I-88 的「unknown 不挡收尾」可能被读成全局规则，且没说迟到结算的结果。判：可以更好。依据：该句在 docs/incidents-and-gates.md:122 的「新增第三种情况」之内，主语已限定第三种情况；补一句迟到结算只是增加信息，不改变事实陈述。
