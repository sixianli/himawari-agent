这个 PR 把网页上“添加记忆”和“导入记忆”靠词表（guessCategory）和正则（RULE）猜类别和是否敏感的做法，改成服务端的模型判断（Andy 2026-11-12 的原则：理解意思交给模型，程序只做校验）。决策记录 docs/adr/0260。

改动：新查询 memory.classify.read（packages/gateway-contracts/src/contracts-v2.ts）；服务端分类器 apps/agent-service/src/production-memory-classification.ts（确定性检测命中的不发给模型直接标敏感，其余按字数分批，失败、漏项、每日额度用完一律按敏感）；apps/agent-service/src/production-memory-control.ts 的 #classify 和 #createMemory（memory.create、memory.import.commit 带 topic，存前按健康/财务类别和确定性检测取高，必要时另存一份敏感级别的受保护内容）；service-main 用主动检查配置的模型和 dailyCostMicros 装配；网页 apps/control-center/src/memory.ts、memory-import.ts、components/memory-page.tsx。

约束：不改表（额度在进程内存计数，用量记在 memory-capture 用途下）；网页不加新操作；后台调用不改对话请求开头；敏感级别只升不降；判断失败一律按敏感、默认不导入。

请特别查：敏感级别能否被网页绕过而存成 private；分类请求里是否可能把证件号或密钥发给模型；每日额度是否能被绕过；导入预览在分类未完成时能否提交；契约改动（topic 必填）对现有调用方是否都改到了；日志会不会带出记忆原文。
