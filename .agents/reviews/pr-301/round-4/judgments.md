# PR 301 第 4 轮复核：线程判断（复核 6d13d446，增量自 ad9efa55）
费用：本轮 0.0779，累计 0.7482 美元（<1 美元先问线）。只跑 DeepSeek，经 Magpie，ok。原文同目录。（读代码判断，未运行测试；Hermes 86 条通过是作者的说法，未核实。）

## 结论
有 1 条中、高的“会出错”（意见 2），其余是低或可以更好。放行 cancel_unresolved 本身不丢账、不会误收尾在进行的调用（见下“两个重点”）。

## 两个重点
- 会不会丢账：不会。settleExpiredSync 只写 runs、run_coordination_checkpoints、run_execution_leases 和回执（sqlite-run-dispatch-operations.ts:486-537），不碰 model_invocation_identities 和 model_budget_*，所以调用行和预算账户原样保留。预算账本只是用量记录和防重发门禁，不是费用上限（ADR 0076 第 41 行、ADR 0124 第 55-56 行）；账户按 run 记，终态 run 不会再派发（sqlite-run-dispatch-operations.ts:264-270）。
- 会不会误收尾在进行的调用：cancel_unresolved 只在 signal.aborted 之后写入（pi-runtime-adapter.ts:810、856、1031；trusted-model-provider.ts:274），即取消已发出；新分支还要求诊断码是 RUN_EXECUTION_DEADLINE_EXCEEDED、外层要求资源已释放、没有沙箱记录，并且包装器在截止前不收尾（production-run-expiry.ts:72，模型引用，我未逐行核）。reserved、started 仍挡住。

## 意见与判断
1. DS“中”：放行后没有对账路径，账目永久挂起。判：不成立为代码缺陷，但 I-88 的“留待对账”字样会让人以为有对账程序。会出错·低（文字与事实不符，不会让人做错事）。触发：后来的人读 I-88 以为会有程序结算这笔 unknown。后果：预期落空，无行为错误；第二条分支本来就不管模型调用，同样留着不管。建议：I-88 改成“保持原样，没有自动对账，仅作记录”。我判得比模型低，理由见上（ADR 0076 账本不是上限、账户按 run 记）。
2. DS“中”：只放行 cancel，provider/transport 的 unknown 仍会像 I-88 一样卡住，且与第二条分支（完全不看模型调用）不一致。判：成立。会出错·中高。触发：一个运行因 transport_unresolved 或 provider_unresolved 留下 unknown，之后到执行截止时间，且没有沙箱记录。后果：重现 I-88，运行永远停在 reconciling_external_result，上线时 TWENTYNINTH_MAINTENANCE_NON_TERMINAL_RUNS 拒绝并回滚。不确定它在生产里多常见，按规则拿不准归中高。cancel 与 transport 对“请求已发出、结果未知”的不确定程度相同，作者没说为什么区别对待。两条路二选一：A 放宽成所有 unknown 原因都放行（与第二条分支一致，账本不是上限）；B 保留，在 I-88 “未覆盖”里写明原因和后果，并说明这类运行同样要离线收尾。B 只改文档，改后可按低记账。
3. DS“低”：I-88 把 cancel_unresolved 写成“到期取消后”，代码里任何 signal.aborted 都写它。判：会出错·低，模型也判低。触发：用户停止等非到期取消也写这个原因码。后果：文字偏窄，本分支因诊断码限定影响很小。建议改成“调用被取消（含到期取消）后结果未确认”。与意见 1 同一行文字，一起改。
4. DS“低”：新用例预留被写成 0，证明不了“预估费用不释放”。判：成立，会出错·低（核对用的临时测试我未实际运行，规则要求未运行按“会出错”）。依据：test/integration/sqlite-sandbox-execution-v2.test.ts:1218、1232 的账户 reserved_cost_micros 和分配 estimated_cost_micros 都写 0。触发：以后有人让收尾释放非零预留，这个用例仍通过。建议 cancel 场景写非零预留和非零 spent，断言原样保留。
5. DS“低”：NULL 原因码的 COALESCE 分支是 schema 禁止的死防御，原因码字面量到处重复。判：可以更好。依据：migrations/0049_thread_title_budget.sql:75-76、156-157 的 CHECK 保证 unknown 必有原因码；COALESCE 只是安全失败方向，删或留都不改变可观察行为。字面量抽共享常量是重构，不改行为。
6. DS 推测：abort 与 provider 异常同时发生时被记成 cancel，可能掩盖服务商问题。判：不成立。signal 已 aborted 时取消确实是原因，而且这样的运行本来就在被终止。
7. DS 推测：截止前候选重复扫描开销，无生产数据。判：可以更好，第 3 轮 r3-d3 已判过，作者和 I-88 已披露。
