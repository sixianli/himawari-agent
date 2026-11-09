你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 a4f01e6b2045b10068385c21fd6df59ac9c46510。
待审核的方案：
Andy 对这一轮的要求：请务必上网查业界最佳实践（例如 ChatGPT、Claude、Gemini 的记忆功能官方文档，Mem0、Letta、Zep/Graphiti、LangMem 等开源项目的文档或源码，相关论文），只认一手来源并附网址。逐节对照本方案：哪里和最佳实践一致、哪里不一致、哪里有更好的做法。重点问题：(1) 敏感档记忆让模型看到时，业界怎样平衡“尽量给模型”和隐私；(2) 旧记忆是否应该归档或衰减，衰减应该影响排序还是可见性；(3) 给模型的记忆是否该带日期、什么格式；(4) 后台无人值守任务读敏感记忆的做法。最后给出你认为的最佳方案。

# 整体方案（第 2.1 版，供第 2 轮审核）：存入记忆的内容必须能被模型看到

日期：2026-11-09。状态：方案，等 Andy 拍板，未写代码。第 1 版已请 DeepSeek 和 GLM（OpenCode 上的两个低价模型）审核，本版吸收了成立的意见。本题目前共花 0.13 美元。

## 一句话结论

现在的 sensitive（敏感）档记忆，模型在 10 个地方都碰不到：检索、自动带入、档案、置顶、整理、Gmail 检查等。方案是把“记忆能读到哪一档”写成程序里的一条固定规则，所有通道都改成能读到 sensitive，并加回归测试。密码、证件号、卡号这类值，模型看到的仍是占位符，显示给你时还原。分两期做：第一期让有效的记忆全部能被看到，第二期取消“闲置归档”，旧记忆只是排序靠后，不再让模型找不到。

## 一、前提（来源和原话）

1. 分级四档：`packages/gateway-contracts/src/contracts.ts:17`，`DATA_CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"]`。
2. restricted（最高档）的记忆候选直接丢弃，不存：`packages/application/src/services/automatic-memory-service.ts:133`。所以记忆库里只有 public、private、sensitive 三档。
3. 记忆整理提示词把健康、财务、证件号、卡号、密码、密钥等标为 sensitive：`packages/prompt-catalog/src/memory.ts:16`。
4. 聊天里你打的字、附件、图片一律按 private 保存，所以聊天运行的分级是 private：`apps/control-center/src/thread-control-center.tsx:1026,1869-1870`。
5. 把 sensitive 挡在模型外的地方（逐个读过代码）：
   - 全文检索词：`packages/memory-engine/src/hybrid-memory-provider.ts:18`（只收 public、private）；数据库写入时再挡一次：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:146`，用在 `:799`（实体）、`:1010`（检索词）、`:1249`（情景摘要检索词）。
   - 向量：`hybrid-memory-provider.ts:96-97`；生产配置模板里嵌入模型只允许 public、private：`production-shape-config-template.json:104-107`。
   - recall（模型主动查记忆的工具）：只取不高于运行分级的 `apps/agent-service/src/production-memory-recall.ts:160-163`，且只取有效的 `:213-215`。
   - 自动带入的记忆：`apps/agent-service/src/production-run-memory.ts:357-363`；上下文拼装再按 `min(运行分级, maxMemoryClassification)` 过滤：`packages/application/src/services/context-formation-service.ts:279-286`；配置模板 `maxMemoryClassification: "private"`（模板第 16 行）。
   - 主人档案和日程：`packages/application/src/services/owner-profile-service.ts:17`、`:149-151`（上限压到 private）、`:265`；档案块分级只在 private 和 public 之间算：`:328-332`。
   - 置顶：`apps/agent-service/src/production-memory-control.ts:904-907`（非 public、private 报 `MEMORY_NOT_PINNABLE`）。
   - 每日整理：`packages/memory-engine/src/consolidation.ts:35,252`；情景摘要：`packages/memory-engine/src/episodes.ts:19,236`；Gmail 主动检查：`apps/agent-service/src/production-proactive-memory.ts:51`。
6. `maxMemoryClassification` 不只管记忆，还管历史消息和摘要：高于它的历史被丢掉，报 `RUNTIME_HISTORY_CLASSIFICATION_DENIED`：`context-formation-service.ts:145-197`。（审核指出，我核对过。）
7. 已归档的记忆（整理合并掉的重复、长期不用的）：归档时删掉索引行 `sqlite-memory-operations.ts:653-660`；索引范围要求 `status='active'`，`includeHistory` 只放宽有效期 `:240-244`；补索引只扫有效记忆 `:1446-1478`；recall 只要 active `production-memory-recall.ts:213-215`。（第 1 版只写了后两处，审核补全。）
8. 嵌入请求和聊天请求都经过出口遮盖：`packages/application/src/services/model-egress.ts:267,492-503`；ADR 0183。
9. 机器密钥占位符 `[密钥]` 没有编号、无法还原：`packages/sensitive-capture/src/redaction.ts:70`；提示词图例却说它会还原：`packages/prompt-catalog/src/chat.ts:255,267`。
10. 自动判分级：取模型标签、文字检测、来源分级三者最高 `production-memory-capture.ts:329-338`；18 位证件号、16-19 位数字、密码、验证码、机器密钥自动升到 sensitive：`identifiers.ts:3-27`。
11. 分级写在加密的附加校验数据里，改分级要重新加密：`packages/platform-node/src/payload-protector.ts:193-200`。
12. 工具授权有分级上限：`sqlite-capability-invocation-operations.ts:1605-1607,1721`。
13. 老对话用遮盖规则集 1，宽松写法的密码（如“Wi-Fi 密码 abc12345”）不会被遮：`packages/runtime-pi/src/pi-runtime-adapter.ts:1567`、ADR 0188。
14. 文档冲突：ADR 0185 后果一节“存下来的密码在记忆页能看到，但模型在对话里检索不到它”；设计规格 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:67,70,112,162`；ADR 0112（置顶）、ADR 0158（Gmail 带记忆）。PRD v0.2 第 136-139 行要求敏感记忆逐项批准后入库，管的是“存不存”，不冲突。
15. 产品愿景 v2.2 起，你定的规则要写进程序并有回归测试：`AGENTS.md`“产品愿景”一节。
16. 发给模型的内容只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条。

