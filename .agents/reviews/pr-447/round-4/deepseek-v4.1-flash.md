## 结论

本次提交是纯文档改动（`git diff --stat cc510…2fa` 只有 `docs/adr` 和 `.agents/reviews`，`git status` 干净），所以**当前**不会改变任何模型请求。文档里的设计有几处需要修：一处安全的凭据检查漏洞、一处测试与规则自相矛盾、限频统计口径与决定 13 的统计表对不上。作者列出的 4 条代码说法基本属实，但第 2 条有边界，第 4 条所依赖的统计表还没实现。

---

## 问题（按严重度）

### 高｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:134`（另见 `:270`）
【推测，基于 WHATWG URL 规范，未运行 Node】项目名凭据检查会放过“解析器已识别出用户名/密码、但主机为空”的写法，令牌仍会被收下。

证据（规则原文）：

> “一，用标准的网址解析（Node 的 `URL`）试着拆这个名字……拆得开、并且拆出了主机的，就是远程地址，带用户名、密码、查询参数或 `#` 后面的部分就拒绝。……三，名字开头到第一个 `@` 之间没有空白和 `/`，并且这一段里有 `:`……或者 `@` 后面紧跟一段没有空白和 `/` 的文字再接 `:`，拒绝。”

反例：`foo://user:tok@/p`。按规范，Node 的 `URL` 会解析出 `username = "user"`、`password = "tok"`、`hostname = ""`。第一步因为“没有拆出主机”不按远程地址处理；第二步因为它是“拆得开”的，不触发“有 `://` 却拆不开”；第三步因为第一个 `@` 前面有 `/`、后面紧跟 `/p`，两条都不匹配。结果整条名字被照常收下。`//user:tok@/p` 也类似：补协议后若用特殊协议会因空主机抛错，而原文没有 `://`，第二步管不到；用非特殊协议则直接解析出 userinfo。`\\user:tok@\p` 经反斜杠转换后同理。测试条目只列了带主机的写法（`:270`），覆盖不到。

为什么严重：项目是主人名下、跨接入共享的（决定 8：“两个接入推同一个仓库，落在同一个项目里”），项目名还会进页面/检索结果；这和 ADR 自己写的“错拒比把令牌存下来好”直接冲突。

建议：只要 `URL` 解析成功且 `url.username !== "" || url.password !== ""`，就拒绝，**不要求主机存在**；带 `//` authority 的名字再考虑检查 `search`/`hash`。补反向用例：`foo://user:tok@/p`、`//user:tok@/p`、`\\user:tok@\p`、`https://:tok@host/p`（只有密码）、`https://host/p?token=1`、`https://host/p#frag`。

### 中｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:134` 与 `:270`
【证实：读文档】测试条目与规则第 3 步矛盾。

- 规则第 3 步第一条：“名字开头到第一个 `@` 之间没有空白和 `/`，并且这一段里有 `:`”就拒绝。
- 测试条目却说：“项目名不是远程地址写法的一批（中文、带空格、带 `?`、`#`、`@`、`:`，但开头不是 `用户@主机:` 写法）照常收。”

`meeting:bob@corp.com`（冒号后没有空格）会被第 3 步第一条拒绝（`@` 前是 `meeting:bob`，含 `:`、无空白和 `/`），但它并不以 `用户@主机:` 开头；`mailto:user@example.com` 同样。测试里的“开头不是 `用户@主机:`”没有覆盖第 3 步第一条。另外第 3 步第二条并不要求出现在名字开头，`看 git@host:path` 也会被拒，但同样不“开头是 `用户@主机:`”。

建议：把测试条目改成“不匹配第 3 步两种 `@` 写法的普通名字照常收”，并把 `meeting:bob@corp.com`、`mailto:user@example.com` 明确写成拒绝例子；或者把第二条也锚定在名字开头，只拦真正的 scp 写法。

### 中｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125`、`:169`、`:170`、`:171`
【证实：读文档】“被拒几次”在决定 13 的统计表里没有落点，且限频口径与表键可能不一致。

证据：

