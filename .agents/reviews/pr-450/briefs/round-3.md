# PR 450 第 3 轮：作者说明

第 2 轮之后改了两处：实测记录文件 `.agents/evidence/ci-queue-2026-11-12.md` 里两行换了先后（内容没变），以及下面这一处，请重点看它：

`scripts/model-review/plan-claims.mjs` 的 `quoteInText`：第 2 轮指出按全角分号拆开后只查“每段在文件里”，颠倒顺序或互不相干的真实片段拼起来也能通过。现在分号这条路要求各段按文件里的先后顺序依次出现（后一段从前一段结束的位置往后找），每段至少 4 个字符。用“…”省略中间的原有行为不变（原来就不查先后）。`test/tooling/plan-claims-gate.test.mjs` 加了三条反向断言：顺序颠倒、同一段重复两次、两段互换。`.agents/instructions/model-review.md` 的规则文字同步，并把“编了引文都过不了”改成准确的说法。

第 2 轮的第 2、3 条判为“可以更好”，没有改，理由见 `round-2/judgments.md`。

实际跑过的检查：`test/tooling/plan-claims-gate.test.mjs` 37 条通过；`biome lint` 和格式检查通过。
