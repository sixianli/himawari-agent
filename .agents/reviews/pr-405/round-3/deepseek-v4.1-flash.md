## 发现（按严重度）

### 高

**1. `device_confirmation_key` 的近期验证引用与现有守卫的会话绑定对不上**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:291`；`packages/application/src/services/recent-authentication-service.ts:31`、`:66`、`:114`；`packages/platform-node/src/built-in-identity.ts:252`。
- 问题：设计说确认密钥验签后生成的近期验证凭据“验证引用是这次挑战值的摘要”。现有守卫却要求 `expectedAuthenticationRef === authentication.authenticationRef`、`evidence.authenticationRef === authentication.authenticationRef`，并用 `authenticationRef` 去 `findSessionByAuthenticationRef` 找活会话。设备身份用的是配对时建的那条内部 `product_sessions`，它的 `authenticationRef` 不是挑战值摘要；现有 `built_in_mfa` 的 evidence 也直接用 `session.authenticationRef`。三者不可能同时成立。若实现时为了通过而放宽守卫，会削弱“凭据必须绑定到活会话”的检查。
- 证据：
  - 设计：“验证引用是这次挑战值的摘要。”
  - `recent-authentication-service.ts:59`：`expectedAuthenticationRef !== authentication.authenticationRef`
  - `:67`：`evidence.authenticationRef !== authentication.authenticationRef`
  - `:114`：`findSessionByAuthenticationRef(authentication.authenticationRef)`
  - `built-in-identity.ts:259`：`authenticationRef: session.authenticationRef`
- 建议：明确设备路径到底用哪个值作为 `authenticationRef`：要么用内部会话的 `authenticationRef`（挑战值另存、只由确认签名覆盖），要么扩展会话映射并写清安全边界。同时把 `RecentAuthenticationEvidenceSource`、`validSource`（`recent-authentication-service.ts:31-37`）和 `externalSubjectRef` 的绑定一起改，补“只用设备密钥被拒、只有内部会话被拒、确认密钥签过才通过”的反向用例。按 I-73，不能只改类型不改校验器。

### 中

**2. 过程行工具参数改动单独上线，会让老对话的请求开头再变一次**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:265`；`docs/adr/0229-native-apple-clients-and-device-api.md:118`；`docs/execution/plans/2026-11-11-apple-device-body-plan.md:37`。
- 问题：设计把“给每个工具加 `activity` / `activityIcon`”写成“由单独的服务器端编码任务做，不归第 2 批”。这是工具定义变化，按规则第 6 条会让每个老对话的请求开头换新一次。ADR 0229 决定第 7 条明确说“为了只发生一次，这两个工具和这套设计用到的全部新提示词文字在同一个版本里上线”。如果过程行这项改动晚于第 5 批单独上线，就会造成第二次全量请求头失效，违反 ADR 0229 的目标。
- 证据：
  - 设计：“它属于模型调用的大改动，由单独的服务器端编码任务做，不归第 2 批”
  - ADR 0229：“为了只发生一次，这两个工具和这套设计用到的全部新提示词文字在同一个版本里上线。”
  - 计划第 5 批：“两个固定工具、全部新提示词文字……”
- 建议：把这项改动并入第 5 批同版本上线；如果确实要单独上线，明确写出“这是第二次请求头失效”并取得 Andy 同意，计划里也要登记。

