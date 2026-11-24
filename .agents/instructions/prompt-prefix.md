<a id="prompt-prefix"></a>
# 发给模型的内容：怎样最大化 KV 缓存命中

这份规则约束所有会话，包括协调者和云端线程，快速模式和完整模式都适用。凡是组装或修改发给模型的内容，都要先读它。“发给模型的内容”包括系统提示、工具定义、历史、资料块、遮盖和压缩。

KV 缓存，也叫提示缓存（prompt cache），指模型服务方把“请求开头完全相同的部分”缓存起来：下一次请求的开头只要和上一次逐字节相同，这部分就不用重新计算，速度更快，费用通常只有正常价的一成左右（[Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek](https://api-docs.deepseek.com/guides/kv_cache)）。匹配是逐字节的：开头任何一处变了，从那里往后全部按全价重算。

每条做法的理由、一手来源和本项目的落实情况，见项目文档 [模型请求的 KV 缓存规范](../../docs/kv-cache-guide.md)；这份规则只写必须遵守的条目。

这份规则的起因是 [I-66](../../docs/incidents-and-gates.md#incidents)：每轮存历史时，上一轮的用户消息被改写了，网页上显示“缓存命中 0%”。相关决定见 [ADR 0149](../../docs/adr/0149-append-only-model-requests.md)（只追加）、[ADR 0164](../../docs/adr/0164-move-changing-values-out-of-the-request-head.md)（把会变的值挪到最后）、[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)（按对话冻结）。

<a id="contents"></a>
## 阅读导航

- [一、请求怎样排](#order)
- [二、已经发出的内容](#append-only)
- [三、同一对话里保持不变的东西](#stable)
- [四、字节必须确定](#deterministic)
- [五、压缩和清理](#compaction)
- [六、后台调用](#side-calls)
- [七、检查和监控](#gate)
- [八、改动前先问自己](#before-you-change)

<a id="order"></a>
## 一、请求怎样排

1. **固定的在前，会变的在后。**顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。越靠前的越不能变，因为前面一处变了，后面全部重算。
2. **每轮都会变的内容只放在最后一条用户消息里。**例如当前时间、本轮选中的记忆、本轮资料、工具状态、运行环境说明。系统提示和工具定义里不得出现会变的值，例如时间、日期、路径、服务商名、额度、版本号、哈希。
3. **要告诉模型新情况时，追加一条消息，不改系统提示。**例如工具循环停止、后台命令结束、运行环境变了，都以追加消息的方式告诉模型。
   - 设备感知到的内容（听到的话、网页、短信、屏幕上的字）只作为 `perception_read` 这一次调用的工具结果追加在末尾。不得把它放进系统提示、工具定义，也不得作为一条更早位置的消息插入。

<a id="rules"></a>
<a id="append-only"></a>
## 二、已经发出的内容

4. **已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。**这包括系统提示、工具定义、历史里的每一条消息（用户的话、回答、工具调用、工具结果）。例外只有六种：第 6 条列出的换新；第 7 条那类只因执行句柄出现的工具，它们出现或消失的那一轮请求开头会变；第 12 条那种有 ADR 依据的、成批的压缩（Pi 在上下文溢出或回答被截断时追加的 `context_edit`，即把失败的那次回答从上下文里拿掉；Pi 的自动重试也会追加它，但 Himawari 关着自动重试，所以它只和压缩一起发生，算在压缩里，见 [ADR 0198](../../docs/adr/0198-upgrade-pi-to-1-5-0.md#decision)），以及第 14 条那种按 [ADR 0285](../../docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md) 做的成批清理旧工具结果；开发用的模型复核经 Magpie 调 CodeBuddy 时，CodeBuddy 以 11128 拒绝某段系统提示后，插件给它加逗号或挪进第一条用户消息再发（[ADR 0178](../../docs/adr/0178-review-model-calls-through-a-local-magpie.md#prompt-prefix-exception)，只影响复核脚本，不影响 Himawari）；[ADR 0193](../../docs/adr/0193-memory-is-visible-to-the-model.md#consequences) 上线后的第一轮，老对话里以前因分级被挡掉的 sensitive 历史消息会出现在历史中间，那个对话的请求开头变一次（Andy 2026-11-09 同意不顾旧聊天记录，只此一次）。
5. **存历史时存实际发出去的那一条。**不得在存之前把它换成别的版本，例如去掉资料块、换回原话、缩短搜索结果。出口遮盖是唯一的例外：历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖。遮盖密钥不变、前面的历史不变时，同一段内容每次遮出的字节相同。

<a id="stable"></a>
## 三、同一对话里保持不变的东西

6. **系统提示和工具按对话冻结**（[ADR 0165](../../docs/adr/0165-freeze-the-request-head-per-conversation.md)）。同一对话一直沿用第一次发出时的字节。只有下面这些情况才换新一次，并且每次都留记录：工具集合变了（工具名，或者去掉说明文字后的参数结构）、冻结的工具找不到了、模型变了、推理强度变了、回答语言变了、数据分类变低了，或者手动执行了 `thread prompt rebuild`。
   - 是否换新只在一轮运行开始时判断，一轮运行中途不换新。
   - 改了提示词文字，**只对新对话生效**。要让老对话也用上，必须手动换新。
7. **工具集合尽量不变。**业界的首选是让工具一直在列表里，不能用的时候由执行端拒绝，而不是把工具删掉或加进来（[Claude Code](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)、[OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)、[Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)）。本项目目前的取舍：工具集合变了就换新一次；只有手里有执行句柄才会出现的工具不冻结，接在冻结工具的后面，并记日志统计它们出现的频率。工具定义在请求最前面，所以这类工具出现或消失的那一轮，冻结工具之后的系统提示和全部历史都要重算一次（ADR 0165 已写明这个代价）。要改变这个取舍，先出方案。
   - `device_action`、`perception_read` 两个工具的定义是提示词目录里的固定文字，不随有没有配对设备、设备支持哪些动作而变；现在能做什么，由 `device_action` 的 `describe` 结果告诉模型。给设备加动作不得改这两个工具的定义。
8. **同一对话中途不换模型、不换推理强度，其他请求参数也保持稳定。**每个模型的缓存是分开的，推理强度在多数模型上也会影响缓存；`tool_choice` 变了、提示里图片的有无变了，同样会让缓存失效（Anthropic 原话：“Changes to `tool_choice` or the presence/absence of images anywhere in the prompt invalidate the cache”）。确实要换的话，在对话开头换，或者用单独的辅助调用来做。
9. **同一对话的请求送到同一个服务方。**缓存存在各服务方自己的机器上，换一家服务方就要整段重算。路由要按对话保持同一个去向：Magpie 走会话亲和（同一会话尽量送到同一处），Vercel AI Gateway 一类按配置的服务方顺序；服务方支持缓存路由键的（例如 OpenAI 的 `prompt_cache_key`），按对话传一个固定的键。本项目目前没有传缓存路由键。

<a id="deterministic"></a>
## 四、字节必须确定

10. **同样的内容，每次都要序列化成同样的字节。**JSON 的键顺序、工具的顺序、列表的顺序（命令清单、服务商、记忆）都要固定，不能依赖对象遍历顺序或数据库返回顺序。
11. **遮盖敏感信息必须是确定的。**一条消息遮成什么样，只能取决于它自己和它前面的内容，不能取决于它后面的内容；所以已经发过的历史，不会因为后来的消息被遮成别的样子。
    - Himawari 自己写的固定文字（提示词目录 `packages/prompt-catalog` 里不少于 24 个字符（按 Unicode 字符计）的文字片段，清单在一个构建内固定）不检查，里面的“验证码”这类关键词也不算数；外来内容照常检查，彼此之间的距离按原文计算，不因为中间隔着固定文字而改变；如果有规则会碰到固定文字（例如“密码：”后面紧跟固定文字），这一段按修复前的方式整段检查；输入和前面记下的点名值里合起来已经出现全部 34 个候选填充字符（U+FFFF、U+FFFE、U+FDD0 到 U+FDEF）时也这样。除了这两种退回的情况，固定文字里即使出现主人点名的值也不遮：这段文字是 Himawari 自己写的，不是主人的秘密（[I-78](../../docs/incidents-and-gates.md#incidents)）。所以遮法还取决于这份清单：以后改了提示词文字，老对话里冻结的旧文字不再在清单里，按外来内容检查；旧文字里如果有会被认成敏感信息的数字，那个对话的请求开头会变一次。改提示词文字时要留意这一点。
    - 例外：出口遮盖认出的密码或验证码（例如“482910 是验证码”），值满 6 个字符时会被记下：点名的那条消息里，这个值每次单独出现（前后不紧挨字母、数字、汉字或下划线）都遮掉，包括排在主人的话前面的运行环境说明；同一次请求里排在它后面的消息也这样遮。这是为了不漏掉秘密。排在点名消息前面的消息不受影响，所以不改变已发内容的字节；点名的那条消息被压缩掉以后，后面的遮法可能变，但压缩本来就会让缓存整段失效一次。

<a id="compaction"></a>
## 五、压缩和清理

12. **必须缩短历史时，集中做、少做，并在 ADR 里写明。**不得每轮都做。是否值得压缩，要比较压缩前后的**总输入费用**，不能只看命中率：压缩后命中率下降，但输入变少，总费用可能更低。
13. **压缩请求应当沿用原对话的系统提示和工具**，只在末尾追加“请总结”的指令，这样压缩请求本身也能命中缓存（[Claude Code](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)）。
    - 现状（[ADR 0207](../../docs/adr/0207-compaction-request-reuses-conversation-head.md)）：摘要请求用上一次普通请求的系统提示、工具和切点之前的历史，末尾追加总结指令。拆分轮、溢出压缩、对不上或放不进窗口时退回 Pi 默认请求，那时整段历史仍按全价计算。
14. **清理旧的工具结果要成批、少做、能恢复。**一次清理足够多，才值得付一次缓存失效的代价；被清理的内容要能找回（例如保留网址或文件路径）。
    - 现状（[ADR 0285](../../docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md) 第 8 条，`packages/runtime-pi/src/tool-result-clearing.ts`）：在 Pi 的 `context` 钩子里做，只改发给模型的那份，历史里存的仍是原文。上一次请求实际用掉的输入 token 加上之后新增的消息超过清理线时，把“最近 3 次以外、还没清过、工具没声明 `contextRetention: "keep"`”的工具结果一次全换成一行占位（写明编号），合计不到 5000 token 就不清。清理线是压缩线的三分之二（压缩线 15 万时是 10 万），窗口小的模型跟着变低。清了哪些由历史本身逐条重放算出（用最近一条回答记下的用量，加上它之后新增消息的估算），所以同一段历史每次算出同样的字节，不另存记录；清理之后照常只在末尾追加。压缩请求套用同一份清理结果，仍沿用上一次请求的开头。模型用 `tool_result_recall` 按编号取回原文，作为新的工具结果追加在末尾。
    - 阻断检查里带 `[CLEAR-1]` 到 `[CLEAR-5]` 的用例：只在清理那一次请求开头变、之后只追加；取回拿到原文；不到 5000 不清；声明保留的工具不清；清理后压缩请求仍共用开头。

<a id="side-calls"></a>
## 六、后台调用

15. **后台调用也是固定的在前、会变的在后。**整理记忆、判断邮件、起对话标题这类调用，先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值。
16. **需要分叉出去做的辅助计算，尽量沿用父对话的开头。**例如摘要、压缩这类要读整段对话的辅助调用。
17. **并发发出、开头相同的请求，要等第一个请求开始返回，再发后面的。**缓存要等第一个请求的结果开始返回后才可用。

<a id="gate"></a>
## 七、检查和监控

- **阻断检查：**`npm run check:prompt-prefix`（属于 `npm run check` 的一步）。它用真实的 Pi 适配器和真实的出口遮盖，对本机回环服务跑多轮对话：包括工具调用、搜索结果、银行卡号遮盖、附件长文本、每轮变化的记忆和时间、运行环境说明只在变化时发，以及按对话冻结。换新的各种条件、运行中压缩后补发运行环境说明，由 `test/integration/thread-prompt-bundles.test.ts`、`packages/runtime-pi/test/runtime-environment-block.unit.test.ts` 和 `packages/runtime-pi/test/pi-runtime-adapter.compat.test.ts` 覆盖，它们不在这一步里。每次都检查后一次请求是否以前一次请求开头：`messages` 逐字节比，其他字段按值比（`max_tokens` 除外）。它还带反向用例：改写历史里的用户消息、让系统提示带上每轮变化的值、关掉冻结、请求中间出现 system 消息，检查都必须报告失败。另有几条用例：模型持续返回 503 时，请求层按 [ADR 0245](../../docs/adr/0245-retry-rate-limited-model-requests-at-the-request-layer.md) 只重发字节完全相同的请求（最多 2 次），历史里没有 `context_edit`，下一轮请求仍以第一轮请求开头（Himawari 关着 Pi 的自动重试；改设置把它打开，这条用例会失败，[ADR 0198](../../docs/adr/0198-upgrade-pi-to-1-5-0.md#decision) 实施时手动验证过，没有提交成自动用例）；冻结的工具名和 Pi 能执行的工具名不一致时，一次请求都不发。测试在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts`，名字带 `[I-66]`。同一个文件里带 `[iOS-5]` 的四条用例直接看请求的结构：感知内容只出现在最后追加的那条工具结果里；把它放进系统提示、放进工具定义、插到更早的位置或换成别的角色，检查都必须报告失败。
- **端到端：**`test/integration/production-http-composition-process.test.ts` 里的 `[PR-A]`、`[PR-B]` 用例，用真实服务和 SQLite，并在测试自建的 HTTPS 模型桩里收齐字节后抓取原始请求体来比对。
- **生产监控：**
  - 对话的后续轮次请求（输入至少 1024 个 token、上游报告了缓存用量）命中率低于 50% 时，服务日志写一行 `cache.follow_up_low_hit`（阈值和命中率判断见 `packages/application/src/ports/model-usage.ts`，是否后续轮次见 `apps/agent-service/src/cache-hit-monitor.ts`）。不到 1024 个 token 的请求多数服务方本来就不缓存，不算异常。
  - `node scripts/operations/cache-hit-report.mjs <product.sqlite> --by turn` 按“第 1 轮 / 第 2 轮及以后”“首次请求 / 同轮后续”分开给出命中率。
  - 命中率要当作可用性指标来看，掉下来要查原因。排查时先排除这几种：缓存过期（两次请求隔了太久）、按规则换新、换了服务方、遮盖密钥轮换（同一段文字遮成的字节变了）。

<a id="before-you-change"></a>
## 八、改动前先问自己

- 这个改动会不会让模型已经见过的请求开头变化？会，就停下来出方案，Andy 同意才动工。
- 我加的值每轮都一样吗？不一样，它只能放在最后一条消息里。
- 我是不是在存历史之前处理了消息？处理后的结果必须和发出去的完全一样。
- 我加进去的列表或 JSON，顺序是不是固定的？
- 这个改动会不会让同一对话换模型、换服务方，或者增删工具？

[↑ 回到阅读导航](#contents)
