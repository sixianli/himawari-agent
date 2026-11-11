# 审核结论

## 证实的（按严重度从高到低）

### 1.【高】主动检查“来源登记”迁移的校验面清单严重不全——这正是 I-73 的翻版风险

方案第 9 节第 8 条只说“现在表里写死 Gmail 的约束要迁移”，新值清单里只有“主动检查的来源名和场景名”一句话。但 `source` / `scenario` 被写死为 `'gmail'` 的地方远不止“表”：

- SQLite 迁移里的 CHECK 约束：`packages/persistence-sqlite/src/migrations/0062_proactive_checks.sql:15,29,50,72`、`0069_decision_ledger.sql:11,80,102`、`0087_rule_book_memory_link.sql:27,88,118`（`source TEXT NOT NULL CHECK (source IN ('gmail'))`）。SQLite 不能 ALTER 修改 CHECK，迁移必须重建表并搬数据。
- 导出/导入校验也会拒绝新来源：`packages/persistence-sqlite/src/data-export/schemas.ts:199,253,273`（`enumOf(["gmail"])`）。导出快照的读者端校验不放宽，新来源的数据导出即报错——I-73 里“清单 id 过不了发送校验”的同构问题。
- TypeScript 类型 55 处引用 `ProactiveSource = "gmail"`（`packages/application/src/ports/proactive-checks.ts:4` 及全文件）。
- 决策账本查询写死来源：`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:643`（`WHERE ... source = 'gmail' AND message_id = ?`）、`:707`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:28`（`const SOURCES = ["gmail"] as const`）。

**建议**：把第 9 节的“新值清单”升级为逐值“产生处→使用处→两端校验→自动检查”核对表（方案已承诺在详细设计时做，但上面这些点现在就能列出来，不该等到那时）；照 I-73 的做法立一道 `check:*` 门槛，例如“每个登记的来源都要能通过迁移后的 CHECK、TS 类型、导出 schema 三处校验，去掉门槛即失败”；迁移方案明确写“重建表”而不是“改约束”。

### 2.【高】门槛“感知记录从不出现在任何对话的请求里”和方案自己的设计矛盾，按字面写不出反向用例

第 12 节第一条门槛写“感知记录从不出现在任何对话的请求里：加进 `npm run check:prompt-prefix`”。但同一份方案里：

- 第 6 节规矩 2：“对话里需要当下情况时，模型调用固定存在的工具去读，读到的结果本来就是追加在后面的”——工具结果（含感知内容）**在请求里**。
- 能力一：“回答里说明‘这是我听到的，你没确认过’”——感知-derived 内容会进历史。
- 记忆来源多一类“感知记录”，这些记忆每轮被选中后进最后一条消息。

按字面，这个门槛永远失败或永远测不到真实行为。`scripts/check-prompt-prefix.mjs:9-11` 的 harness 是跑 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 里的 `[I-66]` 标签测试（要求至少 8 条通过、含 `[COMPACT-1..4]`），加用例可行，但用例的前提得先改。

**建议**：改成可判定的表述，例如“感知记录的原文不进请求开头（系统提示、工具定义、历史消息），只允许以追加的工具结果或最后一条消息出现；抽取后的记忆按现有来源规则进最后一条消息”，反向用例是把感知记录拼进历史消息时检查必须报失败。

### 3.【中】“高风险的审批必须解锁后再确认”的平台可行性没进待核实清单

能力三写“通知上直接带‘有用 / 打扰’……高风险的审批必须解锁后再确认”，第 10 节“做不到”表和第 13 节待核实清单都没有通知按钮这一行（通知不在第 10 节来源表里）。iOS 的通知操作（notification action）没有公开 API 让 App 声明“这个 action 必须解锁后才能点”；能否实现需要真机核实，这是安全边界上的一句，不该等实现时才发现做不到。

**建议**：把这条加进第 13 节，同时在第 10 节给“通知按钮”一行标待核实；做不到时的降级（例如高风险审批只发不带按钮的通知）先写进方案。

### 4.【中】“改写不在 MacBook 上运行测试的规则”涉及十几个文件，方案没列清单，文档必然失配

这条规则不只有一个出处：`AGENTS.md:117`、`.agents/instructions/test-and-production-hosts.md:8`（“绝不在用户的 MacBook 上运行 Himawari 测试：**不做构建**，不跑 npm run check……”）、`.agents/instructions/delivery-mode.md:21,31`、`docs/runbooks/test-host-operations-runbook.md:57`、`docs/runbooks/agent-tooling-runbook.md:56,94,120`、`docs/adr/0041:44`、`0043:37,51`、`0052:59`、`0056`、`0073:41,45`、`0063:41`、`0086:72`、`0092:40`、`docs/engineering-casebook.md:828`。Andy 同意的新规则（“服务器端测试不在 Mac 上跑；iOS/手表/Mac 端构建、单测和安装在 Andy 的 Mac 上用 Xcode 做”）和 `test-and-production-hosts.md:8` 的“不做构建”直接冲突。仓库有 `check:agent-rulebook-inventory`、`check:instruction-links`、`check:docs-links` 这类一致性检查（`package.json:27`），漏改会被卡或漏检。

**建议**：第 9 节第 14 条列出全部要改的文件清单；新 ADR 用“取代”链正式接上 ADR 0043（Mac 定向验证“无限期推迟”那一条也在 `0043:37`，要一并处理）。

### 5.【中】前提 26 的引用失效，但原话是真的——可以直接把这条从待核实变成已核实

方案引的 `https://developers.openai.com/api/docs/guides/realtime-webrtc` 现在返回 404（我实测 404）。实际页面已迁到 **https://developers.openai.com/api/docs/guides/voice-webrtc**，原话逐字存在："When connecting to a Realtime model from the client (like a web browser or mobile device), we recommend using WebRTC rather than WebSockets for more consistent performance."。配套页 https://developers.openai.com/api/docs/guides/voice-websockets 也确认："For browser and mobile clients, we recommend connecting via WebRTC."。方案 7.5 节的结论（不用实时语音模型、留 WebRTC 位置）不受影响，只改引用网址、删掉第 13 节第 14 条。

