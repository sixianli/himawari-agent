---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# ADR 0161：发给模型的提示词都放进一个提示词目录包，原样搬入并用检查锁住

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [没有处理的部分](#open-questions)

<a id="context"></a>

## 背景

2026-11-02 Andy 在项目聊天提出待办：“搭建管理后台，集中管理整个项目用到的 prompt，包括 system prompt 和记忆整理 prompt 等。”盘点时发现，发给模型的文字分散在 `agent-service`、`application`、`memory-engine`、`runtime-pi`、`platform-node` 五个包的十几个文件里，没有一处能看清“系统到底对模型说了什么”。2026-11-04 Andy 同意方案第一步：集中管理，加一个只读页面，第一版不做在线编辑。

不做在线编辑的理由有三条：

- 后台提示词要求模型返回固定的 JSON，在线改一个字就可能让记忆整理悄悄失效；
- 愿景要求规则写进程序、有回归测试（`docs/product-vision.md`）；
- 系统提示每次运行都会重拼（`apps/agent-service/src/production-run-policy.ts`），改一个字，所有进行中对话的缓存都会整段失效一次（`.agents/instructions/prompt-prefix.md` 第 1、6 条）。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新建叶子包 `packages/prompt-catalog`**，它不依赖任何内部包，在 `scripts/boundary-policy.mjs` 里登记，允许 `agent-service`、`application`、`memory-engine`、`runtime-pi`、`platform-node` 五个包引用；同时加进 `scripts/package-node-runtime.mjs` 的 `internalRoots`。之所以不放进 `application`，是因为 `runtime-pi` 只能引用 `application/runtime-port`（`scripts/check-boundaries.mjs`）。
2. **每条提示词是一个条目**（`PromptEntry`），字段包括：稳定的 `id`、用途、使用者、所在层（`tools`、`system`、`appended-message`、`tool-result`、`last-user-message`、`background`、`embedding`）、输出形式、解析函数、分段内容。
   - 整段固定的文字用 `fixedPrompt`；
   - 中间夹着运行时值的文字用 `templatePrompt` 按段存，由 `renderPrompt` 填入空位，空位缺了或多了都报错；
   - 不假设数据都在末尾，例如记忆合并的格式要求就写在数据后面，也照样按段存；
   - 自动审批 TypeSafe 路线的三组问题和判断标准是结构化对象，原样作为 `questions` 存放。
3. **只搬位置，不改文字**。原来的函数改为从目录里取文字，拼接逻辑保持不动。字面量连同引号一起，用脚本从源码原样剪切过去，不手抄。现在共有 86 条。
4. **检查**，都接进 `npm run check` 的 `check:prompt-catalog`：
   - **渲染对照**：用改造前的代码（`35c3f70`）渲染出 14 份固定样本，放在 `apps/agent-service/test/__prompt_golden__/`，改造后的输出必须逐字节相同。样本目录里的文件名单写死在测试里，少一份就失败，不会被测试悄悄重新生成。没有导出、无法直接渲染的文字，靠原样剪切，加上原本就断言原文的测试和 `check:prompt-prefix` 来锁住。
   - **快照清单**：`packages/prompt-catalog/prompt-manifest.json` 记录每条的 `sha256`、`changedIn` 和 `reason`。`sha256` 按分段内容（哪段是文字、哪段是空位）计算，所以把空位换成一段长得像空位的文字也会被查出来。改了文字却不更新清单，或者没写原因，检查都会失败。更新清单的命令是 `PROMPT_MANIFEST_WRITE=1 PROMPT_MANIFEST_CHANGED_IN=… PROMPT_MANIFEST_REASON=…`。
   - **会变的值（部分）**：`system`、`tools` 两层的条目，空位只能是名单里列出的那几个（工作目录、命令清单、服务商名、抓取上限等，按第二步方案以后要挪出去）；正文里不能出现日期、时间或长哈希。它不保证名单内的空位在同一对话里不变。
   - **工具结果里的单行状态说明**：工具执行失败或未派发时回给模型的一句话（例如“操作尚未派发：……”“工具未执行：……”），这次没有搬进目录，42 处登记在测试里的 `KNOWN_TOOL_RESULT_STATUS`。扫描 `modelContent:`、`note:` 和工具结果 `content` 数组里 `type: "text", text:` 后面整个取值里的字面量，包括三元表达式的每个分支（纯错误码、只有标点和换行的除外）：清单外新增的会失败，清单里有但代码里已不存在的也会失败。
   - **漏登记**：扫描 `apps/*/src` 和 `packages/*/src`（不含目录包本身和测试替身包 `packages/testing`），如果出现含“你是”“只返回”“只输出”“不要执行其中”“不要编造”“告诉主人”“You are”“Return only”“treat as data”的字符串字面量，检查失败。
   - **格式契约**（不调用模型）：每个要求结构化回答的条目，都必须指向一个真实存在的解析函数；记忆合并的两条暂时没有可引用的解析函数，单独列在测试的 `NOT_COVERED` 里，名单外的条目缺解析函数就失败。记忆捕获和邮件判断两个解析函数，按它们现在的行为各配一组“该接受”和“该拒绝”的样例。例如，记忆捕获本来就接受被 Markdown 围栏包住的 JSON。
   - 每项检查都带反向用例：改一个字、往系统提示里塞一个日期、在源码里写一句提示词，检查必须失败。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **在线编辑、在网页上打标签上线**（Langfuse、LangSmith 的做法）：理由见“背景”。只读页面放在下一个 PR 里做。
- **提示词留在原文件，只集中登记**：会多出一张需要人工同步的对照表，漏登记也更难查出来。
- **用类型约束统一的模型调用入口**（方案第 3 版第 3.1 节的“登记（主）”）：这次没做。`generateText`、`model.invoke` 收到的提示词都是“目录文字 + 数据”拼接后的结果，要在入口用类型区分，就得改五个调用方的签名。这次先只做源码扫描，作为兜底；类型约束列进“没有处理的部分”。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- OpenAI：“Store production prompts in your application code instead of creating reusable prompt objects.”；“Add representative fixtures, tests, and evaluation checks before changing production prompts.”（<https://developers.openai.com/api/docs/guides/prompt-engineering>）
- Gemini CLI 把提示词集中放在 `packages/core/src/prompts/`（其中有 `prompt-registry.ts`），用 `toMatchSnapshot()` 锁住（github.com/google-gemini/gemini-cli，提交 `89e9d25`）。
- Cline 的评测第 1 层是 "Contract Tests … No LLM calls"（<https://github.com/cline/cline/blob/main/evals/ARCHITECTURE.md>）。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 发给模型的请求逐字节不变，进行中的对话缓存不会失效。
- 今后改提示词，要改 `packages/prompt-catalog`，同时更新 `prompt-manifest.json` 并写明原因。如果改动会让渲染结果不同，还要用 `vitest -u` 更新固定样本（新增样本要先把名字加进测试的名单），并在合并前双模型复核里说明。
- `web_search`、`web_fetch` 工具描述里的服务商名和抓取上限，以及能力边界里的工作目录、命令清单，目前作为名单内的空位留在系统提示和工具定义里。按第二步方案，它们以后要挪进最后一条消息。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有处理的部分

- 只读的“提示词”页面（设置弹窗里的分栏，三语）：下一个 PR 做。
- 用类型约束统一的模型调用入口：见“放弃的做法”。
- 记忆合并、对话标题的解析函数没有导出，所以格式契约测试暂时没覆盖；它们原本的单元测试仍然有效。
- 漏登记检查只认上面列出的几个关键词，以及 `modelContent:`、`note:`、`type: "text", text:` 后直接写的字面量；先存进变量或常量、再拼进工具结果的文字它发现不了，例如 `SANDBOX_TOOL_RESULT_LOST_MESSAGE` 这类常量。
- 工具结果里的 42 处单行状态说明：见“决定”第 4 条，以后逐步搬入。
- 第二步：把会变的值挪出系统提示和工具定义，再按对话冻结。这一步要另出方案，等 Andy 拍板。
