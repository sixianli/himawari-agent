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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、文件:行、问题、证据（引用你亲自读到的那几行代码）、建议。把「读代码证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 e5edb5469d7b80782048a0dead5192e1ebda0429。
对比基准是 f0478c4de46347f87e23ff4d131e26f4c7f41d13，先运行 git diff f0478c4de46347f87e23ff4d131e26f4c7f41d13..e5edb5469d7b80782048a0dead5192e1ebda0429 看改动。
作者的说法（可能有错，请核对）：
# 去掉整段拦下 PR3：搜索词、网址、TypeSafe 先遮再发

## 背景和目标

Himawari 以前遇到疑似密钥、密码时“整段拦下”。Andy 定的原则：只在数据发往外部（大语言模型、网页搜索、TypeSafe）时把敏感值遮掉；内部存储和显示用原文。这是 5 个 PR 中的第 3 个，只处理发往网页搜索服务（Exa、DeepSeek 网页工具）和 TypeSafe 代码审核的请求。发往大语言模型的遮盖（`ModelEgress`）不在这个 PR 里改。

改动前的行为：
- 搜索词里有机器密钥（`scanMachineSecrets` 认出的 7 类）就整次拒绝：`WEB_SEARCH_INPUT_INVALID`（`production-coding-workflow.ts`、`exa-public-search.ts`、`deepseek-web-provider.ts`）。
- 读网页的网址里有机器密钥或 `user:pass@` 就拒绝：`WEB_FETCH_INPUT_INVALID`（`validatePublicFetchUrl`）。
- TypeSafe 请求体或回复里有机器密钥就整次失败（`assertMachineSecretFree`）。

## 改了什么

1. `packages/sensitive-capture/src/external.ts`（新）：
   - `redactForExternalText(text, { tag })`：就是 `redactForEgress` 加上调用方给的编号函数，规则和发给模型的出口遮盖完全相同（机器密钥、密码、验证码、银行卡、证件号）。
   - `redactForExternalUrl(url, { tag })`：去掉 `user:pass@`；查询参数按整个参数名（去掉大小写和分隔符后）判断敏感，名单见 `SENSITIVE_URL_PARAMETERS`，另有 `X-Amz-*`、`X-Goog-*` 前缀；敏感参数的值换成占位符；其余部分再按文字规则遮一遍；网址里的占位符都做百分号编码，免得占位符里的 `#` 被当成片段开头。已经是占位符的值（原样或编码后）不再遮第二次，所以对遮过的网址再跑一次，结果不变（带不带编号函数都一样）。
   - `isSensitiveUrlParameter`：整名匹配，`monkey` 不会命中 `key`。旧的 `isSensitiveQueryParameter`（子串匹配）只用于诊断日志打码，这个 PR 不动，留给 PR4（内部显示用原文）一起处理。
2. `ModelEgress.externalTag()`（`packages/application/src/services/model-egress.ts`）：返回和发给模型时同一个编号函数（同一把密钥、同一个算法，抽成 `placeholderTag`），所以同一个密码在聊天请求里和在搜索词里是同一个占位符；两个不同的密码得到不同的占位符，搜索缓存不会串。
3. 入口遮一次（`apps/agent-service/src/production-coding-workflow.ts` 的 `outboundWebArguments`）：`web_search` 的 `query`、`web_fetch` 的 `url` 在入口遮好，后面的校验、缓存键（`WebToolMemory.key`）、发给服务进程内搜索（`hostWeb.execute`）的参数、沙箱搜索程序的保存输入（`ctx.save("input")`）、授权意图里的 `input-digest` 和 `resourceRef` 都用遮好的值。编号函数由 `ProductionFileReadServices.externalTag` 提供，生产装配在 `service-main.ts`（懒创建一个 `ModelEgress`，用和聊天相同的配置和密钥来源）；没有提供时退回不带编号的占位符。
4. 提供方那一层再遮一次（纵深防御，不带编号）：`exa-public-search.ts`、`deepseek-web-provider.ts` 的搜索词和网址。因为遮过的内容再遮不变，正常情况下这一步是空操作。带签名的网址被遮后读不到，提供方会如实返回失败。
5. TypeSafe（`typesafe-jev-transport.ts`）：请求体里的 `state` 逐个字符串叶子遮一遍再发（问题清单是 Himawari 自己写的固定文字，不遮）；回复不再因为含疑似密钥而拒绝，按解析后的字段处理。决定的合成仍然用遮之前的原始 `envelope`（内部数据）。
6. `scripts/check-egress-redaction.mjs`：
   - 新增 `REQUIRED_EXTERNAL_REDACTION_CALLS`：登记的每个外部出口文件必须调用指定的遮盖函数（Exa、DeepSeek 两个都要，TypeSafe 要文字那个），缺了 `npm run check` 失败；每个登记的外部出口文件都必须在这张表里写明。
   - `SENSITIVE_GATE_CALLS` 删掉 Exa、DeepSeek、TypeSafe、`production-coding-workflow.ts` 四行（这些整段拦下已经去掉）。
   - `REDACTOR_ONLY_FILES` 加 `packages/sensitive-capture/src/external.ts`（它直接调用 `redactForEgress`）。
7. 删除了 `typesafe-jev-transport.ts` 和它的测试文件里原有的注释（项目规则：编辑过的文件不留注释）；测试里一个空的 `pull()` 改成返回永不完成的 Promise，行为相同（流一直不来数据，等传输层超时）。

## 测试

- 新增测试名字带 `[mask-not-block]`，以及 `packages/sensitive-capture/test/external.unit.test.ts`、`test/tooling/egress-redaction-check.test.mjs` 的两条新用例。
- 抓真实发出去的字节：DeepSeek 的 HTTP 请求体、Exa 的 MCP `callTool` 参数、TypeSafe 的 HTTP 请求体、服务进程内搜索收到的参数、沙箱程序的保存输入。带密钥的被遮，不带的原样；同一内容两次发出的字节相同；两个不同密码的搜索不共用缓存，同一个密码的第二次搜索命中缓存。
- 反向验证：把 8 个源文件换回 `origin/main`，新测试 10 条失败（另 2 条是“普通内容原样”的用例，旧代码也通过）；换回新代码全部通过。

## 请重点看

- 必答问题 1：这个 PR 不改发给大语言模型的请求。模型历史里的工具调用参数是模型自己写的原文，存储和发送都没变（发送时照旧由 `ModelEgress` 遮）。遮好的查询词只进外部请求、缓存键和沙箱程序的输入，不写回历史。读网页成功时工具结果里的 `url` 字段会是遮后的网址，这只出现在新产生的工具结果里。以前含密钥的搜索根本不会执行，所以已有历史里没有这类工具结果。
- `externalTag` 取密钥失败时，`executeProductionCodingRequest` 会抛错。生产上同一把密钥是每次聊天请求都要用的，取不到时聊天本身已经失败；请判断这样处理是否可以接受。
- 网址遮盖的边界：片段（`#` 之后）里的内容只按文字规则遮，不按参数名遮；没有 `=` 的参数不处理；参数名和值本身含 `&` 的写法按原样切分。