## 二、第一期：有效的记忆全部能被看到

### 1. 一条写进程序的规则

- 新增一个导出函数“记忆可读到的最高分级”，固定返回 sensitive。recall、自动带入、档案、日程、置顶、整理、情景摘要、Gmail 检查全部调用它，不再各自写名单。
- `maxMemoryClassification` 拆开：它对记忆不再起作用，只继续管历史消息和摘要（前提 6）。配置里它低于 sensitive 时只写一行日志，不拒绝启动（有的组件用 public，拒绝启动会把它们一起停掉）。运维手册对应一行同步改。
- 聊天运行的分级仍是 private，不改（理由见第四节）。

### 2. 索引：全部记忆进检索，检索词用遮盖后的文字

- 检索词、实体、向量都不再按分级排除；建索引前先遮盖，密码、证件号、卡号、验证码、密钥的值不进本地索引，语境词（“家里”“Wi-Fi”“密码”）进。
- 嵌入模型允许名单加 sensitive（生产配置，随上线改）。
- 一次性重建索引：现有全部记忆（包括以前是 public、private 但正文里带了凭证的）按遮盖后的文字重建检索词和实体。第 1 版只想靠“补索引”自动补，审核指出它只补缺向量的，覆盖不了实体和旧的明文检索词，所以改成显式重建一次。不改表结构。

### 3. 档案、置顶

- 档案块可选入 sensitive 记忆；档案块的分级改成取所含记忆的最高分级（否则含健康内容的档案块被标成 public，推送、日志会按 public 处理）。
- 置顶允许 sensitive。审核指出：置顶的记忆每轮都带，sensitive 置顶会让健康内容每轮都发出去，这和“不相关的问题不带出 sensitive 记忆”冲突。这一点交给你定（见第四节 b）。

### 4. 派生内容的分级跟着来源走

