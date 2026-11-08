你是独立的代码复核者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
系统的真相在代码里。下面「作者的说法」可能有错，每一条都要对照代码核对；发现说法和代码不一致，要明确指出。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 65b2d9f0ad1868822b1441716a65d1190a209e5b。
对比基准是 9f759313bcb36a5e66d688a0e8f4038b6ab6a713，先运行 git diff 9f759313bcb36a5e66d688a0e8f4038b6ab6a713..65b2d9f0ad1868822b1441716a65d1190a209e5b 看改动。
作者的说法（可能有错，请核对）：
# 去掉整段拦下 PR4：内部存储和展示用原文，占位符还原

## 背景和目标

Himawari 以前遇到疑似密钥、密码、证件号、银行卡号时“整段拦下”（拒绝存、拒绝显示）。Andy 定的原则（2026-11-06）：只在数据发往外部（大语言模型、网页搜索、TypeSafe）时把敏感值遮成占位符；内部存储和界面展示用原文（“用户是自己人”）；复制、编辑、导出保持逐字节原样。这是 5 个 PR 里的第 4 个：PR1–PR3 已合并（发往外部的遮盖已完成），本 PR 去掉内部各处的拦下，并把模型照抄进输出里的占位符还原成原文。已接受的代价：`[密钥]`（机器密钥）不带编号、无法还原；Andy 自己的库里会多存几份明文。

占位符形如 `[密码#xxxxxxxx]`、`[验证码#…]`、`[证件号#…]`、`[银行卡 尾号NNNN#…]`（xxxxxxxx 是用遮盖密钥算出的 8 位字母编号），遮盖发生在 `ModelEgress` 出口，对同一内容、同一密钥每次结果相同。

## 改了什么

1. 删除内部整段拦下 / 遮盖（改动前它们在存储或展示前检查 `scanMachineSecrets`、`containsRestrictedIdentifier`、`credentialFindings`、`redactTracePayload` 并拒绝或打码）：
   - 记忆自动整理 `automatic-memory-service.ts`（来源、候选、批准三处）、`production-memory-capture.ts`（来源与候选）、记忆写入 `production-memory-control.ts`（`assertStorable` 只剩空文本检查）、提醒 `production-reminder-writer.ts`（只剩长度检查）、对话标题 `production-thread-titles.ts`、沙箱诊断 `production-sandbox-control.ts`、Muse 接收 `production-muse-intake.ts`、检查点 `thread-checkpoint-service.ts`、反思 `reflection-service.ts`、执行时间线 `execution-live-feed.ts` 与 `thread-execution-projection.ts`、Pi 流式输出 `pi-model-transport.ts`（不再用 `StreamingMachineSecretRedactor`）。
   - 模型自己把候选标成 `restricted` 时仍丢弃（`restricted_excluded`）；这是模型的判断，不是我们扫描的结果。
2. 新增 `packages/sensitive-capture/src/restoration.ts`：`placeholderTable(source, tag)` 用同一把密钥对“发给模型的完整提示文本”重新遮一遍，得到“占位符 → 原文值”的表；`restorePlaceholders(text, table)` 把文本里的占位符换回原文，找不到的占位符保持原样。
3. `ProductionMemoryCapture` 与 `ProductionThreadTitles` 新增 `externalTag`（生产装配在 `production-run-composition.ts`，取 `options.egress.externalTag()`）。记忆整理：`generate` 之后对解析出的候选 `text` 与 `quote` 逐字段还原（不在原始 JSON 上还原，因为还原出的值可能含引号破坏 JSON）；`quote` 还原后才和主人原话比对。对话标题：对生成的标题还原后再裁剪/校验。
4. `scripts/check-egress-redaction.mjs`：删去 9 条 `SENSITIVE_GATE_CALLS` 登记，`restoration.ts` 加入 `REDACTOR_ONLY_FILES`。
5. 合并最新 main 时的冲突两处（`production-memory-capture.ts`、`automatic-memory-service.ts`）：保留本 PR 的删除，并接上 main 新增的“待确认记忆”（`tentativeTexts`）。这部分请特别看：待确认记忆的逻辑本身是 main 的，本 PR 只在其周围删拦截。

## 没有改的（请核对是否漏了或故意留下是否合理）

- `session-trace-recorder.ts` 记录追踪（trace）时仍调用 `redactTracePayload`（`trace-redaction.ts`）：写入存储前打码。本 PR 没动它，留给 Andy 决定它算不算“内部存储”。
- `packages/runtime-pi/src/pi-runtime-adapter.ts` 里诊断日志用 `isSensitiveQueryParameter` 给网址打码，没动。
- `ModelEgress` 本身（发往模型的遮盖）不在本 PR，行为不变。

## 测试

- 新测试名字带 `[mask-not-block]`：`packages/sensitive-capture/test/restoration.unit.test.ts`；记忆整理还原（`test/integration/production-memory-capture.test.ts`，含“模型照抄占位符 → 存的是原文”“还原不了的占位符不存”“模型标 restricted 仍丢弃”）；`apps/agent-service/test/production-thread-titles.unit.test.ts`（标题还原；含密钥的标题照存）；`packages/application/test/memory-credential-storage.unit.test.ts`（原 `memory-credential-exclusion`，改为“照存”并保留 restricted 反向用例）；以及时间线、Pi 流式输出、Muse、沙箱诊断、提醒、记忆写入的对应改写。
- 反向验证：把还原关掉后“还原占位符”用例失败。
- 容器内 apps、packages 单测 4520 条通过，`npm run check` 41 步全过；`thread-run-lifecycle` 的 [UI-9] 用例改为：工具调用参数里的凭据现在如实显示，思考过程、签名、提供方元数据、内部数据仍不泄露。

## 请重点看

- 必答问题 1：本 PR 不改发往模型的请求，只改存储和展示；还原只改变“存进库里的字段”。请确认没有哪条改动让已经发给模型的历史（工具调用参数、历史消息、系统提示、工具定义）的字节变化。特别是 `pi-model-transport.ts` 不再遮 Pi 流式输出里的机器密钥：这是模型输出落入历史前的一步，请判断它是否影响下一轮请求里这条历史的字节（历史存的是实际发出去的那一条；出口遮盖在发送时对历史重新遮）。
- 还原表是从“发给模型的完整提示文本”重建的：模型在 `quote` 里把占位符和周围文字一起抄回来时，还原后是否一定和主人原话逐字相同？有没有“占位符被模型改写/拆开/重复”导致误还原成别的值的路径？（同一内容两个不同值编号不同；编号 8 位字母，碰撞概率？）
- `[密钥]` 无编号：模型把它抄进候选后保持 `[密钥]` 原样存入记忆，这会不会存成一条“主人的密钥是 [密钥]”的垃圾记忆？
- 时间线现在显示工具调用参数原文：展示给 Andy 本人，没有对外分享入口？请核对有没有把时间线内容发给别的人或服务的路径（例如导出、分享链接、通知推送）。
