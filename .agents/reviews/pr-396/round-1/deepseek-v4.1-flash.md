## 侧重检查

- **错误路径 / 可恢复性**：查了启动时 `seedDemoInbox`、`start`、`authorizationRedirect`、`#needsOwner`、断开和重连。发现“已有连接就跳过 seeding”会让 `needs_reconnect` 的示范连接永远修不好，也覆盖不了从真实 Gmail 连接切到 demo 的情况。
- **不合规范 / 不可信输入**：查了 `demoInbox` 的 `ja|en` 校验、gmail/demoInbox 二选一、示范令牌解析、`anchor` 的 `Date.parse`、目录 locale 校验、示范包 manifest/JSONL 校验。配置校验本身正确；令牌没有和连接模式绑定。
- **安全 / 网络**：查了 demo reader、demo OAuth、Gmail reader、断开流程、回调流程。纯 demo 模式下 reader/oauth 不联网；但配置切回 gmail 时，真实 Gmail 读取器会把示范令牌当 refresh token 发给 Google。
- **资源耗尽 / 不可逆操作**：查了邮件数量、相关邮件预算、断开后的数据删除、重启后的 seeding。邮件是固定 12 封、预算有上限；问题是断开后重启会自动重新 seeding、重新启用主动提醒，并可能重放脚本邮件产生模型费用。
- **规则 / 文档 / 代码一致**：查了 ADR 0236、ADR 0200、提示词顺序、英文包生成、设置页文案。发现记忆条数、命令清单、英文包混入中文、断开文案几处不一致。
- **未核实**：没有运行测试（只能用 read/grep/glob 和 git 命令）；ADR 引用的 `/mnt/project-files/multi-user-plan/integrated-plan.md` 未读。

## 读代码证实的问题

### 中 1. 连接模式只由配置决定，存储里的连接/令牌没有校验：demo 连接卡死，跨模式时示范令牌会进入真实 Gmail 路径

- 文件: `apps/agent-service/src/production-proactive.ts:233`、`packages/application/src/services/proactive-mail-check-service.ts:715,1546`、`packages/platform-node/src/gmail-source.ts:129-137`、`apps/agent-service/src/service-main.ts:1717-1720`
- 问题：
  1. `seedDemoInbox` 只要发现任何 `gmail` 连接就返回，不检查它是不是示范连接、状态是否为 `connected`、令牌是否可读。
  2. 如果示范令牌缺失/损坏，`#needsOwner` 会把连接改成 `needs_reconnect`；之后 `run()` 因状态不是 `connected` 直接返回，而“连接 Gmail”再次调用 `seedDemoInbox` 仍然因为“已有连接”而跳过，永久卡住。
  3. 反过来，若实例原本有真实 Gmail 连接，再改成 `demoInbox`，示范收件箱不会 seeding；demo reader 收到真实 refresh token 后返回 `unauthorized`，还会把真实连接改成 `needs_reconnect` 并清空 cursor。
  4. 若从 demo 改成 gmail，真实 `createGmailReader` 不会检查令牌前缀，会把 `demo-inbox:v1:...` 作为 `refresh_token` POST 到 Google token 端点。
- 证据：
  - `production-proactive.ts:233`：`if (await store.readConnection({ ...scope, source: "gmail" })) return;`
  - `proactive-mail-check-service.ts:715`：`if (!connection || connection.status !== "connected") return undefined;`
  - `proactive-mail-check-service.ts:1546`：`status: "needs_reconnect",`
  - `gmail-source.ts:132-133`：`["refresh_token", refreshToken], ["grant_type", "refresh_token"],`
  - `service-main.ts:1718-1719`：`reader: demoInbox ? createDemoMailReader(...) : createGmailReader({ oauth })`
- 建议：在 demo 模式下校验已有连接的 `accountRef`/令牌前缀和状态；不是可用的示范连接就替换或重建。真实 Gmail reader 使用令牌前拒绝 `demo-inbox:v1:` 前缀；模式切换时清理或迁移旧连接。

### 中 2. 断开后重启会自动重建示范连接并强制启用，用户的“断开”不持久，还会重放脚本邮件