> `:125` “限频和页面上的次数用同一个口径：每调用一次 `propose_rule` 算一次，重发也算；按天记，和决定 13 的统计表一样。”
>
> `:169` “每个接入还显示规则提议提了几次、因为超过频率被拒几次……按天记在下面那张统计表里。”
>
> `:170` 统计表的键是“接入 + 天 + 工具 + 进门方式 + 是不是 `auto`”，计数是“调用次数、空手而归次数、有内容次数、失败次数”。
>
> `:171` “失败次数……参数不合格和超过上限被拒的也算。”

问题：表里没有“因频率被拒”的独立字段。若把“被拒几次”塞进“失败次数”，会混入参数不合法、内部失败等；若另加列，ADR 没写。并且限频是“按接入”，表行却按“进门方式”拆开，页面逐行显示的数字会与按接入汇总的限频额度不是同一个口径。另需明确“每调用一次”是否包括参数不合法、客户端不支持 elicitation、proposals 未就绪的调用。

建议：给统计表加一个明确计数（例如 `rate_limited_count`）或增加“结果/原因”维度；写明限频按接入汇总、页面如何聚合；写明哪些调用计入“提了几次”。

### 中｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:270`
【证实：读文档】反向用例覆盖不足，尤其缺 F1 的绕过写法和“只有密码”写法。

现有条目列了 `协议://用户:令牌@主机/路径`、协议大写、`//` 开头、少写斜杠、反斜杠、前后空白、`用户:令牌@主机/路径`、`用户@主机:路径`，但缺：

- 主机为空的 `foo://用户:令牌@/路径`、`//用户:令牌@/路径`、`\\用户:令牌@\路径`；
- 只有密码的 `协议://:令牌@主机/路径`（实现若只检查 `username` 会漏）；
- 只有查询参数或只有 `#` 的 `协议://主机/路径?token=1`、`协议://主机/路径#frag`。

建议：补上这些用例，并继续断言“返回原因、决策记录、日志里搜不到令牌”。当前没有可运行检查（作者已说明新条目是任务 B/C 的计划项），所以这些计划项本身就是唯一的防线。

### 中｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125` 与 `apps/agent-service/src/production-mcp-read.ts:752`
【证实：读代码/文档】限频检查必须排在试算之前，ADR 没写。

代码：

> `production-mcp-read.ts:752` `const preview = await rules.preview(proposal);`
>
> `:684`、`:723` 第一次调用和“带状态但不带回答的重发”都会进 `#askRuleConfirmation`。

ADR 用“不限的话对方反复改参数或反复重发就能一直让 Himawari 重算”来论证限频；但如果实现把限频判断放在 `#askRuleConfirmation` 里或之后，超限请求仍会先跑一遍近 30 天回放，限频就挡不住费用。建议明确写“先查限频，再 preview/发确认”，并加一条用例：超限调用不得调用 `replay`。

### 低｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:125` 与 `.claude/rules/prompt-prefix.md:44`
【证实：读文档】外部 agent 的工具定义随规则类型登记表变化，与规则 7“工具集合尽量不变”不一致。

ADR：

> “登记表变了，对外 MCP 上 `propose_rule` 的工具定义跟着变一次；变的是外部 agent 那边的请求开头，不是 Himawari 自己的。”

prompt-prefix 规则：

> “工具集合尽量不变……不能用的时候由执行端拒绝，而不是把工具删掉或加进来……要改变这个取舍，先出方案。”

如果这条规则只约束 Himawari 自己的请求，应在 ADR 或规则里写清；如果也约束外部 agent，那么新增一种外部可提规则类型会让正在进行的每个外部会话的工具 schema 变化一次，不是末尾追加。建议把 `propose_rule.type` 保持为稳定字符串、在运行时按登记表校验，避免 schema 变化；或把这一例外写进 prompt-prefix 规则。

### 低｜`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:104`
【证实：读代码】`INVISIBLE_FORMATTING` 的引用位置不对，且“清洗”与“拒绝”不是同一套行为。

ADR 说“字符集和 `apps/agent-service/src/production-mcp-memory-writer.ts` 里清洗正文用的 `INVISIBLE_FORMATTING` 相同”。实际定义在：

> `packages/persistence-sqlite/src/external-proposal-text.ts:3` `const INVISIBLE_FORMATTING = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu;`