**3. 规则 58 与能力表的“日常/收紧”矛盾**
- 文件:行：`docs/ui-ux-design-guide.md:146`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:273-274`；`docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:63-64`。
- 问题：规则 58 说“会改动东西的操作，点下去直接出面容识别”，例外只举了“关掉或暂停感知”。但详细设计的“日常”明确把新建、发消息、改名、置顶、归档、恢复、移到废纸篓、分叉、换回答语言列为“设备密钥签名，不用面容”；“收紧”还包括暂停记忆和让正在跑的一轮停下。照规则 58 实现，改名/置顶会被错误地要求面容，暂停记忆/停一轮又可能被漏掉。
- 证据：
  - 规则 58：“会改动东西的操作，点下去直接出面容识别……关掉或暂停感知这类‘往少的方向’的操作连面容也不用”
  - 详细设计“日常”：“设备密钥签名，不用面容”
  - 详细设计“收紧”：“关掉或暂停某一项感知、暂停记忆、让正在跑的一轮停下……设备密钥签名，不用面容”
- 建议：把规则 58 收窄成“需要确认密钥的‘改’档操作”，并把“收紧”的全部例外列全；或者明确“会改动东西”只指改规则、删记忆、改设置、导出等“改”档操作。

**4. 第 11 批依赖第 3 批的新消息类型，但计划只写依赖 1、2**
- 文件:行：`docs/execution/plans/2026-11-11-apple-device-body-plan.md:57`、`:59`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:293`、`:311`。
- 问题：计划说第 11 批依赖“1、2”，且“第 11 批在第 2 批之后就可以开始”。设计却说“感知到的”页用的查询和命令由第 3 批加进网关合约，第 11 批才能登记进能力表；`check:client-parity` 要求合约里属于查询/命令的每一种都在能力表里。如果第 3 批没合，第 11 批的检查会失败。
- 证据：
  - 计划第 11 批依赖：“1、2”
  - 设计：“设备管理……和‘感知到的’页用的查询和命令是新的消息类型，分别由第 1 批和第 3 批加进网关合约……第 11 批把它们登记进能力表”
  - 设计：“‘感知到的’……第 11 批做，数据来自第 3 批的接口”
- 建议：把第 3 批加进第 11 批的依赖，或把“感知到的”相关类型提前到第 1/2 批；不要让第 11 批在合约缺类型时开工。

**5. `activity` 自由文本没有长度、字符和渲染约束**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:253`、`:265`。
- 问题：`activity` 是模型给的自由句子，服务器取走后随过程事件发给网页和设备并可能入库。设计没有规定最大长度、控制字符处理，也没有规定客户端按纯文本渲染。模型输出若很长或被提示注入成 HTML，可能造成事件/日志膨胀、界面撑破；网页若按 HTML 渲染则有 XSS 风险。`activityIcon` 有 40 个名字的白名单，`activity` 没有对应约束。
- 证据：“一句话说明（暂名 `activity`，用回答的语言……）”“服务器在执行工具前把这两项取走……随这一步的过程事件发给网页和设备”
- 建议：服务器加长度上限（例如 200 字符）、去掉控制字符、按纯文本显示；补一条超长/带标签的 `activity` 反向用例。同时把 `activity` 也纳入新值清单。

**6. “每个新出现的值”清单没有覆盖这次新增的跨端值**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:824`、`:849`、`:253`、`:289`。
- 问题：清单里有“确认密钥的签名、一次性挑战”，但没有 `device_confirmation_key` 的校验器（`validSource`）、占位值 `device`、`activity`、`activityIcon` 和 40 个图标名。40 个名字目前只存在于文档表格里，服务端常量、Swift 资源目录和网页之间没有单一来源和检查；这正是 I-73 说的“一个值只在一端认”。
- 证据：“每个新出现的值，都写明谁产生、谁使用、两端怎样校验、哪道检查守着”；清单中“确认密钥的签名、一次性挑战 | 设备、服务器 | 审批服务的近期身份验证 | 挑战只能用一次、限时”。
- 建议：给 `device_confirmation_key`、`device` 占位值、`activity`、`activityIcon` 各加一行，写清产生处、使用处、两端校验和检查；把 40 个图标名做成服务端常量并生成/核对 Swift 资源，增加“每个名字都有资源、服务端只接受这 40 个”的检查。

