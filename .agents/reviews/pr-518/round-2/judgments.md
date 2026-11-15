# PR 518 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1 [需确认/中] 需要先看全文的提案只在点“采纳”时自动换令牌，页面从未展示全文，也没有要求先展开依据。SettingsStore.swift:121-124 采纳时自动 openFullText；ProposalsPage.swift 依据默认折叠；architecture-v0.1.md:431 写“客户端打开全文时换凭据”。已改为 requiresFullRead 且有依据时，依据展开前“采纳”按钮不可点（ProposalsPage.swift:106）；未编译；触发：提案 requiresFullRead 为真（外部内容引出的提案一定如此）时直接点采纳；后果：客户端静默换到全文令牌，主人没展开依据就能采纳，绕过“先看全文”的本意
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2 [低] 演示和测试里的提案时间戳仍不是网关合约要求的格式。ManageDemo.swift:182、ProposalsTests.swift:20,48,52,143 已全部改成 .000Z；触发：用 Demo 或测试数据当合约证据时；后果：时间戳缺毫秒，过不了 validation.ts:128-137 的规范时间戳；只影响演示和测试数据，Swift 只当字符串解码，不发往后端
- 3（deepseek-v4.1-flash）不成立：### 3 [低] 依据里的 `sources` 仍然完全不显示。沿用第 1 轮第 8 条原判：sources 是内部引用不是给人看的文字，brief 只要求摘要、效果、依据文字和数字；ProposalsPage.swift evidence 显示 text 与 figures 即满足
- 4（deepseek-v4.1-flash）不成立：### 4 [低/需确认] 空列表时设置根页仍显示“没有”整行。沿用第 1 轮第 9 条原判：brief 的“没有生产数据时整行不显示”指读不到（store.proposals 为 nil）；服务端返回空数组是有数据且为零，显示“没有”是对的，SettingsRootView.swift:60 条件按此写
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5 [低] 测试仍是自造 transport，新失败用例也没有核对“原始错误”。ProposalsTests.swift testAFailedRereadAfterARejectedCommandKeepsTheOriginalError 已改为断言抛出 ManageGatewayError.rejected 且 status 为 409；自造 transport 部分沿用第 1 轮第 6 条原判，不新增合约解析测试（本机无 Swift，Node 侧合约另有测试）；未编译；触发：改坏失败路径后抛出别的错误；后果：用例仍通过，守不住“保留原始错误”；只影响测试可信度
- 6（deepseek-v4.1-flash）不成立：### 6 [低/需确认] 作者说服务端用 `suggestion.*`，页面实际调用的是 `proposals.*`。沿用第 1 轮第 4 条原判：代码用 proposals.read / proposal.respond 是对的（architecture-v0.1.md:428,431；Web 端 memory.ts:145,188），suggestion.* 是 brief 措辞错误，不是代码缺陷
