## 读代码证实的意见

### 1、高、锁屏“全文显示”只引用了已被取代的 ADR 0089，没有修订仍在生效的 ADR 0229

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:658`、`:997`、`:1003`；`docs/adr/0229-native-apple-clients-and-device-api.md:125`、`:166`；`docs/adr/0258-each-apple-device-plays-to-its-strength.md:118`、`:185`
- 问题：设计把“她的话全文显示、不遮盖；同意卡片推送真实动作和明细”写成已定，并说“ADR 0089 第 5 条的这一处随之不再适用”。但 ADR 0089 已被 ADR 0229 取代，现行规则在 ADR 0229 决定第 9 条和后果里仍然写着“敏感或受限的只显示一句提示”“正文不放进推送”。ADR 0258 决定第 8 条只讲界面按通用样子画，并没有说锁屏不遮盖；ADR 0258 关联文档还明确只修订 ADR 0229“放弃的做法”里关于 Mac 的半句和 Mac 端范围。也就是说，这次锁屏隐私规则的改变没有任何现行 ADR 记录。
- 证据（读代码证实）：
  - 设计 `:658`：“**锁屏内容**：她的话全文显示，不遮盖，不再有‘敏感或受限的只显示一句提示’（Andy 2026-11-24 定，见 ADR 0258 决定第 8 条；ADR 0089 第 5 条的这一处随之不再适用）。”
  - ADR 0229 `:125`：“推送规则（第 5 条）对两条通道都适用：锁屏上显示多少内容……苹果推送的内容经苹果的服务器，所以锁屏规则里‘敏感或受限的只显示一句提示’同样适用于它。”
  - ADR 0229 `:166`：“苹果推送的内容经过苹果的服务器，所以沿用锁屏规则，正文不放进推送。”
  - ADR 0258 `:118` 决定第 8 条只写“主对话里的同意卡片和选项、锁屏通知上，一件事都按‘一句话、明细、肯定按钮、否定按钮、要不要本人在场’通用地画”，没有“全文、不遮盖”。
  - ADR 0258 `:185`：“被本 ADR 修订‘放弃的做法’里关于 Mac 的半句和 Mac 端的范围。”
- 建议：在 ADR 0258 里新增或改写一条决定，明确修订 ADR 0229 决定第 9 条和后果里的锁屏规则；同步改 ADR 0229 正文、实施计划 `:176` 和 `docs/execution/specs/2026-10-26-web-push-design.md`。同时写明哪些数据分级（健康、短信、屏幕文字、剪贴板、位置等）仍不上锁屏，以及“同意卡片明细上锁屏”的隐私代价；否则这是把一条现行安全规则悄悄放宽。

### 2、高、设计的页面去处表和客户端能力表/生成的 Swift 对不上，`check:client-parity` 不会失败

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:307-322`；`docs/adr/0258-each-apple-device-plays-to-its-strength.md:106`、`:122-127`；`packages/gateway-contracts/src/client-capabilities.ts:380-401`；`clients/apple/Sources/HimawariManage/Generated/ClientCapabilities.swift:62-70`
- 问题：设计把 `approvals`、`suggestions` 改成主对话里的同意卡片/选项，把 `capabilities-adapters`、`improvements`、登录着的浏览器改成“手机上不做”；但 ADR 0258 决定第 3 条明说“清单里其余页面仍然是原生页面”，代码里的 `CLIENT_PAGE_TABLE` 仍把 `approvals` 映射到 `today.approvals`、`suggestions` 映射到 `today.suggestions`，把 `capabilities-adapters` 映射到 `settings.capabilities`、`improvements` 映射到 `settings.improvements`。生成的 Swift 里也仍有 `todayApprovals`、`todaySuggestions`、`settingsCapabilities`、`settingsImprovements`。`check:client-parity` 只检查“每个网页页面有没有原生页或写明不做”，不检查映射到哪一页，所以这些不一致不会让它失败。
- 证据（读代码证实）：
  - 设计 `:308`：“`approvals` | 主对话里的同意卡片……”；`:309`：“`suggestions` | 不单独成页……”；`:313`：“`capabilities-adapters` | 这一版手机上不做……”；`:316`：“`improvements` | 这一版手机上不做……”；`:322`：“……在客户端能力表里登记成‘手机上不做’并写明原因”。
  - ADR 0258 `:106`：“这修订 ADR 0247 决定第 1 条的页面清单；清单里其余页面仍然是原生页面。”
  - `client-capabilities.ts:382`：`{ webPage: "approvals", nativePage: "today.approvals" },`；`:386`：`{ webPage: "capabilities-adapters", nativePage: "settings.capabilities" },`；`:389`：`{ webPage: "suggestions", nativePage: "today.suggestions" },`；`:392`：`{ webPage: "improvements", nativePage: "settings.improvements" },`。
  - Swift `:69-70`：`case todayApprovals = "today.approvals"`、`case todaySuggestions = "today.suggestions"`。
