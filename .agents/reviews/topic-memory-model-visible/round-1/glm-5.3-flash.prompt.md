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
你的额外侧重：测试有没有覆盖这次改动、文档和规则与代码是否一致；挑一条最普通的使用流程，从入口走到结束，标出经过的、没有测试覆盖的代码路径。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你走过的流程和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 a5ad7bd0b3ac3330bc5ea2ab6df292128dccff25。
待审核的方案：
# 整体方案（第 1 版，供审核）：存入记忆的内容必须能被模型看到

日期：2026-11-09。状态：方案，未写代码。

## 〇、出发点

Andy 2026-11-09 原话：“存入记忆的内容必须能被模型看到。”此前他说：“如果记忆里面不会被送给模型，那为什么还要记呢？”“这是一个个人的 AI Agent，我想让他发挥最大的能力来辅助我，所以必须尽可能地把数据给到他。”

本方案把这句话当作一条硬规则：凡是已经存进记忆库（状态为有效或已归档）的记忆，模型都必须有一条路能用上它。密码、证件号、银行卡号这类能被出口遮盖的值，模型看到的是占位符（显示给主人时还原），这算“看得到”；但不允许出现“存了、模型完全碰不到”的情况。

## 一、前提（来源和原话）

1. 分级四档：`packages/gateway-contracts/src/contracts.ts:17`（`DATA_CLASSIFICATIONS = ["public", "private", "sensitive", "restricted"]`）。
2. `restricted` 的记忆候选直接丢弃，不存：`packages/application/src/services/automatic-memory-service.ts:133`（`if (candidate.dataClassification === "restricted")` 后 `discard`）。所以记忆库里只会有 public、private、sensitive。
3. 记忆整理提示词把健康、财务、宗教政治、亲密关系、他人私事、精确住址行踪、法律纠纷、证件号、卡号、密码、密钥标 sensitive：`packages/prompt-catalog/src/memory.ts:16`。
4. 聊天里主人打的文字、附件、图片一律按 private 保存：`apps/control-center/src/thread-control-center.tsx:1026,1869-1870`。所以聊天运行的分级是 private。
5. 当前所有把 sensitive 挡在模型外的地方（我逐个读过）：
   - 全文词项：`packages/memory-engine/src/hybrid-memory-provider.ts:18`（`LEXICAL_CLASSIFICATIONS = new Set(["public","private"])`）、`:85`；SQLite 写入再挡一次：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:146`（`INDEXED_ENTITY_CLASSIFICATIONS`）、`:799`、`:1010`、`:1249`。
   - 向量：`hybrid-memory-provider.ts:96`（`this.#embeddable.has(memory.dataClassification)`），名单来自嵌入模型配置 `apps/agent-service/src/production-memory-composition.ts:101`；生产配置模板里嵌入模型只允许 public、private：`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:104-107`。
   - recall 工具：只取不高于运行分级的：`apps/agent-service/src/production-memory-recall.ts:160-163`，并且只取状态为 active 的：`:215`。
   - 自动上下文：`apps/agent-service/src/production-run-memory.ts:357-363`（不高于运行分级）；上下文拼装再按 `min(运行分级, maxMemoryClassification)` 过滤：`packages/application/src/services/context-formation-service.ts:281-288`；模板 `maxMemoryClassification: "private"`（模板第 16 行）。
   - 主人档案块和日程块：`packages/application/src/services/owner-profile-service.ts:17`（`PROFILE_CLASSIFICATIONS`）、`:149-151`（上限再压到 private）、`:265`。
   - 置顶：`apps/agent-service/src/production-memory-control.ts:905`（非 public/private 报 `MEMORY_NOT_PINNABLE`）。
   - 每日整理（合并重复、处理冲突）：`packages/memory-engine/src/consolidation.ts:35,252`（`REVIEWABLE`）。
   - 情景摘要检索：`packages/memory-engine/src/episodes.ts:19,236`（`SUMMARIZABLE`）。
   - Gmail 主动检查带相关记忆：`apps/agent-service/src/production-proactive-memory.ts:51`。
