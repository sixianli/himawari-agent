PR 518 在设置的“Himawari 自己”组里加“待采纳的改进”页（iOS 原生）。服务端的 suggestion.list、suggestion.detail、suggestion.respond 已在 PR 426 登记到能力表（respond 是“改”档，要过面容）；本 PR 只加手机端。

目标：页面按已批准的原型实现；每条改进显示摘要、效果、可展开的依据，按钮固定为“不要”和“采纳”（不可采纳的不显示“采纳”）；没有生产数据时整行不显示。

约束：
- 数值只来自 DesignTokens 和 Layout，没有按种类写死的分支，没有代码注释，不用词表猜意思。
- 服务端没有对外暴露 PROPOSAL_* 原因码，所以拒绝后手机端重新读取列表，按“不在了/版本或指纹变了/其他”三种结果处理（SettingsStore.respond 返回 ProposalOutcome）。

作者的说法：
- Swift 在 Mac 上编译和 swift test 由 Mac 线程做；这台机器没有 Swift。
- 风险档不显示，由设计线程确认。