**7. “读”档把全部查询交给设备密钥，敏感数据读取面变大**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:271`、`:277`；`docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:62`；`docs/adr/0229-native-apple-clients-and-device-api.md:103`。
- 问题：ADR 0229 原决定的白名单是“发消息、回答审批、提交感知记录、回报动作结果等”，不是所有查询。ADR 0247 新增“读：设备密钥签名”，详细设计把记忆、规则、设置、审批、提醒记录、决策链、工作区等都放进“读”。只拿到设备密钥、主人不在场时，攻击面比原文的“只有读”大得多。这是 ADR 0247 授权范围内的取舍，但设计用“能做的只有读”容易让人低估风险。
- 证据：
  - 详细设计：“读：看记忆、规则、设置、审批、提醒记录、用量等”“只拿到设备密钥……能做的只有‘读’‘日常’‘收紧’”
  - ADR 0229：“设备能调用的命令是一张白名单（发消息、回答审批、提交感知记录、回报动作结果等）”
- 建议：请 Andy 明确确认“所有查询都可用设备密钥读”；对最敏感的读（记忆、决策链、工作区）考虑要求确认密钥，或至少加读取审计/限流。把接受的风险写进 ADR 0247 或详细设计。

### 低

**8. `admitText` 被描述成可直接复用的“同一段收文字程序”**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:287`；`packages/platform-node/src/http-gateway-server.ts:1233-1250`、`:1294`。
- 问题：文档说设备 `POST payload/text` 和网页 `POST /api/payload/v1/text`“用同一段收文字、存文字的程序……（`http-gateway-server.ts` 的 `admitText`）”，但 `admitText` 本身包含 `assertMutationBoundary`、`authenticate`、`csrf.verify`。设计紧接着说这些对设备不适用，说明实际需要拆出内层校验；直接指向 `admitText` 会误导实现者。
- 证据：`admitText` 内先 `assertMutationBoundary(request, publicOrigin)`、`await authenticate(request, options)`、`options.csrf.verify(...)`；`app.post("/api/payload/v1/text", admitText(64 * 1024, "text/plain"))`。
- 建议：改成“复用 `admitText` 内部的正文校验/存储部分；设备路径用设备签名替代同源、会话和 CSRF”，并写清拆出的函数名。64×1024 按 UTF-16 代码单元计这句与 `.length` 的实现一致，可保留。

**9. 触感“开始收听一定让主人的手知道”与“关”档不震矛盾**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:218`、`:247`。
- 问题：原则说“开始收听这类事一定让主人的手知道”，但设置“关”这一档又说“‘开始和停止收听’在‘关’这一档也不震”。
- 证据：“而且开始收听这类事一定让主人的手知道”“‘开始和停止收听’在‘关’这一档也不震，但屏幕上的收听标记始终在”
- 建议：把原则改成“默认和要紧档让手知道，关档只用屏幕标记”，或明确“关”档连开始收听也允许不震是用户的显式选择。

**10. `tokens.json` 的线宽与规则 54 的“1.6”不一致**
- 文件:行：`docs/ui-ux-design-guide.md:142`；`docs/assets/apple-clients/2026-11-12-v2/tokens.json:129-130`。
- 问题：规则 54 说“线宽 1.6”，但 tokens 里还有 `strokeChevron: 2.2`、`strokeLarge: 1.3`。如果规则是权威，Swift 常量和规则会打架；如果 tokens 是权威，规则需要写清例外。
- 证据：`"stroke": 1.6, "strokeChevron": 2.2, "strokeLarge": 1.3`
- 建议：在规则 54 里写明“标准线宽 1.6；返回箭头 2.2、特大图标 1.3”，或把 tokens 统一成 1.6。

**11. 配对“按来源限次数”没有配置键、默认值和用例**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:28`、`:700-713`。
- 问题：设计说“配对请求按来源限次数”，但硬上限表只有十个键，没有配对限次键；也没有写默认值、按什么来源限、超限怎样、哪条测试守着。配对接口是未认证入口，这条限流很重要。
- 证据：“配对请求按来源限次数”；硬上限表 10 行无配对键。
- 建议：加一个配置键（或明确复用现有通用限流器），写默认值和测试；否则“按来源限次数”只是口头约定。

**12. v2 “六排三十七屏”与 source 中的 38 个屏幕框不符**
- 文件:行：`docs/execution/specs/2026-11-11-apple-device-body-design.md:195`；`docs/assets/apple-clients/2026-11-12-v2/source/`。
- 问题：文档写“15 到 20 是补画的六排三十七屏”。按 v2/source 六个文件里的 `class="hm ph"` 屏幕框数：SettingsMore 9、PairingFlow 5、MemoryMore 5、HimawariSelf 8、ChatStates 7、TodayMore 4，合计 38 屏。
- 证据：上述文件中的 `class="hm ph"` 计数。
- 建议：改成“三十八屏”，或说明为什么按 37 计。