- 建议：先统一 ADR 0258 决定第 3 条和决定第 10 条的措辞（到底只拿掉三张运维页，还是还拿掉 capabilities/improvements/登录浏览器），再更新 `CLIENT_PAGE_TABLE` 和生成的 Swift；`check:client-parity` 应增加断言：设计表里的“手机上不做”页面必须在表里是 `notOnPhone`，`approvals`/`suggestions` 不能再指向 `today.*`。这是 I-73 的同类问题：清单项在一端改了，另一端仍接受旧值。

### 3、高、权限表把“后台 + 外来内容”写松了，和 ADR 0257、ADR 0258 决定第 6 条冲突

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:520`；`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:148`；`docs/adr/0258-each-apple-device-plays-to-its-strength.md:109`、`:114`
- 问题：设计把“后台发起、上下文里有外来内容”这一档从 ADR 0257 的“不做，也不建等着的审批，只记提议候选”改成“只在 Himawari 自己这边、能撤回的（记住、定提醒和跟进）直接做……其余出同意卡片”。这直接绕过了“读过外来内容后要问”。ADR 0258 决定第 6 条还说“具体规则以 ADR 0257 为准”，决定第 4 条又说“要动 Andy 的东西时，她在主对话里给可点的选项，Andy 点了才建”。三处互相矛盾。
- 证据（读代码证实）：
  - 设计 `:520`：“后台（定时、系统主动提醒的检查、对话外的‘想一想’） | 按 ADR 0285 决定第 7 条：只在 Himawari 自己这边、能撤回的（记住、定提醒和跟进）直接做并记下出处；改主人外面的账号和设备、改规则、发出去、删东西，在主对话里出一张同意卡片等主人点头”。
  - ADR 0257 `:148`：“后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做，也不建等着的审批；记一条决策记录，并把‘想做什么’作为提议候选交出去”。
  - ADR 0258 `:114` 决定第 6 条：“……具体规则以 ADR 0257 为准（前提 15）。”
  - ADR 0258 `:109` 决定第 4 条：“要动 Andy 的东西时，她在主对话里给可点的选项，Andy 点了才建。”
- 建议：明确 ADR 0285 决定第 7 条是否正式取代 ADR 0257 的这条内置规则；如果取代，就在 ADR 0257 和 ADR 0258 里写成正式修订，并补反向测试。后台 + 外来内容至少不应直接“定提醒”；“记住”也要看是否会被读成主人自己的数据。当前写法把“读过外来内容后要问”写松了。

### 4、高、实施计划第 2 批仍按 v2 基线、三页签、今天/记忆页签、对话列表做

- 文件:行：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:109`、`:120`、`:121`、`:137`、`:175-176`；对照 `:66`
- 问题：计划总则 `:66` 已经说“一律照基线第 4 版做”，但第 2 批的详细任务仍写 `2026-11-12-v2/`、三页签外壳、对话列表、“今天”“记忆”两个页签。第 5 批还留着“提议入口”，第 4 批一边说“锁屏规则（ADR 0089、ADR 0229）不让审批的具体内容上锁屏”，一边说“2026-11-24 起锁屏显示她的话全文、同意卡片带真实动作和明细”。这些是实施线程会照着做的详细任务，和本轮设计直接矛盾。
- 证据（读代码证实）：
  - 计划 `:109`：“界面照 `docs/assets/apple-clients/2026-11-12-v2/` 里的配对首屏、配对流程、对话列表、聊天和聊天各状态几张图以及三页签外壳做。”
  - 计划 `:120`：“……卡片、胶囊按钮、玻璃圆钮、页签栏、葵盘标志……”
  - 计划 `:121`：“外壳和页面：配对首屏和配对后的等待、对话列表、聊天；‘今天’‘记忆’两个页签先显示‘这一页还没接上’。”
  - 计划 `:66`：“一律照基线第 4 版做：`docs/assets/apple-clients/2026-11-25-v4/`……里面的‘今天’页、底部页签栏、对话列表和提议页都不做了。”