- 用 sensitive 记忆生成的摘要、整理结果、工具结果，分级取来源中最高的，不因进了 private 运行就被标低。
- restricted 仍不进情景摘要。

### 5. 凭证：模型看到占位符

- 密码、证件号、卡号沿用出口遮盖：模型看到 `[密码#xxxxxxxx]`，回答里写占位符，显示给你时还原。
- 改正提示词图例里“`[密钥]` 也会还原”的错误说法。这会改系统提示文字，按规则只对新对话生效；要补一个逐字节测试并更新提示词金样（固定的比对样本）。
- 老对话（规则集 1）：recall 时先用当前的检测规则判断记忆里有没有凭证，有就先不返回给规则集 1 的对话，直到老对话升级到规则集 2（另一张卡的选项 B）。这样不需要在 recall 里提前遮盖，不会出现同一段文字被遮两次、占位符错乱。

### 6. 硬门槛

- 第 1 版想用“扫代码里有没有只含 public、private 的名单”的静态检查，审核指出它容易误报漏报。改成：
  - 每个通道一个行为测试 `[RULE-memory-visible]`：存一条健康类 sensitive 记忆和一条密码类记忆，分别验证 recall 能找到、自动带入能带上、档案和整理能处理；抓到的模型请求体里健康原文在、密码只有占位符；你看到的回复里密码是原值。
  - 读取上限只来自那个导出函数；四处现有的写死名单（前提 5 的 `:18`、`:146`、`PROFILE_CLASSIFICATIONS`、置顶检查）改成调用它，并在测试里断言它们和函数一致。
  - 反向：把任一通道改回只取 public、private，对应测试必须失败。

### 7. 让模型分得清记忆的新旧（2026-11-09 加）

- 现状：recall 结果带 `recordedAt`、`validFrom`/`validTo`、`current`、`correctedLater`（`apps/agent-service/src/production-memory-recall.ts:224-233`）；自动带入的记忆只有标记和正文（`packages/runtime-pi/src/runtime-environment-block.ts:30-42`、`pi-runtime-adapter.ts:619-620`）；档案只有正文（`owner-profile-service.ts:297`）。模型在后两处分不出新旧。
- 做法：自动带入和档案里每条记忆前加记下的日期，有生效时间段的写时间段（例如“[2021-03 至 2024-08] 住在大阪”）。不加“上次用到的时间”。
- 业界：Zep 给模型的上下文里每条事实都带有效日期区间，“# format: FACT (Date range: from - to)”，仍成立的写“present”（https://help.getzep.com/retrieving-memory）。
- KV 缓存：这些资料本来就在最后一条消息里；同一条记忆的日期固定，字节确定。
- 验收：存“2021 年住大阪”和“现在住东京”，问“我现在住哪”答东京、问“以前住哪”答大阪；反向：去掉日期后请求体断言失败。

## 三、第二期：取消“闲置归档”（2026-11-09 按 Andy 的意见改）

Andy 问：人几十年前的记忆是归档的吗？不是，是变淡了，有人一提还能想起来。现在的归档却让模型彻底找不到，所以改成从源头不再这样归档：

- 每日整理里有两种归档（`packages/memory-engine/src/consolidation.ts`）。合并重复（`:350-352`）：内容已在留下的那条里，保留。闲置归档 `#decay`（`:427-439`，重要度低于 400、从没被用过、180 天没动过）：取消。
- 琐碎的旧记忆保持有效，在检索排序里按闲置时间往后排（“变淡”），相关的问题照样能找到。
- 生产里已经因闲置被归档的记忆，一次性恢复成有效，并补建索引。
- 被新说法取代的旧事实不归档，只标结束时间（`#supersede`，`:441` 起），recall 的 `includeHistory` 已能查到。
- 这样不再需要改“归档时删索引”等五处，可以并入第一期一起做。

业界做法（一手来源）：都是“分层、退到后台但查得到”，没有一家自动让记忆变成查不到。

