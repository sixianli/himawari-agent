这个 PR 让合并前的复核每一轮更快、少无谓重跑（ADR 0270，Andy 2026-11-14 同意）。范围：A 增量轮（带 --previous）的提示里放进上一轮已提交 verdicts.jsonl 里成立的“会出错”意见，收窄成三件事，固定前缀和必答问题不变；B --accept-low 的测试文件识别加 Python/Go/Rust/Java 模式，并把每次被拒的原因记到 low-fix-refusals.jsonl；D 自检缓存（7 天、摘要相同时只对第一个模型跑一次探针，PR 自带 AGENTS.md 和副本未被改动两项检查每个 PR 照跑）；C 的一部分：plan-claims 的“文件:行@完整提交哈希”引用旧提交、同一句同一模型的 model-wrong 判断跨轮沿用。主要改动在 scripts/model-review/opencode-review.mjs 和 scripts/model-review/plan-claims.mjs，测试在 test/tooling/。

约束：所有轮次的提示固定前缀必须逐字节相同，只有末尾“本次材料”会变；不写死数值，上限留在代码常量里；自检缓存不能让环境变了还放行；沿用判断不能让证据已不在当前提交的判断通过；提交作者 Andy，只用 DeepSeek。

请特别查：缓存键漏了哪些会变的东西、缓存目录并发或损坏文件的处理、上一轮意见里的文字能否注入提示（不可信内容）、@提交哈希的校验能否被构造绕过合并检查（共同祖先判断、40/64 位十六进制）、判断沿用是否会跨 ADR 或跨模型串用、isTestFile 新模式会不会把非测试文件当成测试、测试是否有反向用例。