- 建议：把第 2 批的范围、组件、外壳任务改成 v4 的“主对话 + 她的页面”，删掉页签栏、今天页、对话列表；把第 5 批的“提议入口”改成收件箱；把 `:175-176` 的旧提议通知和锁屏文字改成“已被 ADR 0285/0258 取代”的明确说法。

### 5、中高、`check:apple-design` 仍以 v2 的 `tokens.json` 为源，不校验本轮新增的 v4

- 文件:行：`clients/apple/scripts/check-design.mjs:20`、`:108-122`；`test/tooling/apple-design-check.test.mjs:110-123`、`:169-180`；`docs/assets/apple-clients/2026-11-25-v4/tokens.json`
- 问题：检查脚本的 `TOKENS_SOURCE` 固定为 `docs/assets/apple-clients/2026-11-12-v2/tokens.json`，生成的 Swift/CSS 也只和 v2 比。作者说“check:apple-design 通过”，但这条检查根本没有覆盖本轮新增的 v4 `tokens.json`；v4 是否是合法 JSON、生成器能否处理 `avatar`/`options`/`pairing`/`scanner` 这些新段，都不由这条检查保证。反过来，如果实现线程按 v4 生成 Swift，检查会因为和 v2 不一致而失败。
- 证据（读代码证实）：
  - `check-design.mjs:20`：`export const TOKENS_SOURCE = "docs/assets/apple-clients/2026-11-12-v2/tokens.json";`
  - `:108-116`：读 `TOKENS_SOURCE`，用 `generate(...)` 和 `DesignTokens.swift` 比，不一致报 `tokens-stale`。
  - 测试夹具 `:110-113`、`:169-172` 也写死 `2026-11-12-v2/tokens.json`。
  - 我读了 `docs/assets/apple-clients/2026-11-25-v4/tokens.json`，结构完整、看起来是合法 JSON；但这条检查不会读它。
- 建议：把 `TOKENS_SOURCE` 改成当前基线（v4）或可配置，更新 `make-design-tokens` 和测试夹具；加反向用例：v4 JSON 坏掉、缺 `avatar`/`options`、改一个颜色，检查必须失败。

### 6、中、Web 推送设计仍把“待处理提议”当推送来源、仍写“敏感提醒的锁屏文字”

- 文件:行：`docs/execution/specs/2026-10-26-web-push-design.md:34`、`:108`、`:115-117`、`:263`
- 问题：新设计已经说“原先的‘提议通知’不做：提议变成了她那条话下面的选项”，也改成锁屏全文、不遮盖；但 web 推送设计仍把“待处理的提议”列为调度来源，并保留“敏感提醒的锁屏文字”的验证项。两份现行设计对同一件事给出相反说法。
- 证据（读代码证实）：
  - Web 推送设计 `:115`：“| 待处理的提议 | 只取最新一份待处理提议 | `proposal:<提议 id>:<proposedAt>` | 提议时间起 24 小时…… | `normal` |”
  - `:117`：“待处理的提议（[IOS-4]）：只为最新一份入队一条……负载带 `silent: true`，不计入角标……”
  - `:263`：“……各回应码的处理；敏感提醒的锁屏文字；三种语言。”
  - 新设计 `:652`：“原先的‘提议通知’（‘有一条建议等你看’）不做：提议变成了她那条话下面的选项。”
- 建议：更新 web 推送设计，或明确标注被 ADR 0285/0258 取代；锁屏文字和提议通知两处都要和新设计对齐，否则实现线程会按旧 spec 做。