- ChatGPT：不重要的记忆按时间远近和出现频率移到后台，“unless you delete them, saved memories are always considered”（https://help.openai.com/en/articles/8590148-memory-faq ，直接抓取被 403，原话来自搜索结果摘要）。
- Letta：归档记忆“must be queried on-demand via tools”，没有自动删除（https://docs.letta.com/v1-sdk/memory/archival-memory/ ）。
- Zep：矛盾的旧事实标失效时间、不删除（https://arxiv.org/abs/2501.13956 ）。
- Generative Agents：记忆全留，检索按相关度、重要度、自上次使用起的时间衰减打分（https://arxiv.org/abs/2304.03442 ）。
- 反例 Mem0：矛盾时直接 DELETE 旧记忆（https://arxiv.org/abs/2504.19413 ），不采用。

动工前核对：现在的检索打分有没有用到时间和使用次数（未核实）。

## 四、取舍：采纳和不采纳的审核意见

| 审核意见 | 来源 | 处理 |
| --- | --- | --- |
| 已归档可见涉及 5 处，不止 2 处 | 两个模型 | 采纳；后按 Andy 意见改为取消闲置归档（第三节） |
| 档案块分级要取内容最高级 | 两个模型 | 采纳 |
| sensitive 内容进 private 运行等于“洗白”分级，应让载体标 sensitive | DeepSeek | 部分采纳：派生内容按来源取最高（第二节 4），运行本身不升级 |
| 运行升到 sensitive 会被工具授权上限挡住 | GLM | 采纳，运行保持 private |
| `maxMemoryClassification` 还管历史，不能直接废掉，也不能拒绝启动 | 两个模型 | 采纳，拆开语义 |
| 规则集 1 不能在 recall 里提前遮 | DeepSeek | 采纳，改为先不返回含凭证的记忆 |
| 静态检查换成行为测试 | 两个模型 | 采纳 |
| 需要一次性重建索引，含实体和旧记忆里的凭证 | DeepSeek | 采纳 |
| 后台无人值守的发送要单独授权 | 两个模型 | 交给你定（下面 a） |
| sensitive 置顶会每轮发出 | DeepSeek | 交给你定（下面 b） |
| 每日复盘是否也藏了 sensitive、嵌入模型身份哈希 | DeepSeek | 动工前核对，不影响方向 |

## 五、要你拍板的几项

- a. 后台任务带 sensitive：每日整理、Gmail 检查、情景摘要是没人看着时自动发给模型的。推荐：允许，凭证照样遮。不允许的话，sensitive 记忆会越积越乱（整理不到）。
- b. sensitive 记忆能不能进每轮都带的档案和置顶：推荐不进自动档案，但允许你手动置顶（你主动点的，算你同意每轮都发）。
- c. 是否把模型路由限制到不保留数据的服务方：健康、财务记忆会发给 Vercel 上的 DeepSeek 和 Qwen，你在聊天里直接说的同类内容本来就这样发。推荐：这次不限制，另开题目。
- d. 老对话含凭证记忆：依赖另一张卡（老对话的新消息用新遮盖规则）选 B。选 A 的话，这些记忆在老对话里一直拿不到，新对话不受影响。

## 六、不做的事

- 不把 sensitive 改标成 private：要对老记忆重新加密（前提 11），锁屏推送还会显示健康正文（`production-web-push.ts:486-498`）。
- 不新增工具或工具参数：会让每个对话换新一次。
- 不改存入前的批准（PRD 第 136-139 行）。
- 不改产品愿景正文（只有你能改）；你愿意的话可以把这句话写进愿景。

## 七、文档

新 ADR“存入记忆的内容必须能被模型看到”，修订 ADR 0185 后果一节、ADR 0112、ADR 0158、设计规格第 67、70、112、162 行。

## 八、验收

1. 健康类 sensitive 记忆：新对话里问相关问题，recall 命中并用上（Hermes 真实走一遍）。
2. 密码类记忆：请求体里只有占位符，你看到原值；本地检索词里没有密码值。
3. 反向：不相关的问题不带出 sensitive 记忆；restricted 候选仍不存；把任一通道改回只取 public、private，对应测试失败。
4. `check:prompt-prefix` 通过：工具和系统提示不变（图例改动只影响新对话），记忆只出现在最后一条消息和工具结果里。
5. 重建索引只跑一次：重启两次不重复。
