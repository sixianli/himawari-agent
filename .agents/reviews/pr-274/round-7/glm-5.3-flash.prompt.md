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
仓库就是当前目录，已检出 316eaf2b494274a230b2aa34f5cced3537755077。
对比基准是 7281d9418588413704099711f07174abaa28fc1a，先运行 git diff 7281d9418588413704099711f07174abaa28fc1a..316eaf2b494274a230b2aa34f5cced3537755077 看改动。
作者的说法（可能有错，请核对）：
# 去掉整段拦下 PR2：发往模型的工具结果、网页结果、完整输出、复制和编辑（第 7 轮：完整复核）

这是对整个 PR 相对 main 的一次完整复核。前 6 轮的修改都已在内；之前复核链因线程填错 `--previous` 断开，所以从头复核一次。分支已合入最新 main。

## 背景和目标

Andy 2026-11-06 定的原则：敏感值只在数据发往外部（大语言模型、网页搜索、TypeSafe 等）时遮掉；内部存储和显示一律原文；要求字节原样的操作（复制、编辑）原样放行。以前很多地方是“整段拦下”：工具结果里一出现疑似密钥，整段结果就被换成提示，或者整次读取、复制被拒绝。

这个 PR 只处理发往大语言模型的工具结果、网页结果、完整命令输出，以及复制和编辑。搜索词和网址（发往搜索服务）、TypeSafe、存储和显示、错误码和文档在后面的 PR 里改。

发给模型的每个请求都经过出口遮盖 `packages/application/src/services/model-egress.ts`（`ModelEgress`），它对请求里的每段文字跑 `redactForEgress`（`packages/sensitive-capture/src/redaction.ts`），遮完再用 `assertMachineSecretFree` 自检，还有残留就整次不发。

## 改了什么

1. 去掉这些地方的整段拦下，结果照常交给模型，由出口遮盖遮值（含 NUL 的二进制检查保留）：
   - 读文件：`host-file-read-service.ts`、`host-read-only-executor.ts`、`capability-programs/host-file-read.ts`、`production-host-read.ts`
   - 命令和文件工具结果：`pi-host-publication.ts`（整段换成“疑似密钥”提示的 `withhold` 删掉）、`pi-coding-request.ts`（后台命令输出）、`production-sandbox-services.ts`（恢复的工具结果）、`production-file-preparation.ts`（编辑结果）
   - 网页搜索和读网页结果：`exa-public-search.ts`、`deepseek-web-provider.ts` 去掉结果整批丢弃，删掉不再产生的失败类型 `OUTPUT_REDACTED`（`web-provider-failure.ts`、`ports/web-providers.ts`）
2. 字节原样：复制进工作目录（`workspace-copy-service.ts`）、编辑前读目标文件（`sandboxed-coding-operations.ts`、`production-file-preparation.ts`）不再检查密钥。
3. 完整命令输出（`pi-output-export.ts`）以 base64 放进工具结果，出口遮盖看不到里面。现在合法 UTF-8（含 NUL）一律先用 `redactForEgress` 遮文字再编码，摘要和长度按遮后的字节算，遮过的加 `redacted: true`；非法 UTF-8 按原字节，含机器密钥时只丢掉完整输出（工具结果本身照常）。为此把这个文件加进 `scripts/check-egress-redaction.mjs` 的 `REDACTOR_ONLY_FILES`。
4. 残缺私钥：以前工具结果的拦截还会拦“只有开头一行加正文”或“只有正文加结尾一行”的私钥（例如输出被截断），出口遮盖原来只认完整的 BEGIN…END 块。新增 `redactPrivateKeyFragments`（`machine-secrets.ts`），在 `redactForEgress` 里先于其他机器密钥规则执行：文字里没有 `PRIVATE KEY-----` 就直接返回；先遮完整块，再用 `KEY_HEAD` 遮开头残块（开头之后有 1 个字符正文就遮，最多 120 行），再用 `maskKeyTails` 遮结尾残块（只搜结尾标记本身，从标记往回看一个有限窗口，窗口不越过上一个结尾标记）。认得 diff 行号、`grep -n` 的“文件:行号:”和“文件-行号-”前缀、JSON 转义后的 `\n` 和 `\r\n`；只有标记、没有正文的不遮。
7. 出口遮盖原来跳过整段以 `data:` 开头的文字；现在只跳过形状是 `data:类型/子类型;base64,` 加 base64（`=` 只在末尾）、且认不出机器密钥的真正数据网址。
8. 一行超过整份结果上限、从中间截断（Pi 的 `truncateTail` 置 `lastLinePartial`）时，`model-output-budget.ts` 去掉截断处开头那串类密钥字符。
5. 出口自检拒发时，在“敏感信息拦截记录”里记 `withheld`：这次请求里已经遮过的值和残留的机器密钥都记一条（`ModelEgressSighting.outcome`，记录器按它写结果）。
6. 调用点登记表 `SENSITIVE_GATE_CALLS` 删掉这次改掉的 10 个文件，Exa、DeepSeek 的调用数改成只剩查询词和网址的检查。

## 已核对的事实

- 源代码里没有地方生成 `file`/`input_file`/`document` 类型的块（出口遮盖跳过这三种），附件文字以普通文字发送。
- `MachineSecretRuleId` 是 `EgressRedactionRuleId` 的子集，残缺私钥记为 `private-key-block`。

## 想请你重点看

- 去掉拦截后，有没有哪条路径的文字到模型之前不经过出口遮盖（例如不是 `/chat/completions`、`/responses`、`/messages`、`/embeddings` 的请求，或者被当作 `data:`、文件块跳过）。
- 残缺私钥的正则会不会漏遮常见格式，或者误遮普通文字；会不会有灾难性回溯。
- 遮盖规则多了残缺私钥、数据网址收紧这两处，已经发给模型的历史里如果有残缺私钥，那条消息的字节会变一次。Andy 2026-11-07 已同意这个代价（原话“同意”，针对“对所有发给模型的文字都遮残缺私钥”）。请评估范围有没有超出这个说法。
- 完整输出遮后长度变化、`fitOutput` 放不下时的行为。