### 7、中、多处“现有代码”的行号在合入 main 后已偏移

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:78`、`:285`、`:291`、`:320`、`:328`、`:671`
- 问题：这些行号指向的代码已经对不上。设计说“不写到改哪个文件的哪一行”，但实际仍大量引用行号；合入 main 后行号变了，读者会找到错误的行。
- 证据（读代码证实）：
  - 设计 `:78` 引 `strict-configuration.ts:1067` 的 `dailyCostMicros`；实际在 `:1146`。
  - 设计 `:285` 引 `contracts-v2.ts:1496` 的 `memory.settings.set`；实际 `memory.settings.set` 在 `:2780`，`:1496` 是 `generatedAt`。同一句引 `:500` 的 `proactive.settings.set`；实际在 `:1401`。
  - 设计 `:291` 引 `contracts-v2.ts:1637` 的 `memory.mutate`；实际在 `:2965`，`:1637` 是 `muse.intake.set`。
  - 设计 `:320` 引 `control-center-inventory.ts:158` 的 `github.monitor.set_state`；实际在 `:146`。
  - 设计 `:671` 引 `action-policy-service.ts:503` 的 `recentAuthenticationRequired`；实际在 `:513`。
  - 设计 `:328` 引 `production-http-composition.ts:434` 的“活着的网页会话”检查；`:434` 实际是 `http.maximumStaticAssetBytes > 64 * 1024 * 1024`。
- 建议：更新这些行号，或按文档自己的约定去掉行号，只留文件和符号名。`recent-authentication-service.ts:59`、`:67`、`validSource` 第 31 行这几处是对的，可以保留。

### 8、中、新值清单里多处“自动检查”指向不存在的测试文件

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:916`、`:918-919`、`:923`、`:944`、`:956`、`:1080`、`:1083`
- 问题：设计反复把 `test/integration/device-limits.test.ts`、`device-connection.test.ts`、`perception-deletion.test.ts` 写成守着这些值的自动检查；我在提交 `0182c09f4` 里用 `git show` 查了，这三个文件都不存在。也就是说，“反向用例会失败”这句话对这些行不成立。
- 证据（读代码证实）：
  - `git show 0182c09f4:test/integration/device-limits.test.ts` → `fatal: path ... does not exist`
  - `git show 0182c09f4:test/integration/device-connection.test.ts` → 同上
  - `git show 0182c09f4:test/integration/perception-deletion.test.ts` → 同上
  - 设计 `:916`：“`test/integration/device-limits.test.ts`（反向：十个键各一条超限用例……）”；`:918`、`:919` 引 `device-connection.test.ts`；`:923`、`:944`、`:956`、`:1083` 引 `perception-deletion.test.ts`。
- 建议：把这些行改成实际存在的测试（例如 `device-api.test.ts`、`startup-configuration.unit.test.ts`、`perception-records.test.ts`），或者标“计划中，尚未落地”。不要把计划中的测试写成现有门槛。

### 9、低、ADR 0283 不在仓库，设计却把它当作生长动效和具体数值的依据