**13. ADR 0247 的“收紧”清单没有包含设计新增的“暂停系统主动提醒”类型**
- 文件:行：`docs/adr/0247-apple-clients-are-fully-native-with-a-capability-table.md:64-65`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:281`。
- 问题：设计说 `proactive.settings.set` 整个算“改”，另加一个只有方向的“暂停系统主动提醒”消息类型登记成“收紧”。ADR 0247 的“收紧”只列了“关掉或暂停某一项感知、暂停记忆、让正在跑的一轮停下”，没有这一项。虽然方向是“更少打扰”、风险低，但这是新增的设备密钥免面容权限，应有 ADR 依据。
- 证据：“‘暂停系统主动提醒’另加一个只有方向、不带别的字段的消息类型，登记成‘收紧’”；ADR 0247 收紧清单原文。
- 建议：把这一项补进 ADR 0247，或说明它是同一原则下的具体应用。

**14. v2 `canvas.json` 引用了 source 下不存在的 `IconChoices.dc.html`**
- 文件:行：`docs/assets/apple-clients/2026-11-12-v2/source/canvas.json:94-107`。
- 问题：`boards` 和 `order` 都列了 `IconChoices.dc.html`，但 v2/source 下没有这个文件；`LoopSteps.dc.html` 也不在 v2/source（它在 `2026-11-12-process-row/source/`）。这是冻结素材内部引用缺失，不影响文档主要描述，但会影响以后重开原型。
- 证据：`"IconChoices.dc.html": { ... }`、`"LoopSteps.dc.html": { ... }`；glob 结果中没有 v2/source/IconChoices.dc.html。
- 建议：补上 `IconChoices.dc.html`，或从 canvas.json 去掉这块；LoopSteps 可注明在 process-row 目录。

## 读代码/文档证实 vs 推测

**读代码或文档直接证实：** 第 1 条的守卫约束（`recent-authentication-service.ts`）、第 2 条的 ADR/计划文字、第 3 条的规则 58 与“日常/收紧”原文、第 4 条的依赖文字、第 6 条清单缺项、第 8 条 `admitText` 内容、第 9 条触感原文、第 10 条 tokens 数值、第 12 条 38 个屏幕框、第 13 条 ADR 收紧清单、第 14 条 canvas.json 引用。另外核对到：`contracts-v2.ts:22/500/1496/1637`、`thread-contracts-v3.ts:19/244`、`control-center-inventory.ts:23/158/198/199`、`recent-authentication.ts:5`、`http-gateway-server.ts:1294`、`action-policy-service.ts:503`、`production-http-composition.ts:434` 均与文档所述一致；`tokens.json` 按读取内容判断是合法 JSON（未运行解析器）。

**推测或需真实验证：** 第 5 条 `activity` 的实际攻击效果取决于网页如何渲染、事件如何存储；第 7 条“读”档的风险取决于设备密钥被拿到的威胁模型和多用户部署；第 11 条可能复用现有通用限流器，设计没写清。

## 侧重检查

- **错误路径**：查了 `payload/text` 的 64K 限制与 `admitText` 的 CSRF/同源/会话检查，确认设备路径不能原样复用；查了挑战值 HMAC、防重放表主键、配对码条件更新、服务重启后挑战值作废；查了签名先于解析、占位值替换后再做合约校验的顺序。
- **不合规范/不可信输入**：查了 `activity` 自由文本无长度/字符约束；查了 `activityIcon` 有 40 名白名单；查了占位值 `device` 通过 `machineString` 校验；查了 `object` 会拒绝多余字段，所以“收紧”行多带字段会被合约拒绝，但这也意味着“按改处理”的反向测试可能只是合约在拒绝，未必测到了能力层。
- **安全**：查了“只凭设备密钥”能做的事，发现“读”档覆盖全部查询（记忆、规则、设置、审批、决策链、工作区等），比 ADR 0229 原始白名单大；查了确认密钥的近期验证凭据与现有守卫的会话绑定不一致；查了内部会话不携带 `built_in_mfa` 的设计方向正确，但 `device_confirmation_key` 的两端校验没写全。
- **资源耗尽**：查了 `device.request.body_bytes` 1 MB、上传/解压上限、每批记录数、`device.nonce.retained` 10000；发现配对限流没有配置键和用例，`activity` 没有长度上限。
- **不可撤销操作**：查了 `thread.delete_permanently`、`memory.mutate` 的 `delete` 等被划入“改”，需要确认密钥；`workspace.commit`、`host.file.execute` 等未显式列出，但“没写到的动作一律按改”的兜底方向是安全的。
- **规则/文档/代码一致性**：除上面列出的规则 58、触感、tokens 外，`ADR 0229 amended_by`、`ADR 0247 amends` 路径存在；新锚点 `#ui-baseline`、`#ui-review`、`#haptics`、`#process-row-icons`、`#apple-clients` 都存在；`v2` 20 张图、`v1` 14 张图、40 个图标表（6+6+6+6+6+6+4=40）均对得上；`tokens.json` 目测合法。作者声称的 `check:*` 和 `validate_docs.py --strict` 结果因工具限制未核实。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
会，且设计已经写明。过程行图标方案给每个工具的参数结构加了 `activity` 和 `activityIcon`，工具定义在请求最前面，所以老对话下一次运行会触发一次 `tool_schema_changed`/换新，老对话的请求开头不再是“只在末尾追加”。这属于 `.claude/rules/prompt-prefix.md` 第 6 条允许的换新，Andy 也已同意；每轮会变的 `activity`/`activityIcon` 是模型在工具调用里产出的，会进入追加的历史消息，不在固定开头。问题在于设计把这项改动安排成“单独的服务器端编码任务”，如果晚于第 5 批上线，就会造成第二次换新，和 ADR 0229 决定第 7 条“只发生一次”冲突。建议并入第 5 批同版本，并保证 40 个图标名按固定顺序序列化。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
固定请求头里没有新增时间、路径、随机值等会变的值；`activity`/`activityIcon` 是每次工具调用追加的内容，不是同一段固定文字被重新序列化。真正需要防的是：40 个图标名如果从无序集合或对象键生成，工具定义里的数组顺序可能随构建/请求变化。设计没有明确“40 个名字按固定顺序的常量数组”，建议写死顺序并加检查。遮盖、时间字段、无序集合这次没有新增。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
这个 PR 只有文档和设计素材，没有代码，因此没有可运行的自动检查。设计里写了将来的 `check:client-parity`、UI 常量检查、触感检查、快照测试，也列了反向用例（只用设备密钥签“改”被拒、`proactive.settings.set` 被拒、`memory.mutate` 被拒、占位值不是 `device` 被拒、挑战值重复/过期/别的设备被拒等），但这些代码和测试都还没有落地，无法验证“反向用例真的会失败”。现有文档检查只能查链接、锚点、表格列数，查不出第 1、2、3、4、9、13 条这种语义矛盾。作者声称的 `check:*` 和 `validate_docs.py --strict` 结果未核实。

