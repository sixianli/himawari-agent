# PR 616 复核材料

只改两份规则文字：`.claude/rules/owner-standing-rules.md` 的“授权、上线和合并”一条，`.agents/instructions/model-review.md` 第 5 步一句。

目标：Andy 2026-11-24 原话“为什么都要让我说合并啊？合并你就让他们合就行了，老是让我介入。我很忙的，我没那么多时间”。线程在复核无中高、过了合并条件时自己合并所有 PR（含改模型调用、权限、表、设计文档和规则），不再等 Andy 说“合并”；上线生产、动生产数据、花钱超先问线仍问。

请核对：新文字和同一文件、`.agents/instructions/delivery-mode.md`、`AGENTS.md`、`model-review.md` 其他地方有没有互相矛盾、遗漏仍写着“等 Andy 说合并”的现行规则；有没有把仍需 Andy 的上线、生产数据、花钱规则误放开。