### 6.【低】感知记录抽取攒批的顺序确定性没有写

规矩 10/15 要求后台调用的列表顺序固定、遮盖确定。第 5 节只说“按‘一段经历’攒批”，第 9 节第 5 条说“固定指令在前，本次数据在后，日历和当前时间在最后”——批次内部多条感知记录怎么排（按设备时间戳？按唯一编号？多设备同秒怎么办？）没写。**建议**：写明排序键（例如设备 UTC 时间戳 + 唯一编号），并在评测里加一条“同批次乱序重放产出逐字节相同”。

### 7.【低】新增提示词会改变出口遮盖的“固定文字清单”，老对话的遮盖可能变一次——新 ADR 应写明

`.claude/rules/prompt-prefix.md:53` 写明固定文字清单“在一个构建内固定”、改提示词文字会让“老对话里冻结的旧文字不再在清单里”，遮法随之变一次。方案要加的提示词不少（抽取提示词、`tool-result` 说明、召回说明等，`packages/prompt-catalog`）。这不是错误，是已知的、规则里写明的代价，但方案的新 ADR 清单（第 9 节第 14 条）没提它。**建议**：在新 ADR 的后果一节写一句。

## 推测（未核实）

- 感知记录是全新表，要进 `packages/persistence-sqlite/src/schema-catalog.ts:513` 的表清单、`data-export/snapshot.ts` / `import.ts` 的导出导入清单和 `sqlite-governed-deletion.ts` 的对象类型分派。方案第 9.7 条提到“导出”和删除，但没提 schema-catalog 和导入端校验——推测是遗漏，详细设计时核对。
- “设备长连接复用现有事件流”（第 7.3 节）：现有 SSE 是浏览器同源页面专用的（`http-gateway-server.ts:257-264` 的 `assertMutationBoundary` 管 POST，`/api/gateway/v2/events` 走 `assertPublicHost`+`authenticate`，`:1110-1121`），事件流本身是服务器内部订阅的转发，复用在架构上可行，但“设备和网页收到同一串事件”意味着设备会收到全部事件（含发给网页界面的），要不要按设备过滤没有写——推测需要按 scope 过滤，否则泄漏到非目标设备。
- 第 12 节各门槛的反向用例（改守卫必失败）现在一条都不存在，无法核实“真的会失败”；`check:prompt-prefix` 的 harness 结构上装得下新用例，其余门槛（送达时机八组合、去重、吊销）要看落成什么测试项目。
- 前提 16 的苹果论坛原话（"continue recording indefinitely in the background"）：developer.apple.com 对自动访问有验证墙，我未能读到原页，标未核实（方案已把它当已核实引用）。
- 前提 21 的延迟数字：`docs/incidents-and-gates.md:68`（I-30）记录的是“6.5–16.3 秒、等第一个字中位数 5.1 秒”，与方案转述的“首字 6.3 秒、模型 3.5 秒、准备 3.4 秒”数字对不上（后者来自项目记忆里另一份报告，方案自己也标注了要重新实测）。两者并不矛盾（口径不同），但方案引用时最好以 I-30 这条在仓库内可查的记录为基线。

## 侧重检查（我走的流程和结论）

我按“最普通的使用流程”走了一遍现有代码，作为方案的接入面基线：**主人在网页打字** → `POST`（同源检查 `packages/platform-node/src/http-gateway-server.ts:257-264`）→ `trigger.admit` 命令（`packages/gateway-contracts/src/contracts.ts:68` 的 sourceType 三值枚举硬校验）→ 对话运行、请求开头冻结（`.claude/rules/prompt-prefix.md` 第 4-7 条）→ SSE 回答（`:1110` 的 `afterCursor`/`last-event-id` 续传、`:428` 心跳、回答事件 `thread.execution_text`，`packages/application/src/services/product-thread-gateway-adapter.ts:628`）→ 后台记忆抽取（`apps/agent-service/src/production-memory-capture.ts:716-739`：只收 `user_message`、只读 `text/plain`、要求 threadId）→ Gmail 主动检查（来源写死）。

