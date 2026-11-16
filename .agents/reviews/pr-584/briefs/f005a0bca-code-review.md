本轮改了什么：提交 f005a0bca（上一轮复核到 db8b2868f，之后的 e29cbea7c、a6b2ceef5 只是复核记录）。

为什么改：PR 584 自己的增量轮仍然慢。逐步读原始调用记录发现：增量轮提示虽写了“只做三件事”，后面紧跟整个 PR 的材料（每轮同一份），固定任务又要求“作者说法每一条都要核对”，模型每轮重核整个 PR；范围说明叫它“用 git grep 找”，git grep 却不在放行名单里，模型反复换写法被拒。

作者的说法（只针对本轮增量）：

1. 带 --previous 的代码复核会算出材料的 sha256（briefSha256），在读工作区账本后，若同一账本里有别的提交（head 不同）、非 shadow 的代码复核记录的 briefSha256 相同，就以 REVIEW_BRIEF_REUSED 拒绝，且在任何模型调用和花钱之前；同一个提交上重跑不被拒；没有 briefSha256 的旧记录不参与比对。
2. 每条代码复核账本记录新增 briefSha256 字段；其他模式不加；现有的账本校验和读账本的地方都能接受这个新字段。
3. buildPrompt：所有模式的固定部分多一句 TOOL_USAGE_SENTENCE；带 previous 的代码复核把材料标题换成 ROUND_MATERIAL_TITLE，并在两种增量说明（有内联增量 / 退回整段）里加 SCOPE_SENTENCE，“用 git grep 找”改为“用 grep 工具找”；第 1 轮的提示除固定部分多的那一句外不变。固定部分对同一模式的所有轮次仍然逐字相同。
4. 新增 --pr-brief：只能和 --mode code-review、--previous 一起用、不能和 --shadow 一起用，文件必须存在；SHADOW_FULL_SUGGESTED 打印的命令优先用它作 --brief。
5. --finish-round 打印的 NEXT 命令占位符改为 <本轮材料> 和 <整份 PR 材料>，流程卡写明每个占位符怎么换，测试同步。
6. 文档（流程卡、子代理定义、model-review.md、ADR 0280 新节）与代码一致。
