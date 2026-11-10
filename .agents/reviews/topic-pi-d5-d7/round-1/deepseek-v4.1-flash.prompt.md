你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 4a5ef98aa948f83b73845cb26245ad5b76dfc3f9。
问题、目标和约束：
# 方案材料：Pi 偏离 D5（插消息部分）和 D7（缓存预热）改成官方写法

只给问题、目标、约束和已核对的事实，请各自读代码、查资料出方案。

## 问题一：D5 插消息、接着跑

`packages/runtime-pi/src/pi-runtime-adapter.ts` 绕过 Pi 的会话对象，直接调用底层 Agent：
- 工具循环被判定卡住时插入“工具循环已停止”提示（`appendLoopStopped`）：运行中用 `session.sendCustomMessage(..., { deliverAs: "steer" })`，不在运行中时用 `active.agent.steer({...})`。
- 后台命令完成通知（`subscribeBackground` 回调）：运行中用 `session.sendCustomMessage(..., { deliverAs: "steer" })`，不在运行中返回 false。
- 压缩结束且 `willRetry` 时补发运行环境说明：`session.agent.steer({ role: "custom", ...environment })`。
- 一轮结束后 `#continueForSteeredNotices`：`while (canContinue() && session.agent.hasQueuedMessages()) { await session.agent.continue(); await session.waitForIdle(); }`。
- 审批续跑时 `if (restored) await session.agent.continue();`。
- 工具内部的 `agent.abort()`（`session.abort()` 会等会话空闲，工具里等不到）。

官方写法：`@earendil-works/pi-coding-agent` 的 `docs/extensions.md`（`pi.sendMessage`，deliverAs steer / followUp / nextTurn，triggerTurn）、`docs/sdk.md`（`session.sendCustomMessage`、`session.steer`、`session.followUp`、`session.abort`）。锁定版本 1.5.0 在 `node_modules/@earendil-works/pi-coding-agent`，`dist/core/agent-session.js` 第 1862–1900 行是 `sendCustomMessage` 的实现（运行中 / triggerTurn / 不在运行中三种分支），底层队列在 `node_modules/@earendil-works/pi-agent-core/dist/agent.js`、`agent-loop.js`。最新 1.5.1。

## 问题二：D7 缓存预热

Andy 2026-11-10 定：缓存预热要保留，不能因为 Himawari 统计不到用量就关掉。要求照官方写法接上 Himawari 的预算控制和用量记录。

已核对的事实：
- Pi 只给模型配置里写了 `promptCache`（缓存寿命秒数）的模型预热（`docs/models.md` 第 106 行）；`cacheWarming` 1.5.0 默认 `"streaming"`、1.5.1 默认 `"idle"`（空闲时最多续 30 分钟，`docs/settings.md` 第 21 行）。Himawari 现在没有任何模型写 `promptCache`，所以从不预热。
- 每次预热前 Pi 发 `cache_warming_decision` 事件，扩展可回 `{ action: "warm" }` 或 `{ action: "stop" }`（`docs/extensions.md` 1.5.1 第 912–929 行）。
- 预热时 Pi 用 `this.models.streamSimple(run.model, run.context, { ...run.options, maxTokens: 1, maxRetries: 0 })` 重放上一次请求（1.5.0 `dist/core/cache-warmer.js` 约第 238 行），`run.options` 是 `dist/core/sdk.js` 第 199、269 行存下的那次请求的选项（`...options`）。成功后 `sessionManager.appendUsage("cache_warm", ...)` 并发 `entry_appended` 事件。
- Himawari 替换了 `session.agent.streamFunction`（偏离 D1，另有线程出方案），请求经 `admitPiStream`：准入和预算许可（`permit`）、出口遮盖 `egress.exchange(...).wrapFetch(...)`、Vercel 网关路径的 `observeGatewayFetch`（只允许发一次，再发报 `AI_GATEWAY_MULTIPLE_REQUESTS_FORBIDDEN`，`packages/runtime-pi/src/gateway-observation.ts`）、从主机取密钥、记用量。然后调 Pi 原来的请求函数，所以预热重放会带着这次的 fetch 和密钥，但不经过准入、预算和用量记录。
- Himawari 每次运行（处理一条用户消息）新建 Pi 会话，跑完 `session.dispose()`，会话关了预热就停（`dist/core/agent-session.js` 第 1038–1040 行）。
- 用量表：`packages/application/src/ports/model-usage.ts`（`ModelUsageSource` 只有 `"model-port" | "agent-stream"`，必填 `invocationId`、`purpose`、`source`），持久化 `packages/persistence-sqlite/src/sqlite-model-usage-operations.ts`，迁移 `packages/persistence-sqlite/src/migrations/0068_model_usage_observations.sql` 有 `CHECK`。下一个可用迁移号 0086。`entry_appended` 现在在 `KNOWN_IGNORED_EVENTS` 里被忽略。
- DeepSeek 的缓存自动开启，不用之后“usually within a few hours to a few days”才清掉（https://api-docs.deepseek.com/guides/kv_cache ）。Anthropic、OpenAI 一类缓存默认约 5 分钟。生产经 Magpie 调模型，主力是 DeepSeek，也用 Andy 已付费套餐里的 token。

## 约束

- 发给模型的内容只追加，已经发出的不改（`.claude/rules/prompt-prefix.md`）；`npm run check:prompt-prefix` 必须过。
- 花钱的请求必须过 Himawari 的预算控制（`.claude/rules/owner-standing-rules.md` 的“钱和模型”）。
- 只有 `packages/runtime-pi` 能导入 Pi 包；规范 `docs/pi-development-guide.md`：官方有写法就照官方写。
- 不写代码注释。改表结构要连续迁移号。
- 测试用真实入口，修 bug 先复现；新增行为要有反向用例。

## 要的输出

两个问题各自：推荐做法（具体到文件和接口）、为什么、放弃了什么、风险和要加的测试（含反向用例）、会不会改变模型已经见过的请求开头。D7 另外回答：空闲预热（两次运行之间）值不值得做、怎么做，以及哪些模型该写 `promptCache`。