结论：
- **方案改动不触碰的路径**：请求组装、遮盖、冻结、SSE——方案明确说感知记录不进这些路径，与规则一致；这是这份方案最对的地方。
- **方案新增、现有零覆盖的路径**：设备配对/凭据、长连接重连去重、抢跑、感知记录入库、APNs 推送和按钮回写、小组件刷新。方案第 12 节列了门槛，但这些门槛的宿主测试项目（除 check:prompt-prefix 外落在哪个测试项目、CI 哪一层跑）一个都没指定——按仓库惯例（`docs/adr/0043:51`、I-73 的门槛都写明宿主文件），每个门槛应写明“在哪个文件、属于 npm run check 还是 npm test 的哪个项目”。
- **“网页贴文字当作感知记录”的验收路径（第 11 节第 1 段）**：需要一个不经过 thread 的感知入库入口，而这个入口正是第 1 条高严重度问题（导出/CHECK/类型校验）最先被踩中的地方——建议把它当作迁移门槛的第一个用例，而不是先做 App。
- **文档与代码一致性**：除第 4 条列出的“MacBook 规则”面外，方案引用的仓库内出处我逐条核对过：前提 7、9、10、11、13、14、15、20、22 与代码/文档一致；ADR 0179 原话一致；ADR 0106:47 原话一致；前提 12（spec:124-125）一致。前提 21 的数字与 I-30 口径不同（见推测最后一条）。

## 如果由我来定

方案主体保留：定位（设备是身体、大脑在服务器）、感知记录不进对话、固定设备工具、三条传输路线实测后选——这些都和仓库的既有规则（只追加、冻结、I-30 门槛）同向，方向是对的。我改四处：

1. **第 9 节先补“两端核对表”**：把新值清单逐值填上产生处/使用处/两端校验/门槛，第一行就是“主动检查来源”的六处写死点（CHECK×11、export schema×3、TS×55、账本查询×2、SOURCES 常量、重建表迁移），照 I-73 立一道 `check:proactive-source-contract`。
2. **第 12 节第一条门槛改写**成可判定的表述（原文不进请求开头，允许追加出现），并为每个门槛写明宿主测试文件和所属检查层。
3. **第 13 节加两条**：通知按钮“解锁后确认”的可行性（真机）、前提 16 的苹果论坛原话（换能访问的渠道重读）；同时把第 14 条（WebRTC 引用）改成已核实并更新网址为 `voice-webrtc`。
4. **第 9.14 条列全“MacBook 测试规则”要改的文件清单**（AGENTS.md、.agents/instructions 两处、runbook 两处、ADR 家族至少 10 处），新 ADR 走正式取代链。

**必答问题逐条回答**：

1. **会不会改变模型已见过的请求开头？** 不会，前提是方案里三句承诺都落实：感知记录不进对话历史（规矩 2）；设备工具和读当下情况的工具固定存在、参数区分动作（有设备/没设备定义逐字节相同，配对断连不换头）；新工具只对新对话生效（老对话不触发 ADR 0165 的换新）。发给模型的内容仍然只在末尾追加：每轮变化的记忆选择、当前时间、感知-derived 的工具结果都在追加的消息里。唯一要修的是第 12 节那条门槛的表述（证实的问题 2），它描述的不是设计本身。
2. **同一段文字会不会在不同请求里变成不同字节？** 主路径不会：遮盖规则不变、配置不进提示（规矩 7 写明）、心跳间隔不进请求。两个缺口：抽取攒批的内部顺序没定排序键（证实的问题 6）；新增提示词会改固定文字清单，老对话遮盖可能变一次（证实的问题 7，属规则已写明的既有代价，新 ADR 记录即可）。
3. **有没有对应的自动检查、反向用例会不会真的失败？** 门槛清单覆盖面是够的，且 `check:prompt-prefix` 的 harness（`scripts/check-prompt-prefix.mjs`，跑 `[I-66]` 标签测试、要求至少 8 条）装得下第一条；但（a）所有反向用例尚不存在，未核实；（b）每条门槛没有写明宿主测试文件和所属检查层，不合仓库惯例（I-73、I-30 的门槛都写明了）；（c）第一条门槛按字面写不出反向用例（证实的问题 2）。
4. **每个新值两端的校验都能接受吗？** 现在不能逐条回答，因为新值清单是空的承诺，而已知的接收端硬校验已经找出一处高危：主动检查的来源/场景名在 SQLite CHECK、导出 schema、TS 类型、账本查询四处写死为 gmail（证实的问题 1）。其余新值（设备编号/公钥、消息编号、感知记录编号/类型、推送令牌、按钮反馈值）落在全新表和新接口，旧校验不冲突，但都要进 `schema-catalog` 和导出/导入清单；设备工具名要过运行端 `PI_UNKNOWN_TOOL`/重复名检查，且 `prompt-prefix` 已有“冻结工具名与 Pi 工具名不一致就一次请求都不发”的既有守卫兜底。
