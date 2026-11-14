这个 PR 是 PR 496（ADR 0270，复核提速）收尾：补三条复核里的“可以更好”。范围：scripts/model-review/opencode-review.mjs 把自检缓存命中时跳过哪些探针抽成 selfCheckSteps（命中只探第一个模型，跳过 guardProbe、passthroughProbe、failoverProbe，网关安装检查照做）；scripts/model-review/plan-claims.mjs 里 `文件:行@提交` 的引文，除了同一文件，还要看那个提交到当前提交之间新增、改动、改名的文件（最多 400 个，跳过复核记录目录和非法路径），代码挪了地方也报 commit-quote-still-in-head；沿用 model-wrong 判断时，同一句有几条旧判断就挑证据仍在的那条。测试在 test/tooling/plan-claims-gate.test.mjs、opencode-review.test.mjs，说明在 .agents/instructions/model-review.md 第 44 行。

约束：selfCheck 的行为不变（只是把“跑哪些步骤”抽成函数）；不放行没核对的说法，只会多拒绝；不写死数值（400 是代码常量）；只用 DeepSeek。

请特别查：selfCheck 重构后每个步骤的执行条件是否和原来一致（包括 gateway 为空、cached 为真的组合）；挪文件检测会不会误报（二进制文件、很大的 diff、重命名、复核记录目录里的文件）；挑证据仍在的判断时，会不会让一条已经失效的判断被放行；测试是否真有反向用例。
