# PR 429 作者说明

问题：iOS 规则详情页要显示主人原话、修改次数和最近一次使用，网关的 `memory.rules.read` 没有这些信息。
目标：只在服务器端给每条规则加 quote、changes、lastUsed 三个字段，网页共用；不改表，不改发给模型的内容。
做法：quote 取规则对应记忆文本去掉摘要后缀的部分；changes 是规则版本号减 1；lastUsed 在决定账本里按规则编号（带或不带版本，精确匹配，不做前缀混淆）查最近一次用到它的决定。停用规则已有 `memory.rule.respond` 的 undo，不重复加命令。做法只是参考，若你认为有更好的做法请提出。
已核对：8 个 Layer-0 相关测试文件 297 项通过（含新增账本用例和 production-memory-capture 正反向断言）；format、两套 tsc、check:operations 通过。