- 文件:行：`docs/adr/0258-each-apple-device-plays-to-its-strength.md:125`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:989`；`docs/assets/apple-clients/2026-11-25-v4/README.md:39`；`docs/assets/apple-clients/2026-11-25-v4/tokens.json:208`
- 问题：设计写“标志用 ADR 0283 的生长动效（`SunflowerMark(growing: true)`，55 颗种子，每秒长 3.4 颗）”。仓库里没有 `docs/adr/0283*`。ADR 0285 至少明确写了“在 PR 612 里，没有进 main”，ADR 0283 没有这样的说明，所以 55/3.4 这些数值目前没有可核对的来源。
- 证据（读代码证实）：
  - `glob docs/adr/028*.md` 只找到 `0281`；没有 `0283`。
  - 设计 `:989` 和 v4 `tokens.json:208` 都引 ADR 0283 和 55/3.4。
- 建议：如果 ADR 0283 在另一个 PR 里，像 ADR 0285 一样写明 PR/文件；否则把“55 颗、3.4 颗/秒”标成设计线程的暂定值，不要写成有 ADR 依据。

### 10、低、设计里还留着“导航那一行”“2026-11-12 补画的六排”这类旧界面文字

- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:204`、`:303`
- 问题：新设计已经去掉导航栏和页签，顶部是头像；`:204` 仍说“导航那一行的下沿”。`:303` 仍说“2026-11-12 补画的六排”，但现行基线已经是 2026-11-25-v4，v4 README 说的是第 62 版、第二排补了六屏。
- 证据（读代码证实）：
  - `:204`：“顶部的淡出：从屏幕顶到 102 点（导航那一行的下沿）……”
  - `:303`：“网页的 16 个页面在 iPhone 上的去处（原型见[界面照哪一版做](#ui-baseline)和 2026-11-12 补画的六排）”
- 建议：把“导航那一行”改成“顶部头像区域”或删掉；把“2026-11-12 补画的六排”改成“v4 的 README/第 62 版”。

## 推测与未核实

- **ADR 0285 决定第 7 条的原话未核实**：`docs/adr/0285-*` 不在当前仓库，设计 `:520` 引的“只在 Himawari 自己这边、能撤回的（记住、定提醒和跟进）直接做……”我无法对照原文。只能确认它和现行 ADR 0257 `:148` 冲突。
- **`DEVICE_ACTION_CONFIRMATION_REQUIRED` / `tools.result.device-action.unconfirmed` 未找到**：设计 `:959` 说它们是代码常量和提示词清单项，但全仓库搜索只在设计文档里出现；代码里只有 admin CLI 的 `ADMIN_CONFIRMATION_REQUIRED`。如果这是计划值，应标“计划中”；如果是已实现值，这条陈述和代码不一致。
- **v4 图片尺寸、截图是否在“减弱动态效果”下拍的**：只读了 README 和 tokens，没有图片元数据，未核实。
- **`validate_docs.py --strict` 的结论**：没有运行，未核实。作者说只有 main 上已有的 `docs/lessons.md` 一条错误，我没有独立验证。
- **检查命令是否真的通过**：没有运行 `check:*`，只静态读了脚本和测试。`check:apple-design` 的通过不能证明 v4；`check:client-parity` 的通过不能证明设计页面表已实现。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本轮只有文档和设计素材，没有改任何组装提示词、工具定义、历史或遮盖的代码；新写的第 18 节是 iPhone 界面，不涉及模型请求。设计第 15 节仍要求“只追加”、每轮变化的值只放最后一条消息。唯一会动模型请求的是设计 `:271` 说的未来给工具加 `activity`/`activityIcon` 参数，那会按规则让老对话重建一次请求开头，但不属于这个 PR。结论：不改变，仍然是只在末尾追加；本轮不涉及。

2. **会不会让同一段文字在不同请求里变成不同字节？** 本轮没有新增模型请求的序列化代码。设计第 15 节仍要求固定排序、一次遮盖只依赖自己和前面的记录；v4 `tokens.json` 是静态素材。设计 `:849` 承认“删掉或改动同批里的一条记录，可能改变排在它后面的记录被遮成什么样”，但这是既有设计，只影响以后新发的后台请求，不影响已经发出去的对话。结论：本轮没有新增这类不确定性。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 部分有，但覆盖不到本轮的关键改动。链接、表格、词表、格式这类检查能跑，但不检查跨文档语义；`check:apple-design` 仍以 v2 tokens 为源，不校验 v4；`check:client-parity` 只检查页面有没有映射，不检查映射到哪一页，所以设计里的 `approvals`/`suggestions`/`capabilities-adapters`/`improvements` 改动不会让它失败；设计引用的 `device-limits.test.ts`、`device-connection.test.ts`、`perception-deletion.test.ts` 在提交里不存在。结论：没有一条自动检查会因本轮这些矛盾而失败。

4. **每个值两端都能接受吗？** 逐个核对结果：
   - 能接受（读代码证实）：`device.list.read`、`device.pairing.start`、`device.pairing.confirm`、`device.rename`、`device.revoke`、`server.status.read`、`proactive.pause` 都在 `contracts-v2.ts` 和 `client-capabilities.ts` 里，`check:client-parity` 覆盖；十个硬上限键都在 `device-limits.ts`/`strict-configuration.ts`，并被 `perception-service.ts`/`device-api-routes.ts` 使用；`device_confirmation_key` 同时在 `recent-authentication.ts` 和 `recent-authentication-service.ts` 的 `validSource` 里；`runPolicy.applePush` 在 `strict-configuration.ts`；`contracts.ts` 的 `GATEWAY_MESSAGE_TYPES` 存在。
   - 不能接受/不一致（读代码证实）：设计页面表的 `approvals`/`suggestions`/`capabilities-adapters`/`improvements` 和 `CLIENT_PAGE_TABLE`、生成的 Swift 不一致；v4 `tokens.json` 没有被 `check:apple-design` 消费，生成器仍读 v2；锁屏规则和 ADR 0229 决定第 9 条不一致；后台外来内容权限和 ADR 0257 `:148` 不一致；`DEVICE_ACTION_CONFIRMATION_REQUIRED` 在代码里找不到；ADR 0283 不在仓库。
   - 未核实：ADR 0285 决定第 7 条原话、ADR 0283、v4 图片尺寸、`validate_docs.py --strict`。

**本轮查过的范围**：ADR 0258、ADR 0229、ADR 0089、ADR 0257、ADR 0230、详细设计全文、实施计划、词表、设计规范、v4 README 和 `tokens.json`、`clients/apple/scripts/check-design.mjs`、`test/tooling/apple-design-check.test.mjs`、`test/tooling/client-parity.test.ts`、`packages/gateway-contracts/src/client-capabilities.ts`、`contracts-v2.ts`、`contracts.ts`、`strict-configuration.ts`、`recent-authentication*`、`action-policy-service.ts`、`control-center-inventory.ts`、`production-http-composition.ts`、`web-push-design.md`，以及若干被引用的测试文件是否存在。未运行任何检查命令，未修改文件。