6. 已归档的记忆（每日整理合并掉的重复、长期不用的琐碎记忆，`packages/memory-engine/src/consolidation.ts:352,437`）recall 拿不到（`production-memory-recall.ts:215` 只要 active），补索引也只扫 active（`sqlite-memory-operations.ts:1467-1475` 的 `m.status = 'active'`）。
7. 嵌入请求本来就经过出口遮盖：`packages/application/src/services/model-egress.ts:267,492-503`（`redactEmbeddings`）。聊天请求同样经过出口遮盖（ADR 0183）。
8. 机器密钥的占位符 `[密钥]` 没有编号、无法还原：`packages/sensitive-capture/src/redaction.ts:70`；ADR 0183 原话“`[密钥]` 没有编号、无法还原”。提示词图例却说所有占位符照原样写就会还原，包括 `[密钥]`：`packages/prompt-catalog/src/chat.ts:255,267`。
9. 补索引任务：启动时 `listUnindexed` 选出“没有索引行、修订号变了、或分级在嵌入名单里但还没有向量”的有效记忆重新投影：`sqlite-memory-operations.ts:1446-1478`；调用处 `apps/agent-service/src/service-main.ts:1186`。
10. 文档里与这条原则冲突的说法：ADR 0185 后果一节“所以存下来的密码在记忆页能看到，但模型在对话里检索不到它”；自建记忆引擎设计规格 `docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:67,70,162`（sensitive 以上不进实体、全文索引）；ADR 0112 置顶不允许敏感记忆。PRD v0.2 第 136-139 行要求敏感记忆逐项批准后才入库，这是“存不存”的规则，与“存了能不能看到”不冲突。
11. 只追加的规则：`.claude/rules/prompt-prefix.md` 第 4、6 条；改工具参数结构会让每个对话换新一次（第 6 条）。
12. 产品愿景 v2.2 起，Andy 定的规则要写进程序、每条有回归测试：`AGENTS.md` “产品愿景”一节。
13. 老对话的出口遮盖仍用规则集 1，宽松写法的密码（如“Wi-Fi 密码 abc12345”）不会被遮：`packages/runtime-pi/src/pi-runtime-adapter.ts:1567`、ADR 0188。

## 二、整体做法

### 1. 一条写进程序的规则：记忆的读取上限固定为 sensitive，不再跟运行分级或配置走

- 新建一个常量（例如 `MODEL_READABLE_MEMORY_CLASSIFICATIONS = ["public","private","sensitive"]`），所有记忆读取通道都用它：recall、自动上下文、档案块、日程块、Gmail 主动检查、情景摘要检索、每日整理。
- 上下文拼装里的 `min(运行分级, maxMemoryClassification)` 对记忆条目改成用这个常量；`runPolicy.maxMemoryClassification` 这个配置不再决定记忆能否进上下文（保留字段兼容旧配置，启动校验时若低于 sensitive 只记日志或直接拒绝启动，待审核意见定）。
- 聊天运行的分级仍是 private，不改。sensitive 记忆的内容进入 private 运行，是主人通过这条规则明确授权的“降级使用”，在新 ADR 里写明。理由：如果改成“运行升到 sensitive”，工具授权、工作区授权的分级上限（`sqlite-capability-invocation-operations.ts:1605-1607,1721`）会把正常工具调用挡掉，牵连太大。

### 2. 索引：所有记忆都进全文词项和向量，但词项用遮盖后的文字

- 全文词项和实体表不再按分级排除；改为对每条记忆（不分档）先遮盖再分词：密码、证件号、卡号、验证码、机器密钥的值不进本地索引，语境词进（“家里 / Wi-Fi / 密码”）。遮盖函数放在 `packages/sensitive-capture`，索引端只调这个函数，不直接调 `redactForEgress`（`scripts/check-egress-redaction.mjs` 会拦）。
- 向量：嵌入模型的允许名单加上 sensitive（生产配置变更，随上线做）；嵌入请求本来就经出口遮盖（前提 7），所以凭证值不会离开。
- 健康、财务等话题型记忆的语境词会以分词形式落在本地数据库里（设计规格原本为避免“明文关键词落盘”而排除）。这台机器是 Andy 自己的服务器，记忆正文本来就会在这里解密；接受这个代价，在新 ADR 里写明。
- 补索引：嵌入名单加 sensitive 后，现有 sensitive 记忆因“还没有向量”会被 `listUnindexed` 选中、重新投影一次，之后不再重复（前提 9）。不需要改表结构。

### 3. 已归档的记忆也要能被模型找到

- recall 的 `includeHistory` 参数（已有，不改参数结构）放开后，同时返回已归档和已被更正的记忆，结果里标明“已归档”。自动上下文仍只用有效记忆。
- 补索引和索引保持覆盖已归档记忆（需核对：归档时是否删除索引行）。

### 4. 置顶和档案块