`production-mcp-memory-writer.ts:24` 只是 `import { normalizeProposalText, proposalTextDigest }`，`:86` 再导出；它没有直接使用这个常量。另外 `normalizeProposalText` 是把不可见字符**替换成空格**（`external-proposal-text.ts:6`），而项目名规则要求**拒绝**。如果任务 C 直接复用 `normalizeProposalText`，拒绝用例不会触发。建议改引用位置，并写明项目名校验要在替换前用字符类拒绝。

---

## 作者说法核对

1. **“带状态但不带回答的重发会再走一次 `#askRuleConfirmation`，里面调 `rules.preview`”**：属实。`production-mcp-read.ts:721-723` 在 `answer.kind !== "elicit"` 时重新调用；`:752` 调 `preview`。
2. **“`production-owner-rules.ts` 的 `create` 里也调 `#replay`”**：属实，但只对非 `soft` 类型且在配置了 replay 时（`:627`；`:478-485` 在未配置或异常时返回 `null`；`:603-625` 的软偏好提前返回）。外部邮件规则走的是非软路径。
3. **“`sqlite-memory-operations.ts` 的 `CATEGORIES` 含 `rule`”**：属实，`packages/persistence-sqlite/src/sqlite-memory-operations.ts:138-149`，`"rule"` 在 `:144`。对外抄本都不含 `rule`：`sqlite-external-memory-proposal-operations.ts:54-64`、`data-export/schemas.ts:153-163`、`production-mcp-memory-writer.ts:46-56`、迁移 `0093:11-16`、`contracts-v2.ts:1198-1201`。
4. **“ADR 0242 决定 13 写了‘用量数字存在单独的按天统计表里’”**：属实，`:170`。但代码里还没有这张表（决定 13 的编码任务未做），而且它没有“因频率被拒”的计数维度（见上）。

补充一个边界：`确认` 时 `confirm` 调 `#activate(proposal, null)`（`production-owner-rules.ts:675`），`ProductionMcpRuleWriter.accept` 也没用 `create` 返回的 `replay`（`production-mcp-rule-writer.ts:71-83`）。所以“接受后还会再算一次”属实，但这次结果被丢掉了，只是纯重算；如果目的是给主人看最新试算，这里没有做到。

---

## 侧重检查

- **错误路径/不可信输入**：项目名检查必须捕获 `new URL` 的所有抛错；没有 `://` 的名字抛错要按普通文字收（如 `调研#2`），否则会崩。空主机 userinfo 是已发现的绕过（F1）。“只有密码”写法 `://:令牌@` 依赖实现同时检查 `username` 和 `password`，测试没覆盖。`new URL` 的错误对象/消息可能包含被拒名字原文，实现时不得把异常消息直接写日志，否则违反“日志不记被拒名字”。控制字符/零宽字符/代理项由 `INVISIBLE_FORMATTING` 字符类覆盖，但要“拒绝”而不是复用 `normalizeProposalText` 的“替换”。分类参数目前 `production-mcp-read.ts:810-812` 把非字符串类别当作“没给”落到 `other`，而新补注说“给了清单里没有的值就不合格”；任务 C 的独立解析入口应区分“缺失”和“类型不对”。
- **安全**：F1 会把凭据留在项目名里；项目跨接入共享、会进检索/页面，存在二次暴露面。拒绝原因只写类别、决策记录和日志不记原文的方向正确，计划中的测试要覆盖主机为空的绕过。贴回的别家文本只靠“只当资料、不当指令”的文字约束，没有技术隔离；好在其结果进待确认、由主人点头，没有自动执行。筛选发送待确认正文等未来 ADR 定遮盖和可发给哪些模型，当前未实现，未核实。
- **资源耗尽**：试算回放是主要成本。限频必须排在 `#askRuleConfirmation`/`preview` 之前（F5）；“每调用一次”是否包含不合法/不支持/未就绪的调用要写明。筛选和贴回文本的上限、排序、遮盖都 deferred 到未来 ADR，当前无从核实。入口请求体/频率上限、`start_here` 字数预算未被这次改动放松。
- **不可撤销操作**：这次改动只增加校验/拒绝，没有新增删除或覆盖操作；被拒的项目名可由对方换写法重推。筛选只给建议，不自动收。未发现新增不可撤销路径。
- **规则文件/文档一致性**：ADR 0226（`:56`、`:58`、`:64`）、0228（`:64`）、0246（`:90`）与 0242 的“筛先不做/等另一份 ADR”一致；类别清单五份对外抄本与 `MEMORY_CATEGORIES` 去掉 `rule` 完全一致；规则类型“现状还差两处、不得只换清单”与 `rule-types.ts` 的实际接口一致（`RuleTypeDefinition.parse` 返回 `MailMatchParameters`，`:48`；`RULE_TYPES` 只有两种，`:202-213`；`writableRuleType` 用 `RULE_TYPE_UNTESTED` 拒绝，`:224-231`）。未对上的是 prompt-prefix 规则 7 与外部工具定义变化（F6），以及 `INVISIBLE_FORMATTING` 的引用位置（F7）。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
本次提交是纯文档，当前不会改变任何请求。按设计：Himawari 自己的系统提示和工具定义不加入这些对外 MCP 工具/说明；新后台调用是固定指令在前、数据在后；项目名检查、类别清单、限频统计都不进 Himawari 的提示或工具定义。唯一会改变请求开头的是**外部 agent 的 `propose_rule` 工具定义随规则类型登记表变化**（`:125`），ADR 已承认这不是 Himawari 自己的请求，但它不是“末尾追加”，且与 prompt-prefix 规则 7 的偏好不一致（F6）。每轮会变的回放数字、统计数字、限频数字都不在系统提示/工具定义里；回放数字出现在 MCP 确认消息中，属于末尾的确认内容，不是前缀。