- 文件: `apps/agent-service/src/production-proactive.ts:221-227,233,252`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:517-536`
- 问题：`start()` 在 demo 模式每次都调用 `seedDemoInbox`；断开会删掉连接和已处理邮件，重启时连接不存在，于是重新 seeding，并把 `enabled` 强制改成 `true`，锚点也变成新的当前时间。结果是用户明确断开后，重启又自动启用主动提醒，脚本邮件可能以新日期再次被处理，产生重复模型调用和推送。
- 证据：
  - `production-proactive.ts:221-227`：demo 模式启动时 `void this.seedDemoInbox()...then(() => this.tick())`
  - `production-proactive.ts:233`：只判断连接是否存在
  - `production-proactive.ts:252`：`await store.writeSettings({ ...scope, ...settings, enabled: true, now });`
  - `sqlite-proactive-operations.ts:529-536`：断开时删除 `proactive_processed_messages` 和 `proactive_connections`
- 建议：记录“用户主动断开”的标记，或只在首次开通/用户点击“连接”时 seeding，不要在每次启动时无条件重建；也不要覆盖用户已有的 `enabled=false`。

### 中 3. 英文示范包会生成中文 Markdown 和中文 manifest 说明，语言反向用例没有覆盖这些文件

- 文件: `packages/persistence-sqlite/src/data-export/markdown.ts:14-25,65,78-86`、`packages/persistence-sqlite/src/data-export/demo-pack.ts:158-160,189-194`、`test/integration/demo-data.test.ts:140-148`
- 问题：`buildDemoPack` 对 `ja` 和 `en` 都调用同一套 `renderMemoryMarkdown`，而该函数把分类名、`MEMORY.md` 标题和说明写死为中文；manifest 的 `what`/`reason` 也写死中文。英文体验者看到的 `MEMORY.md`、`memory/*.md` 和清单说明仍是中文。测试只把 `data/memories.jsonl` 和 `data/people.jsonl` 拼起来检查语言，刻意排除了 Markdown 和 manifest，所以“不混另一种语言”的反向用例没有真正覆盖整包。
- 证据：
  - `markdown.ts:14-25`：`identity: "身份"` 等中文标签
  - `markdown.ts:81-86`：`# Himawari 记忆索引`、`自动生成，不要手改。...`
  - `demo-pack.ts:158-160`：`renderMemoryMarkdown(...)` 后写入 `memory/*.md` 和 `INDEX_FILE`
  - `demo-pack.ts:189-194`：`what: "对话、消息、决策记录"`、`reason: "示范数据只含记忆和人物..."`
  - `demo-data.test.ts:141`：只筛选 `data/memories.jsonl` 或 `data/people.jsonl`
- 建议：给 Markdown 标签/索引/清单说明按 locale 提供英文版本，或明确说明 Markdown 不是 locale 内容并修正测试范围；反向测试应扫描包里所有文本文件。

### 低 4. ADR 0236 的记忆条数与代码不符，ADR 0200 的命令清单没有更新

- 文件: `docs/adr/0236-trial-users-get-demo-memories-and-a-fake-inbox.md:48`、`packages/domain/src/demo-persona.ts:126-321`、`docs/adr/0200-portable-export-of-memories-and-decisions.md:60`
- 问题：ADR 0236 写“17 条记忆”，`MEMORY_SPECS` 实际只有 16 个 key（`job`、`home`、`cat`、`coffee`、`materials`、`night`、`sister`、`lead`、`studio`、`project`、`review`、`marathon`、`mugs`、`gym-old`、`gym`、`music`）。ADR 0200 仍写命令行是 `data export|inspect|import`，没有 `demo-pack`。
- 证据：ADR 0236:48“包里是 17 条记忆”；`demo-persona.ts` 的 16 个 memory key 在第 126 到 321 行。
- 建议：修正 ADR 数字，或补上缺少的记忆并补测试；同步更新 ADR 0200 的命令清单。

### 低 5. `demoInbox` 有两个来源，没有一致性校验

- 文件: `apps/agent-service/src/production-proactive.ts:152,231`、`apps/agent-service/src/service-main.ts:1717`、`test/integration/proactive-production.test.ts:262-295`
- 问题：`ProactiveConfiguration.demoInbox` 和 `ProductionProactiveOptions.demoInbox` 都表示同一个值，`ProductionProactive` 实际用后者 seeding/读取，前者只在 service-main 里转发。若两者不一致，令牌语言、收件箱语言和配置值会分叉；测试里 `configuration` 仍带 `gmail` 而不带 `demoInbox`，只靠单独 option 模拟 demo，说明两个来源没有被约束成同一个。
- 证据：`production-proactive.ts:152` 的 `readonly demoInbox?: ProactiveConfiguration["demoInbox"];`；`service-main.ts:1717` 的 `...(demoInbox ? { demoInbox } : {})`。
- 建议：只保留一个来源（从 `configuration.demoInbox` 派生），或在构造函数里断言两者一致。

### 低 6. 邮件日期用 locale 固定时区计算，但检查用的 `timeZone` 来自 `runPolicy.timeZone`，两者没有对齐

- 文件: `packages/domain/src/demo-persona.ts:7-10,611-623`、`packages/application/src/services/proactive-mail-check-service.ts:437-452`、`apps/agent-service/src/service-main.ts:1712`
- 问题：`{day+N}` 用 `DEMO_TIME_ZONES`（ja=Asia/Tokyo，en=America/Los_Angeles）和固定 `86_400_000` 毫秒计算；邮件检查提示里的 `today` 用 `runPolicy.timeZone`，未配置时是 UTC。英文 demo 如果跑在默认 UTC 或日本时区的实例上，邮件里的“今天/明天”和提示里的 `today` 可能差一天。
- 证据：`demo-persona.ts:9-10` 定义 `ja: "Asia/Tokyo"`、`en: "America/Los_Angeles"`；`demo-persona.ts:619` 用 `arrivalMs + Number(days) * 86_400_000`；`proactive-mail-check-service.ts:446-452` 用传入的 `timeZone` 计算 `today`；`service-main.ts:1712` 用 `configuration.runPolicy?.timeZone ?? "UTC"`。
- 建议：demo 邮件日期使用与实例相同的 `runPolicy.timeZone`，并按日历日而不是固定 24 小时相加。

### 低 7. 断开文案在 demo 模式下说“已在 Google 撤销授权”，但 demo 没有 Google 授权

- 文件: `apps/control-center/src/i18n/resources/en.ts:1222`（ja/zh-CN 同类条目）、`packages/platform-node/src/demo-mailbox.ts:140-143`
- 问题：demo OAuth 的 `revoke()` 直接返回 `true`，不访问网络；但设置页断开确认和成功提示仍说会在 Google 撤销访问。体验版用户看到的内容与事实不符。
- 证据：`demo-mailbox.ts:140-143` 的 `async revoke() { return true; }`；i18n 的 `proactive.apps.disconnected` 为“Disconnected, and access was revoked at Google.”
- 建议：demo 模式显示单独的断开文案，说明不会也不能向 Google 撤销任何东西。

## 推测（未完全证实）

- **DST 边界**：固定 `86_400_000` 毫秒加天数在美国夏令时切换附近可能让 `{day+2}` 落到错误的本地日期。这是由代码事实推导出的风险，未用具体日期执行验证。
- **非法 anchor/无效 `now`**：`demoMailScript` 对非法 `anchor` 会走 `Date.parse` 得到 `NaN`，随后 `Intl.DateTimeFormat.formatToParts(new Date(NaN))` 可能抛 `RangeError`。生产时钟正常时不会触发，属于内部错误路径。
- **`DEMO_OWNER_ADDRESS` 未使用**：`packages/domain/src/demo-persona.ts:5` 定义了它，但实际使用的是 `packages/platform-node/src/demo-mailbox.ts:15` 的 `DEMO_MAILBOX_ACCOUNT`，两处字符串相同但没有共享常量，存在漂移风险。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   没有发现改动系统提示、工具定义、历史消息或遮盖规则，`packages/prompt-catalog` 也没动。示范邮件走的是现有邮件检查路径：固定指令 `MAIL_JUDGMENT.text` 在最前，邮件数据/相关邮件在中间，`now/timeZone/today` 由 `renderPrompt(MAIL_JUDGMENT_NOW, ...)` 放在最后（`proactive-mail-check-service.ts:437-480`）。示范记忆通过现有记忆注入路径进入最后一条用户消息，不进系统提示。就这次改动而言，没有破坏“只在末尾追加、每轮变化值放在最后消息”的规则；但这是后台单轮检查，不是多轮会话，中间邮件数据本来就会随每次检查变化，这是既有设计。

2. **同一段文字会不会在不同请求里变成不同字节？**
   同一次连接内基本确定：邮件偏移固定、按 `receivedAt` 排序、消息 ID/线程 ID/link 固定，令牌里的 anchor 固定；示范包 manifest 用 canonical JSON、文件列表排序，记忆和人物按固定数组生成。邮件内容没有需要按前后文遮盖的秘密。问题在于**跨重连不稳定**：anchor 是 seeding 时的当前时间，断开/重启后会变，邮件日期和 `receivedAt` 随之变化；同时断开删除了已处理记录，重新 seeding 后同一脚本邮件可能再次进入提示词。因此“同一连接内确定”成立，“重连后同一逻辑邮件同字节”不成立。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有测试：`test/integration/demo-data.test.ts`、`proactive-production.test.ts` 的 `[P6-demo]`、`startup-configuration.unit.test.ts` 的 `[P6-demo]`、`proactive-interactions.unit.test.ts` 的 `[P6-demo]`。其中无效 locale、gmail/demoInbox 同时或都不写、非示范令牌 `unauthorized`、伪造回调、demo reader/OAuth 不调用 fetch 等反向用例是有效的。但有几处不能证明作者宣称的全部性质：
   - 没有任何测试经过 `service-main` 的配置到 reader/OAuth 选择；集成测试是手工把 `createDemoMailReader`/`createDemoGoogleOAuth` 传入 `ProductionProactive`。
   - 英文包语言测试只扫两个 JSONL 文件，扫不到中文 Markdown/manifest，所以“不混另一种语言”的反向用例实际上漏掉了会失败的文件。
   - “不同时刻产生不同日期”的测试用整包文本 `not.toBe` 比较，`exportedAt` 变化本身就足以通过，不能证明日期字段真的重算。
   - 没有覆盖 `needs_reconnect` 后点击连接、断开后重启、真实 Gmail 连接切 demo、demo 切 gmail 的反向路径。
   我没有运行测试，以上是阅读测试代码得到的结论。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `DemoLocale`：`strict-configuration.ts` 用 `isDemoLocale` 校验，`buildDemoPack`、`demoMailScript`、`demoMailboxToken` 都只接受 `ja|en`，使用处一致。
   - `demoInbox` 配置：service-main 接受并传给 `ProductionProactive`；但存在两个来源（见问题 5），且存储里的旧连接没有按该值重新校验。
   - 示范令牌 `demo-inbox:v1:<locale>:<anchor>`：demo reader 解析前检查前缀和 locale；**真实 Gmail reader 不检查前缀**，会把它当 refresh token 使用（见问题 1）。
   - 账户 `demo@himawari.example`：连接存储、overview、邮件发件人都能接受；但 `DEMO_OWNER_ADDRESS` 与 `DEMO_MAILBOX_ACCOUNT` 重复。
   - `demoMemoryId` / `demoPersonId`：符合导出 schema 的长度限制，`supersededBy`/`personIds` 引用都能在同一个包里找到；测试也覆盖导入成功。
   - `DEMO_MAILBOX_SETTINGS_RETURN` 与 `gmail=demo`：`GmailOutcome`、`readLaunchIntent`、设置组件、三语 i18n 都同步接受了。
   - manifest/counts/文件清单：符合 `MANIFEST_SCHEMA` 和 `verifyIntegrity` 的检查，测试会走 `parsePortable`/导入。
   - CLI `data demo-pack` 的输出：没有发现其他消费者；只有测试和命令行打印。
   - 时区值：`DEMO_TIME_ZONES` 只用于生成邮件文字，没有和 `runPolicy.timeZone` 交叉校验（见问题 6）。
   - 文档值：ADR 0236 的“17 条记忆”与实际 16 条不符（见问题 4）。