- 允许置顶 sensitive 记忆；档案块按现有重要度规则也可选入 sensitive 记忆（健康、财务类别本来不进自动档案，类别规则不变）。

### 5. 凭证类：模型看到占位符，主人看到原值

- 密码、证件号、卡号：沿用出口遮盖，模型看到 `[密码#xxxxxxxx]`，回答里写占位符，显示时还原。
- 机器密钥：现在是无编号的 `[密钥]`，模型只能知道“有一个密钥”，主人也拿不回值。另做一步：给机器密钥也做带编号、可还原的占位符；在那之前，改正提示词图例里“`[密钥]` 也会还原”的错误说法（只对新对话生效，记入 KV 缓存规范）。
- 老对话（规则集 1）召回含宽松写法密码的记忆时，原值会发给模型。依赖“老对话一次性升级到规则集 2”那个方案（另一张卡，Andy 待选）；在它上线前，recall 对规则集 1 的对话，含凭证的记忆只返回遮盖后的文字。

### 6. 每日整理、Gmail 主动检查、情景摘要

- 每日整理也处理 sensitive 记忆（合并重复、处理冲突），否则 sensitive 记忆会越积越乱。
- Gmail 主动检查可以带上相关的 sensitive 记忆（凭证照样遮盖）。

### 7. 存入前的批准不变

- PRD v0.2 要求敏感记忆逐项批准后入库（第 136-139 行），这是“存不存”的规则，本方案不动。主人明说“记住”的直接存。是否取消这道批准由 Andy 另定。

### 8. 硬门槛（规则写进程序）

- 新增回归测试 `[RULE-memory-visible]`：存一条健康类 sensitive 记忆、一条密码类记忆、一条已归档记忆，分别验证 recall 能找到、自动上下文能带上（有效的）、抓到的模型请求体里健康原文在、密码只有占位符、主人看到的回复里密码是原值。
- 新增静态检查 `check:memory-visible`：扫描记忆读取路径，出现只含 public、private 的分级名单就失败（反向用例：把任一通道改回 `["public","private"]`，检查必须失败）。

### 9. 文档

- 新 ADR：“存入记忆的内容必须能被模型看到”，取代 ADR 0185 后果一节的相关说法，修订 ADR 0112（置顶）、ADR 0158（Gmail 带记忆）、设计规格第 67、70、162 行。
- `docs/product-vision.md` 不改（只有 Andy 能改正文）；如 Andy 愿意，可把这句话作为规则写进愿景。

## 三、不做的事

- 不把 sensitive 改标成 private：改标签要对已加密的老记忆重新加密（分级写在加密的附加校验数据里，`packages/platform-node/src/payload-protector.ts:193-200`），还会让锁屏推送显示健康正文（`apps/agent-service/src/production-web-push.ts:486-498`）。
- 不新增工具或工具参数：会让每个对话换新一次。
- 不改聊天运行的分级。

## 四、对外部服务的代价

健康、财务等内容会发给生产的聊天模型和嵌入模型（Vercel AI Gateway 上的 DeepSeek 和 Qwen）。主人聊天时直接说的同类内容本来就这样发出；新增的是“存下来的记忆”也会被发出。是否同时把模型路由限制到零保留的服务方，由 Andy 另定。

## 五、验收

1. 健康类 sensitive 记忆：新对话里问相关问题，recall 命中，模型回答用上了它（Hermes 真实走一遍）。
2. 密码类记忆：模型请求体里只有占位符，主人看到原值；本地全文词项里没有密码值，有“Wi-Fi”“密码”。
3. 已归档记忆：`includeHistory` 能找到，标明已归档。
4. 反向：restricted 候选仍然不存；不相关的问题不带出 sensitive 记忆（相关度门槛不变）；把任一通道改回只取 public/private，`check:memory-visible` 失败。
5. `check:prompt-prefix` 通过：工具定义和系统提示不变，记忆内容只出现在最后一条消息和工具结果里。
6. 补索引只跑一次：重启两次，不重复投影。

## 六、风险

1. 运行分级是 private，内容却来自 sensitive 记忆：追踪记录、工具结果按 private 标。是否把这些载体按内容升到 sensitive，需要审核判断会不会牵连工具授权。
2. 相关度门槛（0.6）以下的记忆模型仍看不到，这是检索质量，不是分级问题。
3. 老对话规则集 1 的问题（前提 13）。
4. 自动整理时模型漏标分级只影响标签，不再影响能否被看到。
