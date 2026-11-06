# 问题

出口遮盖（发给模型之前把敏感信息换成占位符）会把 Himawari 自己写的固定指令也拿去检查。自动整理记忆的固定指令里有一句“confidence 是 0 到 1000 的整数”，“1000”被当成验证码遮掉，发给模型的变成“confidence 是 0 到 [验证码#xxxxxxxx] 的整数”，并在“敏感信息拦截记录”页面上记了一条“验证码 · 你的话”的误拦截。这从出口遮盖上线起就存在。

# 已核对的事实

1. 验证码规则：4 到 8 位数字，前后 40 个字符内出现关键词就遮。`packages/sensitive-capture/src/redaction.ts:65-68`（`VERIFICATION_CODE_KEYWORD`、`CODE_WINDOW = 40`、`DIGIT_RUN`），`:256-266` 命中后 `mask("verification-code", ...)`。同文件 `:268-282`：满 6 个字符的已认出的密码或验证码会记进 `known`，之后在同一请求里再次单独出现也遮。
2. 原文：`packages/prompt-catalog/src/memory.ts:16-17`，上一行末尾“……密码和验证码用 restricted。”，下一行“confidence 是 0 到 1000 的整数……”。对整个目录逐条单独跑 `findSensitiveValues`，只有 `memory.capture` 被命中（值 `1000`）。
3. 整理记忆请求：`apps/agent-service/src/production-memory-capture.ts:132-133` 把 `MEMORY_CAPTURE.text` 和 `JSON.stringify({...ownerMessage, existingMemories, previousAssistantMessage...})` 用换行拼成一个字符串；`packages/runtime-pi/src/egress-context.ts:23-27` 把它放进唯一一条 user 消息，系统提示是占位符说明 `EGRESS_PLACEHOLDER_LEGEND`。
4. 出口遮盖：`packages/application/src/services/model-egress.ts`。`wrapFetch` 解析请求体 JSON，`maskTree` 对每个字符串调用 `redactForEgress`（`:189-219`）；出处按消息 role 判断，`partOf`（`:286-305`）把所有 user 消息记成 `owner_message`。三处入口：`packages/runtime-pi/src/pi-runtime-adapter.ts:999`（聊天，purpose `chat`）、`packages/runtime-pi/src/pi-model-transport.ts:313`（后台调用，purpose 由 `apps/agent-service/src/production-model-composition.ts:469` 传入，如 `thread-title`、`memory-capture`）、`packages/memory-engine/src/embedding.ts:193`（向量检索）。
5. 提示词目录：`packages/prompt-catalog/src/entry.ts`，条目有 `fixedPrompt`（整段文字）和 `templatePrompt`（文字片段加槽位）。约 115 个条目、144 个文字片段，其中很多片段很短（如“。”“，”“/”“命令：”“ 秒”）。含遮盖关键词（密码、验证码等）的条目：`memory.capture`、`mail.judgment`、`chat.egress-legend`、`chat.egress-legend-with-restore`（`packages/prompt-catalog/src/chat.ts:249-268`，它被拼在聊天系统提示末尾，见 `egress-context.ts:17-19`）、`tools.web-fetch`。
6. 拦截记录已经存了 `purpose`（`packages/application/src/ports/sensitive-interceptions.ts`，去重键含 purpose：`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:61-73`），三种语言的 `sensitive.purpose.*` 文案已存在（`apps/control-center/src/i18n/resources/zh-CN.ts:1201-1208`）。页面 `apps/control-center/src/components/sensitive-interceptions.tsx:99` 的 `where()` 对属于对话的记录只显示“对话「标题」· 出处”，不显示 purpose。
7. 业界：关键词加距离窗口是通行做法（Google 热词规则、Presidio 上下文词、Microsoft Purview 距离）。排除误报：Google Sensitive Data Protection 的排除规则（https://docs.cloud.google.com/sensitive-data-protection/docs/creating-custom-infotypes-rules ：“A Dictionary object, which contains a list of strings to exclude from the results.”），Presidio allow list（https://presidio.dataprivacystack.org/tutorial/13_allow_list/ ：“To specify an allow list we just pass a list of values we want to keep as a parameter to call to `analyze`.”）。

# 目标

1. 根因修复：Himawari 自己写的固定指令（提示词目录里的固定文字）不检查，也不拿来当关键词上下文；只检查外来内容（主人的话、上传的文件、网页、工具结果、邮件、已存记忆等）。
2. 自动门槛：测试保证提示词目录里每段固定指令经过真实的出口遮盖发出时原样不变；有反向用例（撤掉修复，“1000”被遮，测试失败）。在 `docs/incidents-and-gates.md` 加一行事故。
3. 界面写明是哪次调用：对话里的记录也写明用途（例如“起对话标题”“自动整理记忆”）；后台调用里的固定指令不再显示成“你的话”。是改出处分类 `partOf` 还是只改页面，由方案决定。

# 约束

- 遮盖结果必须确定：同一段内容每次遮成同样的字节；一条消息遮成什么样只取决于它自己和它前面的内容（`.claude/rules/prompt-prefix.md` 第 10、11 条）。
- 发给模型的内容只追加；改动若会让模型已经见过的请求开头变化，必须写明并请 Andy 确认（`.claude/rules/prompt-prefix.md` 第八节）。
- `npm run check:prompt-prefix`（`packages/runtime-pi/test/prompt-prefix.compat.test.ts`）和 `[SI-2]`（`test/integration/sensitive-interceptions.test.ts`）要继续通过。
- 不靠改写提示词措辞来绕开（Andy 已否）。
- 边界：固定指令和动态数据挨在一起时（固定指令结尾紧挨 JSON 开头），动态数据里的数字不能因为固定指令里的关键词被遮；动态数据里自己带关键词和数字时仍要遮。聊天系统提示、占位符说明也是固定文字，同样适用。
- 不在这次范围：规则升级（与 secretlint 取并集、detect-secrets 关键词做法）另做。
- 代码里不写注释（项目规则）。