**4. 每个新值产生处和使用处的校验都能接受吗？**
逐项核对后有几处不完整：
- `device_confirmation_key`：产生处是设备网关验签后生成凭据；使用处是 `RecentAuthenticationGuard`。类型在 `recent-authentication.ts:5`，但真正的白名单在 `recent-authentication-service.ts:31-37`，设计只提到前者；并且 `authenticationRef`/`externalSubjectRef` 的语义与现有守卫不一致（第 1 条）。
- 占位值 `device`：产生处是手机，使用处是设备网关替换；设计说“这两项”，但没有枚举顶层 `authorizationRef`、`thread.delete_permanently` 的 payload `authorizationRef` 和多个命令里的 `recentAuthenticationRef`，也没有写非确认请求时是否把 `recentAuthenticationRef` 置空。新值清单里没有这一项。
- `activity` / `activityIcon`：`activityIcon` 服务端有 40 名白名单，但 40 个名字没有单一代码来源，服务端常量和 Swift 资源之间没有检查；`activity` 没有长度/字符/渲染约束。新值清单里没有这两项。
- 设备管理、“感知到的”页的新消息类型：由第 1、3 批产生，第 11 批登记进能力表和 Swift；`check:client-parity` 能查存在性，但第 11 批依赖写错（第 4 条）。
- 新增“暂停系统主动提醒”类型：设计登记为“收紧”，但 ADR 0247 的“收紧”清单没有它（第 13 条）。
- `ADR 0229` 的 `amended_by`、`ADR 0247` 的 `amends`：路径都存在，`check:adr-numbers` 会检查带 `docs/adr/` 前缀的路径，这一项没问题。
- `tokens.json`：内容目测合法；但 `strokeChevron`/`strokeLarge` 与规则 54 的 1.6 不一致（第 10 条）。
- 20 张图/14 张图/40 个图标数量：文件名和数量基本对得上；只有“六排三十七屏”与 source 中的 38 个屏幕框不符（第 12 条）。
