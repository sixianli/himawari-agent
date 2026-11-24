CLAIM|1|一致|docs/adr/0229-native-apple-clients-and-device-api.md:94|ADR 0229、ADR 0230、ADR 0247 定了做 iPhone、Apple Watch、Mac 的原生客户端|iPhone、Apple Watch、Mac 各有原生 App，是三种要配对的设备；随身麦克风经蓝牙接到 iPhone 或 Mac，它没有自己的密钥，不单独配对，算那台设备上的一个采集来源。
CLAIM|2|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:12|ADR 0230 定了感知到的东西怎样变成记忆和提醒|# ADR 0230：设备感知到的东西存成感知记录，不拼进对话；主人亲口说的才能直接成为记忆和提醒
CLAIM|3|一致|docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:60|ADR 0247 定了 App 里全部用原生界面|聊天、语音、记忆、规则、设置、审批、提醒记录、文件、用量、“感知到的”、设备管理、数据导出，以及网页上的能力、授权、帮手、待采纳的改进、工作区、服务器状态，在 iPhone 上都是原生页面，按手机的用法重新设计。
CLAIM|4|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:691@d42a3a0a53ae5b3b1d041c2278b215609c4cff2d|Mac 端原先要一直收听、认屏幕上的字（见前提 11）。|&nbsp;&nbsp;&nbsp;&nbsp;| Mac App     | 常驻菜单栏：收听、屏幕认字、前台 App、读信息、剪贴板、Mac 上的动作                                |
CLAIM|5|一致|docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:49|iPhone 上原先 16 个网页页面一个不落都要做，包括平时只在电脑前才看的运维页。|网页有一份页面清单，16 个页面，每个页面有 `queries` 和 `mutations` 两栏，有的是空的，列了的也不全。
CLAIM|6|一致|apps/control-center/src/app/control-center-inventory.ts:31|网页的页面清单里有这三页：`"host-workspaces"`|&nbsp;&nbsp;&nbsp;&nbsp;| "host-workspaces"
CLAIM|7|一致|apps/control-center/src/app/control-center-inventory.ts:34|网页的页面清单里有这三页：`"workers"`|&nbsp;&nbsp;&nbsp;&nbsp;| "workers"
CLAIM|8|一致|apps/control-center/src/app/control-center-inventory.ts:39|网页的页面清单里有这三页：`"health-deployment"`|&nbsp;&nbsp;&nbsp;&nbsp;| "health-deployment";
CLAIM|9|一致|docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:66|ADR 0247 的能力表本来就有“手机上不做”这一档。|&nbsp;&nbsp;&nbsp;- 手机上不做：写明原因，设备接口拒绝。
CLAIM|10|一致|docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:69|ADR 0247 要求补画的原型先给 Andy 看。|原型没画到的页面由设计线程补原型给 Andy 看过再做。
CLAIM|11|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:108|ADR 0230 让感知这一路自己建提醒，并另有“建议”。|时间和对象清楚、并且是主人本人说出口或答应了的：直接建提醒或日历事件并告诉主人，可一键撤销；说不清的问一句。来自“其他”的只能生成建议，主人点一下才建。
CLAIM|12|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:92|ADR 0230 决定第 3 条原话：“只能产生待确认记忆和“建议”。”|标记是“其他”的感知记录，在代码层不能直接产生正式记忆、提醒、日历事件、设备动作或审批结果，只能产生待确认记忆和“建议”。
CLAIM|13|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:93|ADR 0230 按“这一轮”管读过外来内容之后的动作。|对话里也守同一条线：模型用 `perception_read` 读过“其他”来源的内容之后，这一轮里有后果的动作要过一道程序检查。
CLAIM|14|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:109|ADR 0230 让每个来源各带一套判断。|每个来源登记自己的提示词、解析器、去重键、预算、开关和评测集
CLAIM|15|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:119|ADR 0230 把“感知到的”页放在网页上。|网页上有“感知到的”页：按天、按一段经历看转写，看记下了什么、为什么没记。
CLAIM|16|一致|docs/adr/0229-native-apple-clients-and-device-api.md:146|ADR 0229 把“Mac 上一直看屏幕”当成做 Mac 端的理由之一。|它们各有 iPhone 做不到的事（手腕收音、Mac 上一直看屏幕、麦克风不间断）。
CLAIM|17|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:35|Andy 同意了“一个主对话加子线程、所有新事情走同一个收件箱”的方案，来源 ADR 0285 决定第 1 条。|**一个主对话。** App 和网页只有一个主对话，没有新建对话的入口。Andy 的消息、她主动说的话都在这里。
CLAIM|18|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:39|ADR 0285 决定第 5 条原话：“进度放在点开才看的“后台在办”。她只在真有新东西或要 Andy 拿主意时开口……开口时可以在消息下给可点的下一步选项；带具体动作的选项按钮文字由程序按真实参数生成，点了算这一次的同意。”|进度放在点开才看的“后台在办”。她只在真有新东西或要 Andy 拿主意时开口（照 Meta Muse 的“only when something is meaningfully new or needs your input”），开口时可以在消息下给可点的下一步选项；带具体动作的选项按钮文字由程序按真实参数生成，点了算这一次的同意。
CLAIM|19|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:38|同一份 ADR 删掉了“想一想”和首页要紧度打分。|删掉 7 处替她做决定的小判断和公式：感知五个分来源检查和条数上限、首页要紧度打分（ADR 0255）
CLAIM|20|一致|docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:62|同一份 ADR 把 App 的样子交给苹果端设计线程。|App 界面交苹果端设计线程。
CLAIM|21|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:37|Andy 同意了“有后果的工具调用走同一个出口”的方案|本 ADR 把方案线程 2026-11-12 定稿的整合方案（仓库副本 [.agents/plans/owner-scope-approval.md](../../.agents/plans/owner-scope-approval.md)）记成决定。Andy 2026-11-12 22:11 JST 在方案线程的卡片上选了 A：加主人意图核对，评测过了才打开；22:07 JST 提出核对模型用 Jev。
CLAIM|22|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:132|它按上下文而不是按一轮记外来内容。来源第 76 行原话：“事实按**模型现在还看得到的上下文**记，不只按一轮记”|事实按模型现在还看得到的上下文记，不只按一轮记。压缩出来的摘要如果来自外来内容，摘要也算外来。后果：一个对话读过外来内容之后，基本上到结束都算“有外来内容”。苹果端设计写的是“这一轮”（[前提 17](#premises)），这里收紧了。
CLAIM|23|找不到|-|来源项目共享文件夹 `owner-scope-approval/integrated-plan.md` 第 3 行原话：“状态：定稿。Andy 2026-11-12 22:11 JST 在卡片上选了 A”；第 65 行原话：“`device_action` 做的时候，苹果端设计里那张动作登记表的每一行就是这张表的一行。”|-
CLAIM|24|一致|docs/adr/0286-the-main-model-reads-and-writes-memory-itself.md:49|锁屏推送改成显示全文。来源 ADR 0286 决定第 4 条原话：“取消敏感内容审批，不再给记忆标“敏感”：健康、财务、人际关系、银行卡号、证件号都直接记、原样给模型，锁屏推送显示全文”|取消敏感内容审批，不再给记忆标“敏感”：健康、财务、人际关系、银行卡号、证件号都直接记、原样给模型，锁屏推送显示全文
CLAIM|25|一致|docs/adr/0229-native-apple-clients-and-device-api.md:125|ADR 0229 决定第 9 条原话：“苹果推送的内容经苹果的服务器，所以锁屏规则里“敏感或受限的只显示一句提示”同样适用于它。”|推送规则（第 5 条）对两条通道都适用：锁屏上显示多少内容、正在看 Himawari 时不推、同一件事不重复推、通知固定文字按设备语言。苹果推送的内容经苹果的服务器，所以锁屏规则里“敏感或受限的只显示一句提示”同样适用于它。
CLAIM|26|一致|docs/adr/0229-native-apple-clients-and-device-api.md:166|ADR 0229 后果原话：“苹果推送的内容经过苹果的服务器，所以沿用锁屏规则，正文不放进推送。”|苹果推送的内容经过苹果的服务器，所以沿用锁屏规则，正文不放进推送。
CLAIM|27|一致|docs/product-vision.md:55|原则冲突时的顺序。来源 `docs/product-vision.md:55` 原话：“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|28|一致|docs/product-vision.md:60|主动要算打扰成本。来源 `docs/product-vision.md:60` 原话：“预判的收益必须大于打扰我的成本”。|4. **在边界内主动** — 等待指令是底线，预判需求是目标，但预判必须建立在已有记忆与明确偏好之上，且预判的收益必须大于打扰我的成本。
CLAIM|29|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:89@d42a3a0a53ae5b3b1d041c2278b215609c4cff2d|原先的详细设计在服务器那一批里也做“网页上的新页面”。|- 服务器：设备配对和接口、连接、感知记录、感知抽取、来源登记、送达时机、苹果推送、设备工具、上限和用量、删除规则、网页上的新页面。
CLAIM|30|一致|docs/adr/0229-native-apple-clients-and-device-api.md:94|ADR 0229 决定第 1 条“iPhone、Apple Watch、Mac 各有原生 App”不变。|iPhone、Apple Watch、Mac 各有原生 App，是三种要配对的设备；随身麦克风经蓝牙接到 iPhone 或 Mac，它没有自己的密钥，不单独配对，算那台设备上的一个采集来源。
CLAIM|31|一致|packages/gateway-contracts/src/client-capabilities.ts:382|客户端能力表（`packages/gateway-contracts/src/client-capabilities.ts` 的 `CLIENT_PAGE_TABLE`）和由它生成的 Swift 现在还是旧的对应（`approvals` 对 `today.approvals` 等）|&nbsp;&nbsp;{ webPage: "approvals", nativePage: "today.approvals" },
CLAIM|32|一致|clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:69|由它生成的 Swift 现在还是旧的对应（`approvals` 对 `today.approvals` 等）|&nbsp;&nbsp;&nbsp;&nbsp;case todayApprovals = "today.approvals"
CLAIM|33|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:305|每一页的去处见详细设计里“网页的 16 个页面在 iPhone 上的去处”那张表|网页的 16 个页面在 iPhone 上的去处（原型见[界面照哪一版做](#ui-baseline)和第 4 版目录里的 `README.md`）：
CLAIM|34|一致|packages/gateway-contracts/src/client-capabilities.ts:388|它们留在电脑网页，在客户端能力表里登记成“手机上不做”并写明原因：`host-workspaces`|&nbsp;&nbsp;{ webPage: "host-workspaces", notOnPhone: WEB_OPERATIONS_ONLY },
CLAIM|35|一致|packages/gateway-contracts/src/client-capabilities.ts:391|它们留在电脑网页，在客户端能力表里登记成“手机上不做”并写明原因：`workers`|&nbsp;&nbsp;{ webPage: "workers", notOnPhone: WEB_OPERATIONS_ONLY },
CLAIM|36|一致|packages/gateway-contracts/src/client-capabilities.ts:400|它们留在电脑网页，在客户端能力表里登记成“手机上不做”并写明原因：`health-deployment`|&nbsp;&nbsp;{ webPage: "health-deployment", notOnPhone: WEB_OPERATIONS_ONLY },
CLAIM|37|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:94|主人直接对 Himawari 说的话（ADR 0230 决定第 4 条）仍然是指令，照旧直接办。|**主人对 Himawari 说的话是指令，其余都是数据。**
CLAIM|38|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:7|ADR 0257 的 `amended_by` 写明|amended_by: "docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md"
CLAIM|39|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:89|ADR 0230 决定第 3 条的其余部分不变：入库时的标记|**每条感知记录入库时就带“主人本人说的”或“其他”的标记，界线写在代码里。**
CLAIM|40|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:111|ADR 0230 决定第 9 条不变：每个上限都看得见|**每种感官单独开关，默认全开；每个上限都看得见（修改 ADR 0106 第 6 条里的一句话）。**
CLAIM|41|一致|docs/adr/0230-perception-records-and-memories-inferred-from-perception.md:116|ADR 0230 决定第 9 条不变：每个上限能改|上限可以在同一个地方改，改动写决策记录。
CLAIM|42|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:86|保险箱方案 v5，见详细设计前提 S14|S14 | 保险箱的存放和批准流程由保险箱方案 v5 定
CLAIM|43|一致|docs/assets/apple-clients/2026-11-25-v4/README.md:10|现行基线是 `docs/assets/apple-clients/2026-11-25-v4/`|这个目录是 iPhone App 下一版照着做的界面，取自在线原型第 64 版
CLAIM|44|一致|docs/assets/apple-clients/2026-11-25-v4/README.md:14|按打开 App 后的顺序排成九组，说明里写清每一屏的出处。|`01` 到 `09`：一排画板一张图，一倍清晰度，每部手机宽 390 点。从上到下就是打开 App 后的顺序。要量准确的数值，看 `tokens.json` 和 `source/`。
CLAIM|45|一致|docs/execution/specs/2026-11-11-apple-device-body-design.md:96|详细设计和实施计划已照这份 ADR 改|网页不加新页面（Andy 2026-11-12：“有 APP 版就不再做网页版啦”）；网页现有的“设置 → 设备”保留，第一台设备的配对和手机丢了以后的移除都靠它。
CLAIM|46|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:11|实施计划已照这份 ADR 改|[SOURCE: docs/adr/0258-each-apple-device-plays-to-its-strength.md]
CLAIM|47|一致|docs/execution/plans/2026-11-11-apple-device-body-plan.md:61|分批表里 Mac 端的范围变小|10B Mac App（菜单栏：输入条、拖文件、动文件、面板、一页设置；六个 Mac 动作登记进第 9 批那张表）
CLAIM|48|找不到|-|其中“派出去的帮手”线上现在没有内容。|-

项目共享文件夹里的 `owner-scope-approval/integrated-plan.md` 不在仓库内、也无法读取，因此第 3、65、76 行的行号引文未核实；“派出去的帮手线上现在没有内容”没有仓库证据可查。