**2. 同一段文字会不会在不同请求里变成不同字节？**
按现在的文档，设计上是确定的：项目名去掉首尾空白并统一 NFC；拒绝原因不带名字；类别清单、规则类型列表顺序固定；F1 的拒绝路径也不回显名字。未核实/未定的是：筛选的遮盖、排序、一次多少条全部 deferred 到未来 ADR（`:142`、`:208`），现在无法证实；项目名规则只说“判断时”把反斜杠当正斜杠，没说存储/比较是否也统一，`C:\x` 与 `C:/x` 可能仍是两个项目键（同一段文字每次仍是同字节，但同一逻辑项目可能不归一）。此外 `new URL` 的异常消息可能包含原文，若被日志打印会造成“同一段文字以不同形式落日志”，实现时需禁止。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
没有可运行的自动检查：本次是纯文档，作者也说明新测试条目是任务 B/C 的计划项。现有新增条目只是计划，不能证明反向用例会失败。并且计划本身有缺口：F1 的空主机 userinfo、只有密码、只有查询参数/`#` 都没有反向用例；F2 的测试分组与规则第 3 步冲突。类别清单一致性和规则类型声明也仍是计划项，未运行。

**4. 每个新值/改动值的使用端都能接受吗？**
- **类别清单**：能。五份对外抄本都等于 `MEMORY_CATEGORIES` 去掉 `rule`；`sqlite-memory-operations.ts` 的完整清单含 `rule` 且被明确排除。使用方 `production-mcp-read.ts:532`（工具 enum）、`:818`（写入校验）、`sqlite-external-memory-proposal-operations.ts:145`、`data-export/schemas.ts:183`、`contracts-v2.ts:1588`、迁移 `0093:11-16` 都接受这 9 个值。
- **项目名**：拒绝原因、决策记录、日志的消费方按新规则设计；但 F1 的接受路径会把凭据型项目名交给项目映射、`find_memories`、页面和其他接入，使用端会原样接受并可能展示，需先堵 F1。
- **限频计数**：页面/周报要消费，但决定 13 的统计表没有定义“因频率被拒”字段，也没说限频按接入汇总与表中按“进门方式”分行如何对齐（F3）；限频检查顺序未写（F5）。
- **规则类型**：现状的 `EXTERNAL_RULE_TYPES`（`production-mcp-rule-writer.ts:16`）、工具 enum（`production-mcp-read.ts:613`）、类型校验（`:671`）、确认文案（`:765`）、`ruleParameters`（`:324-328`）都不接受新类型；ADR 已说任务 C 才改、且不得只换清单，这一点一致。决定 13 的“按天统计表”文字存在，但表本身尚未实现（任务 B 未做）。

**未核实**：Node 对空主机非特殊协议的运行时行为（按规范推断，未执行）；复核记录文件（工具拒绝读取，工作树中也找不到对应路径）；未来筛选 ADR 的具体遮盖/排序/限频；决定 13 统计表的实际代码（尚不存在）。
